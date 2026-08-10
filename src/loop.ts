// loop.ts — the main run loop: load prd, recover, preflight, route, run tasks,
// update status, retry/block, commit per task.

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { type Config } from "./config.js";
import { createElapsedTracker } from "./elapsed.js";
import { t } from "./i18n.js";
import { findTask, readyTasks, type PRD, type Task } from "./prd.js";
import { pathsOutsideScope } from "./prdload.js";
import { log, setReporter } from "./log.js";
import { captureReviewBase, commitPaths, git, headCommit, taskChangedPaths } from "./git.js";
import { advisorPlanKey, invalidatePlan } from "./plan-cache.js";
import { readStandards } from "./prompts.js";
import { runTask, type RunTaskResult } from "./run.js";
import { runVerifyCommand } from "./verify.js";
import { formatCost, mergeCost, type CostTally } from "./stream.js";
import { configureAgents, runMode, startRun, type RunOptions } from "./startrun.js";
import { createTaskRunner, type TaskRunnerCtx } from "./taskrun.js";
import { createTaskWorktree, mergeBackTaskWork, releaseRunLock, removeTaskWorktree, worktreeLoss } from "./worktree.js";
import { emit, type RunEvent } from "./tui/events.js";
import { mount, type TuiHandle } from "./tui/mount.js";

export type { RunOptions };

/**
 * THE prd.json rule, and the only serialization a parallel run needs: every
 * read-modify-write of this file must stay SYNCHRONOUS. runLoop is one process
 * on one thread — N parallel tasks are N child *processes* collected at `await`
 * points — so a reload → mutate → save with no await between them is atomic
 * with respect to the event loop and no mutex can improve on it. Put an `await`
 * in the middle and a task's stale copy silently rolls a sibling's status back.
 * See runOneTask's persist().
 */
function savePRD(path: string, prd: PRD): void {
  writeFileSync(path, JSON.stringify(prd, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runLoop(opts: RunOptions): Promise<void> {
  // Everything that has to be true before the first task runs — config, backlog
  // intake, the resume menu, agent preflight, the workspace hazard check and the
  // dashboard — lives in startRun. It either hands back a runnable setup or
  // exits, so nothing below re-checks any of it.
  const setup = await startRun(opts, savePRD);
  const { prdPath, workspace, progress, prd0, reload, elapsedTracker, trackers, setElapsedPaused } = setup;
  // Destructured as LOCALS on purpose: the config menu replaces all four
  // mid-run, and reading them back off `setup` would leave a stale second copy
  // for the next reader to trip over. runLoop owns them from here.
  let { cfg, mode, exe, adv, tui } = setup;

  // One cell, and the two decisions around it, live in taskrun.ts. This context
  // is the seam: what a task can reach is a named list there instead of a scope
  // to trace. The counters live HERE and not as locals because a cell writes
  // them and done() below reads them — two copies would report zero.
  const ctx: TaskRunnerCtx = {
    opts,
    prdPath,
    workspace,
    progress,
    reload,
    savePRD,
    // lazy on purpose: done() reads the counters off this same object, so it
    // cannot be defined before it
    done: () => done(),
    elapsedTracker,
    trackers,
    pendingReviewFeedback: new Map(),
    // The worktree as it stood when each task STARTED. Two consumers: the review
    // diffs against it, and the commit stages only what moved since it. Keyed by
    // task so a retry still measures from the task own start, not the retry own.
    taskBaselines: new Map(),
    // per task, kept across retries: a task that blocked after three attempts
    // cost all three, and the run report is only honest if it says so
    taskCost: new Map(),
    runCost: { usd: 0, unknown: false },
    // Ceilings fall, never rise: read ONCE, before any task runs. The config
    // menu is reachable mid-run and rewrites ralph.config.json, so a re-read per
    // iteration would let a run raise its own budget from the inside.
    maxCostUsd: Math.max(0, cfg.max_cost_usd ?? 0),
    cfg,
    tui,
    curTaskId: "",
    // The skip flag is consume-once in the controller, but a confirmed skip
    // aborts every executor in the WAVE. Whoever settled first would take the
    // flag and its siblings — killed by that same skip — would be charged a
    // retry. Latched per batch, and reset where nothing is in flight.
    batchSkipped: false,
    accepted: 0, // tasks that reached done THIS run — the denominator
    tasksRun: 0,
  };
  const { runOneTask, pickWave, waveIntegrationHolds } = createTaskRunner(ctx);

  let timeTicker: NodeJS.Timeout | null = null;
  const tickElapsed = (): void => {
    const payload: Pick<RunEvent, "taskId"> &
      Partial<Pick<RunEvent, "globalElapsedMs" | "taskElapsedMs">> =
      elapsedTracker.tick(ctx.curTaskId, tui!.control.isPaused(), performance.now());
    emit(payload);
  };
  const startTimeTicker = (): void => {
    timeTicker = setInterval(tickElapsed, 1000);
  };
  if (tui) {
    setReporter((line) => tui!.update({ taskId: ctx.curTaskId, line, lineSource: "system" }));
    startTimeTicker();
  }

  const done = (): void => {
    if (timeTicker) clearInterval(timeTicker);
    setReporter(null);
    tui?.unmount();
    // FIRST, before the early return below: a run that did nothing still holds
    // the workspace, and leaving the claim behind makes the next run diagnose a
    // stale pid instead of just starting.
    releaseRunLock(workspace);
    // after unmount, so the accounting survives in the terminal instead of
    // scrolling by inside a pane that is about to disappear
    if (ctx.tasksRun === 0) return; // nothing ran: no accounting to report
    log(
      progress,
      ctx.accepted > 0
        ? t("loop.log.runCost", {
            total: formatCost(ctx.runCost),
            n: ctx.accepted,
            per: formatCost({ usd: ctx.runCost.usd / ctx.accepted, unknown: ctx.runCost.unknown }),
          })
        : t("loop.log.runCostNoAccepted", { total: formatCost(ctx.runCost) }),
    );
  };

  while (true) {
    if (tui) setElapsedPaused(tui.control.isPaused());
    const tuiAction = tui ? await tui.waitConfigOrResume() : "resume";
    if (tui) setElapsedPaused(tuiAction === "config" || tui.control.isPaused());
    if (tuiAction === "quit" || tui?.control.shouldQuit()) {
      done();
      log(progress, t("loop.log.quit"));
      return;
    }

    // Money is a run-level ceiling and it is checked BETWEEN waves, never
    // mid-task: killing a task that is already paid for throws the result away
    // and still leaves the bill. Checked at the TOP so every path that loops
    // back — including the review retry/approve ones — passes through it.
    // Logged BEFORE done() so the reason lands in the TUI pane, not only in
    // progress.md. With a wave in flight the ceiling can be overshot by up to
    // max_parallel_tasks tasks; that bound is the price of not killing paid
    // work, and it is documented next to the knob.
    if (ctx.maxCostUsd > 0 && ctx.runCost.usd >= ctx.maxCostUsd) {
      log(progress, t("loop.log.stopBudget", { spent: formatCost(ctx.runCost), max: ctx.maxCostUsd.toFixed(2) }));
      done();
      return;
    }

    if (tuiAction === "config" && tui) {
      setElapsedPaused(true);
      if (timeTicker) clearInterval(timeTicker);
      tui.unmount();
      setReporter(null);
      console.clear();

      cfg = await configureAgents(cfg, prdPath, opts.config, workspace);
      // The cells read config off the ctx, so a swap that updates only the local
      // leaves every task after this menu running the OLD agents. Same for the
      // remount below — this is the price of the two being separate objects, and
      // the reason neither is destructured inside the runner.
      ctx.cfg = cfg;
      mode = runMode(cfg);
      adv = cfg.advisor ? `${cfg.advisor.cli}:${cfg.advisor.model}` : "none";
      exe = `${cfg.executor.cli}:${cfg.executor.model}`;

      const pState = reload() ?? prd0;
      const seed = pState.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
      const header = `${pState.project} — exec: ${exe} | adv: ${adv}`;
      tui = ctx.tui = mount(seed, header, pState.project, true, setElapsedPaused);
      setReporter((line) => tui!.update({ taskId: ctx.curTaskId, line, lineSource: "system" }));
      startTimeTicker();
      continue;
    }

    // Reloaded here and only here, which is exactly "when nothing is in flight":
    // the wave below is fully awaited before the loop comes back around. A
    // reload mid-wave would return a file that predates the siblings' status.
    // Named regression: an executor that rewrites prd.json MID-WAVE now loses
    // that edit at the next settle, where serially it wins.
    const prd = reload();
    if (!prd) {
      done();
      return;
    }
    let batch: Task[];
    if (opts.task) {
      const only = findTask(prd, opts.task);
      if (!only) {
        done();
        console.error(t("loop.err.noTask", { id: opts.task }));
        process.exit(1);
      }
      batch = [only!];
    } else {
      batch = pickWave(prd);
    }

    if (batch.length === 0) {
      const remain = prd.tasks.filter((t) => t.status !== "done").length;
      if (remain === 0) {
        done();
        log(progress, t("loop.log.allDone"));
        return;
      }
      log(progress, t("loop.log.stalled", { n: remain }));
      if (tui) {
        const action = await tui.waitStalled();
        if (action === "quit") {
          done();
          log(progress, t("loop.log.quit"));
          return;
        } else if (action === "retry") {
          log(progress, t("loop.log.manualRetry"));
          let changed = false;
          for (const t of prd.tasks) {
            if (t.status === "blocked") {
              t.status = "todo";
              t.retries = 0;
              invalidatePlan(t);
              changed = true;
              emit({ taskId: t.id, status: "todo" });
            }
          }
          if (changed) savePRD(prdPath, prd);
          continue;
        }
      }
      done();
      return;
    }

    if (opts.dryRun) {
      const review =
        mode === "NATIVE"
          ? t("loop.dry.reviewNative")
          : cfg.advisor && cfg.review_after
            ? t("loop.dry.reviewOn", { n: cfg.max_review_rounds })
            : t("loop.dry.reviewOff");
      console.log(t("loop.dry.next", { id: batch[0].id, title: batch[0].title }));
      console.log(t("loop.dry.mode", { mode, executor: exe, advisor: adv }));
      console.log(t("loop.dry.review", { review }));
      return;
    }

    ctx.batchSkipped = false;
    if (batch.length === 1) {
      if ((await runOneTask(batch[0], prd, true)) === "stop") return;
    } else {
      log(progress, t("loop.log.waveStart", { n: batch.length, ids: batch.map((tk) => tk.id).join(", ") }));
      // allSettled, not all: a throw in one cell must not leave its siblings'
      // rejections unhandled, and every cell has a finally that owes git a
      // worktree removal. The first rejection is then rethrown, so a real bug
      // still fails loudly instead of being swallowed by the wave.
      const settled = await Promise.allSettled(batch.map((tk) => runOneTask(tk, prd, false)));
      const crashed = settled.find((r) => r.status === "rejected");
      if (crashed) throw crashed.reason;
      if (settled.some((r) => r.status === "fulfilled" && r.value === "stop")) return;
      if (!(await waveIntegrationHolds(batch))) return;
    }
    await sleep(1000);
  }
}

