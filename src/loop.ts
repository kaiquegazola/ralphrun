// loop.ts — the main run loop: load prd, recover, preflight, route, run tasks,
// update status, retry/block, commit per task.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, parseAgent, type AgentSpec, type Config } from "./config.js";
import { checkAgent } from "./diagnostics.js";
import { t } from "./i18n.js";
import { findTask, nextTask, type PRD } from "./prd.js";
import { loadPrdFile } from "./prdload.js";
import { log, setReporter } from "./log.js";
import { captureReviewBase, git, headCommit } from "./git.js";
import { runTask, type RunTaskResult } from "./run.js";
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
  skipConfirm?: boolean;
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
    log(progress, `\n---`);
    log(progress, t("loop.dry.mode", { mode, executor: exe, advisor: adv }));
  }

  let tui: TuiHandle | null = null;
  let curTaskId = "";
  if (!opts.dryRun && process.stdout.isTTY) {
    const seed = prd0.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
    const header = `${prd0.project} — exec: ${exe} | adv: ${adv}`;
    tui = mount(seed, header);
    setReporter((line) => tui!.update({ taskId: curTaskId, line, lineSource: "system" }));
  }
  const done = (): void => {
    setReporter(null);
    tui?.unmount();
  };
  const pendingReviewFeedback = new Map<string, string>();
  const reviewBaselines = new Map<string, string | null>();

  while (true) {
    const tuiAction = tui ? await tui.waitConfigOrResume() : "resume";
    if (tuiAction === "quit" || tui?.control.shouldQuit()) {
      done();
      log(progress, t("loop.log.quit"));
      return;
    }

    if (tuiAction === "config" && tui) {
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
      tui = mount(seed, header, true);
      setReporter((line) => tui!.update({ taskId: curTaskId, line, lineSource: "system" }));
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
    savePRD(prdPath, prd);
    emit({ taskId: task.id, title: task.title, status: "doing" });

    // per-task AbortController from the mount handle: the TUI skip control aborts
    // this signal → runExecutor SIGKILLs the child. No TUI → no cancellation.
    const signal = tui ? tui.control.beginTask() : undefined;
    const reviewRetryFeedback = pendingReviewFeedback.get(task.id);
    pendingReviewFeedback.delete(task.id);
    let taskReviewBase: string | null | undefined;
    if (cfg.review_after && cfg.advisor) {
      if (!reviewBaselines.has(task.id)) reviewBaselines.set(task.id, captureReviewBase(workspace));
      taskReviewBase = reviewBaselines.get(task.id);
    }
    const taskStartCommit = headCommit(workspace);
    const t0 = Date.now();
    let result: RunTaskResult = { ok: false, reason: "failed" };
    try {
      result = await runTask(task, prd, cfg, workspace, progress, signal, reviewRetryFeedback, taskReviewBase);
    } catch (e) {
      log(progress, t("loop.log.crashed", { id: task.id, msg: e instanceof Error ? e.message : String(e) }));
      result = { ok: false, reason: "failed" };
    }
    const elapsedMs = Date.now() - t0;
    const elapsed = Math.round(elapsedMs / 1000);
    const taskEndCommit = headCommit(workspace);
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
    if (skipped) {
      reviewBaselines.delete(task.id);
      freshTask.status = "blocked";
      const reason = t("loop.reason.skipped");
      log(progress, t("loop.log.skipped", { id: task.id, s: elapsed }));
      emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
      savePRD(prdPath, fresh);
    } else if (result.ok) {
      reviewBaselines.delete(task.id);
      freshTask.status = "done";
      log(progress, t("loop.log.done", { id: task.id, s: elapsed }));
      emit({ taskId: task.id, status: "done", elapsedMs });
      savePRD(prdPath, fresh);
      if (cfg.commit_per_task) {
        logTaskCommit(workspace, progress, task.id, task.title);
      }
    } else if (result.reason === "review_changes" || result.reason === "review_stalled" || result.reason === "review_exhausted") {
      const reason =
        result.reason === "review_stalled"
          ? t("loop.reason.reviewStalled")
          : result.reason === "review_changes"
            ? t("loop.reason.reviewChanges")
            : t("loop.reason.reviewExhausted");
      const displayReason = withReviewFeedback(reason, result.reviewChanges);
      const allowReviewOverride = result.verificationPassed === true;
      if (tui) {
        const action = await tui.waitReviewBlocked(displayReason, allowReviewOverride);
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
          reviewBaselines.delete(task.id);
          freshTask.status = "done";
          log(progress, t("loop.log.reviewAccepted", { id: task.id, s: elapsed, reason: displayReason }));
          emit({ taskId: task.id, status: "done", reason: displayReason, elapsedMs });
          savePRD(prdPath, fresh);
          if (cfg.commit_per_task) {
            logTaskCommit(workspace, progress, task.id, task.title);
          }
          if (opts.task) {
            done();
            return;
          }
          await sleep(1000);
          continue;
        }
      }
      reviewBaselines.delete(task.id);
      freshTask.status = "blocked";
      log(progress, t("loop.log.blockedReview", { id: task.id, s: elapsed, reason: displayReason }));
      emit({ taskId: task.id, status: "blocked", reason: displayReason, elapsedMs });
      savePRD(prdPath, fresh);
    } else {
      freshTask.retries += 1;
      if (freshTask.retries >= cfg.max_retries_per_task) {
        reviewBaselines.delete(task.id);
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
  }
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

function logTaskCommit(workspace: string, progress: string, id: string, title: string): void {
  const before = headCommit(workspace);
  git(workspace, "add", "-A");
  git(workspace, "commit", "-m", `${id}: ${title}`);
  const after = headCommit(workspace);
  if (after && after !== before) log(progress, t("loop.log.committed", { id, hash: shortHash(after) }));
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function runMode(cfg: Config): "NATIVE" | "CROSS" {
  return cfg.advisor && cfg.executor.cli === "claude" && cfg.advisor.cli === "claude" ? "NATIVE" : "CROSS";
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
