// loop.ts — the main run loop: load prd, recover, preflight, route, run tasks,
// update status, retry/block, commit per task.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { supportsNativeAdvisor } from "./agents.js";
import { anyTaskUsesBrowser, BROWSER_INSTALL_HINT, BROWSER_TOOL, BROWSER_UPDATE_HINT, browserStatus } from "./browser.js";
import { loadConfig, parseAgent, type AgentSpec, type Config, type ReviewBlockedPolicy } from "./config.js";
import { checkAgent } from "./diagnostics.js";
import { createElapsedTracker } from "./elapsed.js";
import { t } from "./i18n.js";
import { findTask, nextTask, sessionRunnableIds, type PRD } from "./prd.js";
import { loadPrdFile, type NormalizePrdOptions } from "./prdload.js";
import { log, setReporter } from "./log.js";
import { captureReviewBase, commitPaths, git, headCommit, taskChangedPaths } from "./git.js";
import { advisorPlanKey, invalidatePlan } from "./plan-cache.js";
import { readStandards } from "./prompts.js";
import { runTask, type RunTaskResult } from "./run.js";
import { formatCost, mergeCost, type CostTally } from "./stream.js";
import { createTaskWorktree, mergeBackTaskWork, reapOrphanWorktrees, removeTaskWorktree, worktreeLoss } from "./worktree.js";
import { emit, type RunEvent } from "./tui/events.js";
import { mount, type TuiHandle } from "./tui/mount.js";

export interface RunOptions {
  prd: string;
  workspace?: string;
  config?: string;
  executor?: string;
  advisor?: string;
  dryRun?: boolean;
  task?: string;
  noReviewAfter?: boolean;
  skipConfirm?: boolean;
  onReviewBlocked?: ReviewBlockedPolicy;
}

function savePRD(path: string, prd: PRD): void {
  writeFileSync(path, JSON.stringify(prd, null, 2));
}

export async function runLoop(opts: RunOptions): Promise<void> {
  const prdPath = resolve(opts.prd);
  if (!existsSync(prdPath)) {
    console.error(t("loop.err.noPrd", { path: prdPath }));
    process.exit(1);
  }
  const workspace = resolve(opts.workspace ?? ".");
  mkdirSync(workspace, { recursive: true });
  const progress = resolve(dirname(prdPath), "progress.md");
  if (!existsSync(progress)) writeFileSync(progress, "");

  const overrides: {
    executor?: AgentSpec;
    advisor?: AgentSpec | null;
    review_after?: boolean;
    review_blocked_policy?: ReviewBlockedPolicy;
  } = {};
  if (opts.executor) {
    const ex = parseAgent(opts.executor);
    if (ex) overrides.executor = ex;
  }
  if (opts.advisor !== undefined) overrides.advisor = parseAgent(opts.advisor);
  if (opts.noReviewAfter) overrides.review_after = false;
  if (opts.onReviewBlocked) overrides.review_blocked_policy = opts.onReviewBlocked;
  let cfg: Config;
  try {
    cfg = loadConfig(prdPath, opts.config, overrides);
  } catch (e) {
    // malformed ralph.config.json: one clean line (path + parse msg), no stack
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // canonical intake pipeline: parse + normalize (crash recovery, hand-written
  // backlogs) + strict shape validation — must run before ANY task read
  // (nextTask/dry-run inspect t.deps), so it gates dry-run and --task too.
  const loaded = loadPrdFile(prdPath);
  if (!loaded.ok) {
    console.error(t("loop.err.invalidPrd", { path: prdPath }));
    for (const e of loaded.errors) console.error("  " + e);
    console.error(t("loop.err.invalidPrdHint", { path: prdPath }));
    process.exit(1);
  }
  const prd0 = loaded.prd;
  if (loaded.normalized) {
    savePRD(prdPath, prd0);
    log(progress, t("loop.log.recovered"));
  }

  // mid-run reloads run the SAME parse→normalize→validate pipeline as the
  // preflight: a file corrupted or shape-broken MID-RUN (the executor agent can
  // write to the workspace) fails gracefully (log + unmount + stop) instead of
  // feeding runTask an invalid task or throwing a raw stack.
  const reload = (normalizeOpts?: NormalizePrdOptions): PRD | null => {
    const r = loadPrdFile(prdPath, normalizeOpts);
    if (!r.ok) {
      log(progress, t("loop.log.midrunCorrupt", { msg: r.errors.join("; ") }));
      return null;
    }
    return r.prd;
  };

  // live dashboard: mount the Ink TUI on a real TTY and route log() lines + the
  // RunEvents already emitted by run/executor into it; control (pause/skip/quit)
  // is driven off the returned handle. Non-TTY (pipe/CI) falls back to plain
  // log() line output. Real run only (progress.md always gets the raw log).
  let mode = runMode(cfg);
  let adv = cfg.advisor ? `${cfg.advisor.cli}:${cfg.advisor.model}` : "none";
  let exe = `${cfg.executor.cli}:${cfg.executor.model}`;

  if (!opts.dryRun && !opts.task && !opts.skipConfirm && process.stdout.isTTY) {
    const { select, isCancel } = await import("@clack/prompts");
    const blockedCount = prd0.tasks.filter((t) => t.status === "blocked").length;

    let ready = false;
    while (!ready) {
      console.clear();
      const options = [];
      if (blockedCount > 0) {
        options.push({ value: "retry_blocked", label: t("loop.resume.retryBlocked", { n: blockedCount }) });
      }
      options.push({ value: "start", label: t("loop.resume.start") });
      options.push({ value: "config", label: t("loop.resume.config") });
      options.push({ value: "quit", label: t("loop.resume.quit") });

      const action = await select({
        message: blockedCount > 0
          ? t("loop.resume.promptBlocked", { exe, adv, n: blockedCount })
          : t("loop.resume.prompt", { exe, adv }),
        options,
      });

      if (isCancel(action) || action === "quit") process.exit(0);
      if (action === "start" || action === "retry_blocked") {
        if (action === "retry_blocked") {
          let changed = false;
          for (const t of prd0.tasks) {
            if (t.status === "blocked") {
              t.status = "todo";
              t.retries = 0;
              invalidatePlan(t);
              changed = true;
            }
          }
          if (changed) savePRD(prdPath, prd0);
        }
        ready = true;
      } else if (action === "config") {
        cfg = await configureAgents(cfg, prdPath, opts.config, workspace);
        mode = runMode(cfg);
        exe = `${cfg.executor.cli}:${cfg.executor.model}`;
        adv = cfg.advisor ? `${cfg.advisor.cli}:${cfg.advisor.model}` : "none";
      }
    }
  }

  // The initial menu can replace an unavailable default agent. Once the user
  // starts, every configured agent must pass the same preflight gate.
  if (!opts.dryRun) prepareRun(cfg, workspace);

  if (!opts.dryRun) {
    // Unconditional, not gated on worktree_per_task: at boot no ralphrun
    // worktree can legitimately be live, so turning the feature OFF after a
    // crash must still clean up what the crash left. Same invariant as
    // normalizePrd resetting a stuck `doing` task, one layer down.
    const reaped = reapOrphanWorktrees(workspace);
    if (reaped > 0) log(progress, t("loop.log.worktreeReaped", { n: reaped }));

    log(progress, `\n---`);
    log(progress, t("loop.dry.mode", { mode, executor: exe, advisor: adv }));
    // Browser-validation preflight: a task opts in by invoking dev-browser in
    // its verify gate. Fail fast if the tool is missing OR present-but-unrunnable
    // (else every such task burns its retry budget on a gate that can't run),
    // and remind that it does not self-update. Scope to the tasks that CAN run
    // this session: the single --task (it executes regardless of status), else
    // the dependency closure of what will actually run — todo tasks and, on a
    // TTY, blocked tasks the menus can promote — so the tool is demanded iff a
    // browser task genuinely runs, never for one transitively gated by a task
    // that can't complete this session.
    const willRun = opts.task
      ? new Set([opts.task])
      : sessionRunnableIds(prd0, !!process.stdout.isTTY);
    const browserScope = prd0.tasks.filter((t) => willRun.has(t.id));
    if (anyTaskUsesBrowser(browserScope)) {
      const status = browserStatus();
      if (status === "missing") {
        console.error(t("loop.err.browserMissing", { tool: BROWSER_TOOL, cmd: BROWSER_INSTALL_HINT }));
        process.exit(1);
      }
      if (status === "broken") {
        console.error(t("loop.err.browserBroken", { tool: BROWSER_TOOL, cmd: BROWSER_INSTALL_HINT }));
        process.exit(1);
      }
      log(progress, t("loop.log.browserActive", { tool: BROWSER_TOOL, cmd: BROWSER_UPDATE_HINT }));
    }
  }

  let tui: TuiHandle | null = null;
  let curTaskId = "";
  const elapsedTracker = createElapsedTracker(performance.now());
  const setElapsedPaused = (paused: boolean): void => {
    elapsedTracker.setPaused(paused, performance.now());
  };
  let timeTicker: NodeJS.Timeout | null = null;
  const tickElapsed = (): void => {
    const payload: Pick<RunEvent, "taskId"> &
      Partial<Pick<RunEvent, "globalElapsedMs" | "taskElapsedMs">> =
      elapsedTracker.tick(curTaskId, tui!.control.isPaused(), performance.now());
    emit(payload);
  };
  const startTimeTicker = (): void => {
    timeTicker = setInterval(tickElapsed, 1000);
  };
  if (!opts.dryRun && process.stdout.isTTY) {
    const seed = prd0.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
    const header = `${prd0.project} — exec: ${exe} | adv: ${adv}`;
    tui = mount(seed, header, prd0.project, false, setElapsedPaused);
    setReporter((line) => tui!.update({ taskId: curTaskId, line, lineSource: "system" }));
    startTimeTicker();
  }
  // Ceilings fall, never rise: read ONCE, before any task runs. The config menu
  // is reachable mid-run and rewrites ralph.config.json, so a ceiling re-read
  // per iteration would let a run raise its own budget from the inside.
  const maxCostUsd = Math.max(0, cfg.max_cost_usd ?? 0);
  const runCost: CostTally = { usd: 0, unknown: false };
  // per task, kept across retries: a task that blocked after three attempts cost
  // all three, and the run report is only honest if it says so
  const taskCost = new Map<string, CostTally>();
  let accepted = 0; // tasks that reached done THIS run — the denominator
  let tasksRun = 0;

  const done = (): void => {
    if (timeTicker) clearInterval(timeTicker);
    setReporter(null);
    tui?.unmount();
    // after unmount, so the accounting survives in the terminal instead of
    // scrolling by inside a pane that is about to disappear
    if (tasksRun === 0) return; // nothing ran: no accounting to report
    log(
      progress,
      accepted > 0
        ? t("loop.log.runCost", {
            total: formatCost(runCost),
            n: accepted,
            per: formatCost({ usd: runCost.usd / accepted, unknown: runCost.unknown }),
          })
        : t("loop.log.runCostNoAccepted", { total: formatCost(runCost) }),
    );
  };
  const pendingReviewFeedback = new Map<string, string>();
  // The worktree as it stood when each task STARTED. Two consumers: the review
  // diffs against it, and the commit stages only what moved since it. Keyed by
  // task so a retry still measures from the task's own start, not the retry's.
  const taskBaselines = new Map<string, string | null>();

  while (true) {
    if (tui) setElapsedPaused(tui.control.isPaused());
    const tuiAction = tui ? await tui.waitConfigOrResume() : "resume";
    if (tui) setElapsedPaused(tuiAction === "config" || tui.control.isPaused());
    if (tuiAction === "quit" || tui?.control.shouldQuit()) {
      done();
      log(progress, t("loop.log.quit"));
      return;
    }

    // Money is a run-level ceiling and it is checked BETWEEN tasks, never
    // mid-task: killing a task that is already paid for throws the result away
    // and still leaves the bill. Checked at the TOP so every path that loops
    // back — including the review retry/approve `continue`s — passes through it.
    // Logged BEFORE done() so the reason lands in the TUI pane, not only in
    // progress.md.
    if (maxCostUsd > 0 && runCost.usd >= maxCostUsd) {
      log(progress, t("loop.log.stopBudget", { spent: formatCost(runCost), max: maxCostUsd.toFixed(2) }));
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
      mode = runMode(cfg);
      adv = cfg.advisor ? `${cfg.advisor.cli}:${cfg.advisor.model}` : "none";
      exe = `${cfg.executor.cli}:${cfg.executor.model}`;

      const pState = reload() ?? prd0;
      const seed = pState.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
      const header = `${pState.project} — exec: ${exe} | adv: ${adv}`;
      tui = mount(seed, header, pState.project, true, setElapsedPaused);
      setReporter((line) => tui!.update({ taskId: curTaskId, line, lineSource: "system" }));
      startTimeTicker();
      continue;
    }

    const prd = reload();
    if (!prd) {
      done();
      return;
    }
    let task;
    if (opts.task) {
      task = findTask(prd, opts.task) ?? undefined;
      if (!task) {
        done();
        console.error(t("loop.err.noTask", { id: opts.task }));
        process.exit(1);
      }
    } else {
      task = nextTask(prd) ?? undefined;
    }

    if (!task) {
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
      console.log(t("loop.dry.next", { id: task.id, title: task.title }));
      console.log(t("loop.dry.mode", { mode, executor: exe, advisor: adv }));
      console.log(t("loop.dry.review", { review }));
      return;
    }

    log(progress, t("loop.log.start", { id: task.id, title: task.title, n: task.retries + 1 }));
    task.status = "doing";
    curTaskId = task.id;
    const taskStartMs = performance.now();
    if (tui) elapsedTracker.setPaused(tui.control.isPaused(), taskStartMs);
    elapsedTracker.startTask(taskStartMs);
    savePRD(prdPath, prd);
    emit({ taskId: task.id, title: task.title, status: "doing" });

    // per-task AbortController from the mount handle: the TUI skip control aborts
    // this signal → runExecutor SIGKILLs the child. No TUI → no cancellation.
    const signal = tui ? tui.control.beginTask() : undefined;
    const reviewRetryFeedback = pendingReviewFeedback.get(task.id);
    pendingReviewFeedback.delete(task.id);

    // Worktree mode changes WHERE a task runs, never which task runs — the
    // scheduler still hands out exactly one. null = no isolation available, so
    // degrade to the main workspace with a line rather than failing the task:
    // infrastructure trouble is not something a retry of the task can fix.
    const wt = cfg.worktree_per_task ? createTaskWorktree(workspace, task.id, cfg.worktree_link ?? []) : null;
    if (cfg.worktree_per_task && !wt) log(progress, t("loop.log.worktreeUnavailable", { id: task.id }));
    const taskWorkspace = wt ?? workspace;

    let taskReviewBase: string | null | undefined;
    const reviewOn = cfg.review_after && !!cfg.advisor;
    if (reviewOn || cfg.commit_per_task) {
      if (!taskBaselines.has(task.id)) taskBaselines.set(task.id, captureReviewBase(taskWorkspace));
    }
    if (reviewOn) taskReviewBase = taskBaselines.get(task.id);
    // in worktree mode this IS the base the worktree was cut from, so it doubles
    // as the left end of the cherry-pick range
    const taskStartCommit = headCommit(taskWorkspace);
    const planBeforeRun = task.plan;
    const planKeyBeforeRun = task.planKey;

    // In worktree mode the commit is the TRANSPORT: it is how the work leaves
    // the cell, so both it and the cherry-pick have to succeed before the task
    // may be called done. The serial path is untouched and still commits after
    // savePRD, where the commit carries the task's new status.
    //
    // ponytail: an executor that rewrites prd.json rewrites the WORKTREE's copy,
    // which is frozen at the base commit while the live one keeps moving. That
    // fails closed rather than silently — the live file is dirty, so the pick is
    // refused and the task blocks — but it does mean mid-run backlog edits do
    // not work in worktree mode. Give the worktree a symlink to the real file if
    // that ever needs to work.
    const wtTask = task;
    // "someone already said, with a sha, what happened to this worktree's work" —
    // so the discard notice below does not repeat a line the merge already wrote.
    let worktreeAccounted = false;
    const landWorktreeWork = (): "ok" | "conflict" | "dirty" => {
      if (!wt) return "ok";
      logTaskCommit(taskWorkspace, progress, wtTask.id, wtTask.title, cfg, taskBaselines.get(wtTask.id));
      const m = mergeBackTaskWork(workspace, wt, taskStartCommit);
      if (m.status === "conflict" || m.status === "dirty") {
        log(
          progress,
          t(m.status === "dirty" ? "loop.log.worktreeDirty" : "loop.log.worktreeConflict", {
            id: wtTask.id,
            hash: shortHash(m.head ?? ""),
          }),
        );
        worktreeAccounted = true;
        return m.status;
      }
      worktreeAccounted = true;
      return "ok";
    };

    // unknown, not 0: if runTask throws before any executor settles, whatever it
    // already spent was never reported to us
    try {
      let result: RunTaskResult = { ok: false, reason: "failed", cost: { usd: 0, unknown: true } };
      try {
        result = await runTask(task, prd, cfg, taskWorkspace, progress, signal, reviewRetryFeedback, taskReviewBase, (plan, planKey) => {
          const currentPrd = reload({ keepDoing: true });
          if (currentPrd) {
            const currentTask = currentPrd.tasks.find((x) => x.id === task.id);
            const advisor = cfg.advisor;
            const controlFileCacheUnchanged = currentTask?.plan === planBeforeRun && currentTask?.planKey === planKeyBeforeRun;
            if (
              currentTask &&
              advisor &&
              controlFileCacheUnchanged &&
              advisorPlanKey(currentTask, currentPrd, advisor, readStandards(taskWorkspace)) === planKey
            ) {
              currentTask.status = "doing";
              currentTask.plan = plan;
              currentTask.planKey = planKey;
              savePRD(prdPath, currentPrd);
            }
          }
        });
      } catch (e) {
        log(progress, t("loop.log.crashed", { id: task.id, msg: e instanceof Error ? e.message : String(e) }));
        result = { ok: false, reason: "failed", cost: { usd: 0, unknown: true } };
      }
      const taskStopMs = performance.now();
      if (tui) elapsedTracker.setPaused(tui.control.isPaused(), taskStopMs);
      const elapsedMs = elapsedTracker.stopTask(taskStopMs);
      const elapsed = Math.round(elapsedMs / 1000);
      tasksRun += 1;
      const spent = taskCost.get(task.id) ?? { usd: 0, unknown: false };
      mergeCost(spent, result.cost);
      taskCost.set(task.id, spent);
      mergeCost(runCost, result.cost);
      // Silent when nothing was measured AND no budget is set: a line that says
      // "unknown" on every task of every cli that does not report cost is noise.
      if (spent.usd > 0 || maxCostUsd > 0) {
        log(progress, t("loop.log.cost", { id: task.id, cost: formatCost(spent), total: formatCost(runCost) }));
      }
      const taskEndCommit = headCommit(taskWorkspace);
      if (taskEndCommit && taskEndCommit !== taskStartCommit) {
        log(progress, t("loop.log.executorCommit", { id: task.id, hash: shortHash(taskEndCommit) }));
      }

      // quit pressed mid-task: the child was aborted, runTask returned. Exit now
      // without munging status — the task stays "doing" and recovery resets it next run.
      if (tui?.control.shouldQuit()) {
        done();
        log(progress, t("loop.log.quit"));
        return;
      }
      const skipped = tui?.control.takeSkip() ?? false;

      const fresh = reload();
      if (!fresh) {
        done();
        return;
      }
      // the just-run task can vanish if prd.json was rewritten mid-run — stop
      // gracefully instead of throwing on the status write.
      const freshTask = fresh.tasks.find((t) => t.id === task!.id);
      if (!freshTask) {
        done();
        log(progress, t("loop.log.taskVanished", { id: task.id }));
        return;
      }
      // Worktree mode lands the work BEFORE the status write: a task whose
      // commits cannot be cherry-picked back must never be recorded as done
      // with nothing in the main workspace to show for it. No-op serially.
      const landed = !skipped && result.ok ? landWorktreeWork() : "ok";

      if (skipped) {
        taskBaselines.delete(task.id);
        freshTask.status = "blocked";
        const reason = t("loop.reason.skipped");
        log(progress, t("loop.log.skipped", { id: task.id, s: elapsed }));
        emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
        savePRD(prdPath, fresh);
      } else if (result.ok && landed === "ok") {
        freshTask.status = "done";
        accepted += 1;
        log(progress, t("loop.log.done", { id: task.id, s: elapsed }));
        emit({ taskId: task.id, status: "done", elapsedMs });
        savePRD(prdPath, fresh);
        // AFTER savePRD (the commit is meant to carry the task's new status) and
        // BEFORE the baseline is dropped — the commit needs it to know which paths
        // are this task's and which were already dirty. In worktree mode
        // landWorktreeWork already committed, because there the commit is the
        // only way the work gets out.
        if (cfg.commit_per_task && !wt) {
          logTaskCommit(workspace, progress, task.id, task.title, cfg, taskBaselines.get(task.id));
        }
        taskBaselines.delete(task.id);
      } else if (landed === "dirty") {
        // A retry cannot help here: the user's own uncommitted edit to that file
        // will still be in the way next time, so blocking now saves a full
        // agent run's spend. This is the one conflict cause reachable at
        // concurrency 1, since nothing else is writing the main workspace.
        taskBaselines.delete(task.id);
        freshTask.status = "blocked";
        const reason = t("loop.reason.mergeDirty");
        log(progress, t("loop.log.blockedReview", { id: task.id, s: elapsed, reason }));
        emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
        savePRD(prdPath, fresh);
      } else if (result.reason === "review_changes" || result.reason === "review_stalled" || result.reason === "review_exhausted") {
        const reason =
          result.reason === "review_stalled"
            ? t("loop.reason.reviewStalled")
            : result.reason === "review_changes"
              ? t("loop.reason.reviewChanges")
              : t("loop.reason.reviewExhausted");
        const displayReason = withReviewFeedback(reason, result.reviewChanges);
        // Replan rung of the recovery ladder. A stall means every fix round landed
        // on the identical failure, and the plan the executor was following is part
        // of that evidence — so it must not be replayed. Only on a stall: an
        // ordinary retry is what the cache exists for, and there the plan is not
        // the suspect. run.ts detects the stall, this owns prd.json, and each exit
        // below saves `fresh`.
        if (result.reason === "review_stalled") {
          invalidatePlan(freshTask);
          log(progress, t("loop.log.planInvalidated", { id: task.id }));
        }
        const allowReviewOverride = result.verificationPassed === true;
        const action = await reviewBlockedGate(tui, cfg, progress, task.id, displayReason, allowReviewOverride);
        if (action === "quit") {
          done();
          log(progress, t("loop.log.quit"));
          return;
        }
        if (action === "retry") {
          freshTask.status = "todo";
          const feedback = result.reviewChanges?.trim() || reason;
          pendingReviewFeedback.set(task.id, feedback);
          log(progress, t("loop.log.reviewRetry", { id: task.id, reason: displayReason }));
          emit({ taskId: task.id, status: "retry", reason: displayReason, elapsedMs });
          savePRD(prdPath, fresh);
          await sleep(1000);
          continue;
        }
        if (action === "approve" && allowReviewOverride) {
          const approveLanded = landWorktreeWork();
          if (approveLanded !== "ok") {
            // Approved but unlandable. Blocking beats recording a done task the
            // main workspace never received; the sha to recover it is already
            // in the log line landWorktreeWork wrote.
            taskBaselines.delete(task.id);
            freshTask.status = "blocked";
            const reason = approveLanded === "dirty" ? t("loop.reason.mergeDirty") : t("loop.reason.mergeConflict");
            log(progress, t("loop.log.blockedReview", { id: task.id, s: elapsed, reason }));
            emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
            savePRD(prdPath, fresh);
            if (opts.task) {
              done();
              return;
            }
            await sleep(1000);
            continue;
          }
          freshTask.status = "done";
          accepted += 1; // accepted change, whoever accepted it: same denominator as an auto-pass
          log(
            progress,
            tui
              ? t("loop.log.reviewAccepted", { id: task.id, s: elapsed, reason: displayReason })
              : t("loop.log.headlessAccepted", { id: task.id, s: elapsed, reason: displayReason }),
          );
          emit({ taskId: task.id, status: "done", reason: displayReason, elapsedMs });
          savePRD(prdPath, fresh);
          if (cfg.commit_per_task && !wt) {
            logTaskCommit(workspace, progress, task.id, task.title, cfg, taskBaselines.get(task.id));
          }
          taskBaselines.delete(task.id);
          if (opts.task) {
            done();
            return;
          }
          await sleep(1000);
          continue;
        }
        taskBaselines.delete(task.id);
        freshTask.status = "blocked";
        log(progress, t("loop.log.blockedReview", { id: task.id, s: elapsed, reason: displayReason }));
        emit({ taskId: task.id, status: "blocked", reason: displayReason, elapsedMs });
        savePRD(prdPath, fresh);
      } else {
        // Also where a merge-back CONFLICT lands, deliberately: the next
        // attempt's worktree is cut from the new HEAD, which already contains
        // whatever won, so "re-execute on top of the result" is what already
        // happens and max_retries_per_task is already the attempt ceiling.
        // No second ladder, no separate block reason.
        freshTask.retries += 1;
        if (freshTask.retries >= cfg.max_retries_per_task) {
          taskBaselines.delete(task.id);
          freshTask.status = "blocked";
          const reason = t("loop.reason.maxRetries");
          log(progress, t("loop.log.blocked", { id: task.id, s: elapsed }));
          emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
        } else {
          freshTask.status = "todo";
          log(progress, t("loop.log.retry", { id: task.id, s: elapsed, n: freshTask.retries }));
          emit({ taskId: task.id, status: "retry", elapsedMs });
        }
        savePRD(prdPath, fresh);
      }

      if (opts.task) {
        done();
        return;
      }
      // a manual skip marks the task blocked too, but the user asked to move ON —
      // only an automatic (max-retries) block honors stop_on_blocked.
      if (!skipped && freshTask.status === "blocked" && cfg.stop_on_blocked) {
        done();
        log(progress, t("loop.log.stopBlocked"));
        return;
      }
      await sleep(1000);
    } finally {
      // Every exit path — done, blocked, skipped, retry, quit, crash — drops the
      // cell. That discard IS the rollback the serial loop never had, where a
      // blocked task leaves its mess smeared across the main workspace.
      if (wt) {
        // The baseline is a tree of THIS worktree's start. The next attempt gets
        // a fresh worktree cut from a newer HEAD, so keeping it would make that
        // attempt stage whatever landed in between as its own work.
        taskBaselines.delete(task.id);
        if (!worktreeAccounted) {
          const lost = worktreeLoss(wt, taskStartCommit);
          if (lost.head) log(progress, t("loop.log.worktreeDiscarded", { id: task.id, hash: shortHash(lost.head) }));
          else if (lost.dirty) log(progress, t("loop.log.worktreeDiscardedDirty", { id: task.id }));
        }
        removeTaskWorktree(workspace, wt);
      }
    }
  }
}

/**
 * The one decision point for a task the reviewer refused. It used to live inside
 * `if (tui)`, which meant the gate existed only in the UI layer: a headless run
 * had no gate at all and the task just went blocked. Both callers of the same
 * decision now route through here.
 *
 * Headless cannot prompt — nobody is watching, and a run that waits forever for
 * an answer is worse than one that decides — so its gate is a POLICY. It obeys
 * the same safety property as the TUI's approve key: `verified` is the only door
 * to "approve", so no policy can accept a task whose tests failed.
 *
 * Every headless refusal is logged with WHY, because progress.md is the only
 * audit trail a run nobody watched leaves behind. An acceptance is logged by the
 * caller, which is where the elapsed time and the commit are.
 */
async function reviewBlockedGate(
  tui: TuiHandle | null,
  cfg: Config,
  progress: string,
  id: string,
  displayReason: string,
  verified: boolean,
): Promise<"retry" | "approve" | "block" | "quit"> {
  if (tui) return tui.waitReviewBlocked(displayReason, verified);
  const wantsAccept = cfg.review_blocked_policy === "accept";
  if (wantsAccept && verified) return "approve";
  log(
    progress,
    t("loop.log.headlessBlocked", {
      id,
      why: wantsAccept ? t("loop.reason.policyNeedsVerify") : t("loop.reason.policyBlock"),
    }),
  );
  return "block";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withReviewFeedback(reason: string, changes?: string): string {
  const compact = changes?.replace(/\s+/g, " ").trim();
  if (!compact) return reason;
  const max = 220;
  const summary = compact.length <= max ? compact : compact.slice(0, max - 1).trimEnd() + "…";
  return `${reason}: ${summary}`;
}

function logTaskCommit(
  workspace: string,
  progress: string,
  id: string,
  title: string,
  cfg: Config,
  base?: string | null,
): void {
  const before = headCommit(workspace);
  // function replacers: a literal id/title is used verbatim (a "$&"/"$1" in a
  // task title must not be interpreted as a replacement pattern).
  const msg = (cfg.commit_message_template || "{id}: {title}").replace(/{id}/g, () => id).replace(/{title}/g, () => title);
  // Stage only what THIS task moved. `git add -A` also swept up whatever the
  // user happened to have uncommitted when the run started, putting their
  // unrelated work in a commit named after a task that never touched it — and
  // the review that approved this commit never saw those files either.
  const paths = taskChangedPaths(workspace, base);
  if (paths?.length === 0) return; // nothing moved: no empty commit, nothing to log
  if (!paths || !commitPaths(workspace, paths, msg)) {
    // null = no baseline to scope against (no repo yet). A FAILED scoped stage is
    // different: the executor staged a rename or deletion despite being told not
    // to, so say so — this is the commit that can still swallow unrelated work.
    if (paths) log(progress, t("loop.log.commitUnscoped", { id }));
    git(workspace, "add", "-A");
    git(workspace, "commit", "-m", msg);
  }
  const after = headCommit(workspace);
  if (after && after !== before) log(progress, t("loop.log.committed", { id, hash: shortHash(after) }));
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function runMode(cfg: Config): "NATIVE" | "CROSS" {
  return supportsNativeAdvisor(cfg.executor.cli, cfg.advisor?.cli) ? "NATIVE" : "CROSS";
}

function prepareRun(cfg: Config, workspace: string): void {
  const used = new Set<string>([cfg.executor.cli]);
  if (cfg.advisor) used.add(cfg.advisor.cli);
  for (const cli of used) {
    const diag = checkAgent(cli);
    if (!diag.installed) {
      console.error(t("loop.err.notInstalled", { cli }));
      process.exit(1);
    }
    if (diag.loggedIn === false) {
      console.error(t("loop.err.notLoggedIn", { cli, cmd: diag.loginCommand! }));
      process.exit(1);
    }
  }
  if ((cfg.commit_per_task || cfg.review_after) && !existsSync(workspace + "/.git")) git(workspace, "init");
}

async function configureAgents(cfg: Config, prdPath: string, configFlag: string | undefined, workspace: string): Promise<Config> {
  const { isCancel } = await import("@clack/prompts");
  const { pickModel } = await import("./configcmd.js");
  const executor = await pickModel("executor", `${cfg.executor.cli}:${cfg.executor.model}`);
  if (isCancel(executor)) return cfg;
  const executorSpec = parseAgent(executor as string);
  if (!executorSpec) return cfg;
  const advisor = await pickModel("advisor", cfg.advisor ? `${cfg.advisor.cli}:${cfg.advisor.model}` : "none");
  if (isCancel(advisor)) return cfg;
  const next: Config = { ...cfg, executor: executorSpec, advisor: parseAgent(advisor as string) };
  prepareRun(next, workspace);
  const configPath = configFlag ? resolve(configFlag) : resolve(dirname(prdPath), "ralph.config.json");
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
  return next;
}
