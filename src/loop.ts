// loop.ts — the main run loop: load prd, recover, preflight, route, run tasks,
// update status, retry/block, commit per task.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, parseAgent, type AgentSpec, type Config } from "./config.js";
import { checkAgent } from "./diagnostics.js";
import { t } from "./i18n.js";
import { findTask, nextTask, type PRD } from "./prd.js";
import { loadPrdFile } from "./prdload.js";
import { log, setReporter } from "./log.js";
import { git } from "./git.js";
import { runTask } from "./run.js";
import { emit } from "./tui/events.js";
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

  const overrides: { executor?: AgentSpec; advisor?: AgentSpec | null; review_after?: boolean } = {};
  if (opts.executor) {
    const ex = parseAgent(opts.executor);
    if (ex) overrides.executor = ex;
  }
  if (opts.advisor !== undefined) overrides.advisor = parseAgent(opts.advisor);
  if (opts.noReviewAfter) overrides.review_after = false;
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
  const reload = (): PRD | null => {
    const r = loadPrdFile(prdPath);
    if (!r.ok) {
      log(progress, t("loop.log.midrunCorrupt", { msg: r.errors.join("; ") }));
      return null;
    }
    return r.prd;
  };

  if (!opts.dryRun) {
    // preflight: strict gate for installed & logged in CLIs
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

    // git is needed for per-task commits and for review-after diffs
    if ((cfg.commit_per_task || cfg.review_after) && !existsSync(workspace + "/.git")) {
      git(workspace, "init");
    }
  }

  // live dashboard: mount the Ink TUI on a real TTY and route log() lines + the
  // RunEvents already emitted by run/executor into it; control (pause/skip/quit)
  // is driven off the returned handle. Non-TTY (pipe/CI) falls back to plain
  // log() line output. Real run only (progress.md always gets the raw log).
  const mode = cfg.advisor && cfg.executor.cli === "claude" && cfg.advisor.cli === "claude" ? "NATIVE" : "CROSS";
  const adv = cfg.advisor ? `${cfg.advisor.cli}:${cfg.advisor.model}` : "none";
  const exe = `${cfg.executor.cli}:${cfg.executor.model}`;

  if (!opts.dryRun) {
    log(progress, `\n---`);
    log(progress, t("loop.dry.mode", { mode, executor: exe, advisor: adv }));
  }

  let tui: TuiHandle | null = null;
  let curTaskId = "";
  if (!opts.dryRun && process.stdout.isTTY) {
    const seed = prd0.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
    const header = `${prd0.project} — exec: ${exe} | adv: ${adv}`;
    tui = mount(seed, header);
    setReporter((line) => tui!.update({ taskId: curTaskId, line }));
  }
  const done = (): void => {
    setReporter(null);
    tui?.unmount();
  };

  while (true) {
    await tui?.waitResume(); // pause gate; resolves on unpause or quit
    if (tui?.control.shouldQuit()) {
      done();
      log(progress, t("loop.log.quit"));
      return;
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
          let changed = false;
          for (const t of prd.tasks) {
            if (t.status === "blocked") {
              t.status = "todo";
              t.retries = 0;
              changed = true;
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
    savePRD(prdPath, prd);
    emit({ taskId: task.id, title: task.title, status: "doing" });

    // per-task AbortController from the mount handle: the TUI skip control aborts
    // this signal → runExecutor SIGKILLs the child. No TUI → no cancellation.
    const signal = tui ? tui.control.beginTask() : undefined;
    const t0 = Date.now();
    let ok = false;
    try {
      ok = await runTask(task, prd, cfg, workspace, progress, signal);
    } catch (e) {
      log(progress, t("loop.log.crashed", { id: task.id, msg: e instanceof Error ? e.message : String(e) }));
      ok = false;
    }
    const elapsedMs = Date.now() - t0;
    const elapsed = Math.round(elapsedMs / 1000);

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
    if (skipped) {
      freshTask.status = "blocked";
      const reason = t("loop.reason.skipped");
      log(progress, t("loop.log.skipped", { id: task.id, s: elapsed }));
      emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
    } else if (ok) {
      freshTask.status = "done";
      log(progress, t("loop.log.done", { id: task.id, s: elapsed }));
      emit({ taskId: task.id, status: "done", elapsedMs });
      if (cfg.commit_per_task) {
        git(workspace, "add", "-A");
        git(workspace, "commit", "-m", `${task.id}: ${task.title}`);
      }
    } else {
      freshTask.retries += 1;
      if (freshTask.retries >= cfg.max_retries_per_task) {
        freshTask.status = "blocked";
        const reason = t("loop.reason.maxRetries");
        log(progress, t("loop.log.blocked", { id: task.id, s: elapsed }));
        emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
      } else {
        freshTask.status = "todo";
        log(progress, t("loop.log.retry", { id: task.id, s: elapsed, n: freshTask.retries }));
        emit({ taskId: task.id, status: "retry", elapsedMs });
      }
    }
    savePRD(prdPath, fresh);

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
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
