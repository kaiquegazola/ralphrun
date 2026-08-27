// startrun.ts — everything that has to be true BEFORE the first task runs.
//
// Split out of runLoop because it has a boundary the rest of that function does
// not: this is straight-line initialization with one output, while the loop is
// long-lived shared state. Keeping them together made the entry point of a run
// unreadable and, worse, untestable except through a full loop with every
// collaborator mocked.
//
// Everything here either succeeds or exits the process. A run that starts is a
// run whose config parsed, whose backlog validated, whose agents are installed
// and logged in, and whose workspace cannot corrupt itself — so nothing
// downstream re-checks any of it.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { supportsNativeAdvisor } from "./agents.js";
import { hostMismatch } from "./host.js";
import { anyTaskUsesBrowser, browserStatus, BROWSER_INSTALL_HINT, BROWSER_TOOL, BROWSER_UPDATE_HINT } from "./browser.js";
import { loadConfig, parseAgent, type AgentSpec, type Config, type ReviewBlockedPolicy } from "./config.js";
import { checkAgent } from "./diagnostics.js";
import { git } from "./git.js";
import { t } from "./i18n.js";
import { log, setReporter } from "./log.js";
import { invalidatePlan } from "./plan-cache.js";
import { sessionRunnableIds, type PRD, type Task } from "./prd.js";
import { literalScopeDirectoryPrefix, loadPrdFile, type NormalizePrdOptions } from "./prdload.js";
import { createElapsedTracker, type ElapsedTracker } from "./elapsed.js";
import { type CostTally } from "./stream.js";
import { emit, type RunEvent } from "./tui/events.js";
import { mount, type TuiHandle } from "./tui/mount.js";
import {
  claimRunLock,
  ignoredDirsWouldBeShared,
  linkedDirsPresent,
  reapOrphanWorktrees,
  tasksInstallingDeps,
  verifyInstallsDeps,
} from "./worktree.js";

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

/**
 * A run that is ready to execute: the starting state, handed over once.
 *
 * Everything here is produced by startup and never re-derived. What CHANGES
 * during a run — the config the mid-run menu replaces, the dashboard it
 * remounts, the cost counters — deliberately does NOT live here: runLoop owns
 * its own mutable state, so this stays a handover rather than a second place to
 * look for the truth.
 */
export interface RunSetup {
  prdPath: string;
  workspace: string;
  progress: string;
  prd0: PRD;
  /** as loaded; runLoop owns it from here, since the config menu can replace it */
  cfg: Config;
  mode: "NATIVE" | "CROSS";
  exe: string;
  adv: string;
  /** already mounted, or null off a TTY. runLoop wires the reporter to it. */
  tui: TuiHandle | null;
  reload: (normalizeOpts?: NormalizePrdOptions) => PRD | null;
  elapsedTracker: ElapsedTracker;
  trackers: Set<ElapsedTracker>;
  setElapsedPaused: (paused: boolean) => void;
}

export function runMode(cfg: Config): "NATIVE" | "CROSS" {
  return supportsNativeAdvisor(cfg.executor.cli, cfg.advisor?.cli) ? "NATIVE" : "CROSS";
}

export function missingScopePrefixes(tasks: Task[], workspace: string): string[] {
  const root = resolve(workspace);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const task of tasks) {
    for (const pattern of task.scope ?? []) {
      const prefix = literalScopeDirectoryPrefix(pattern);
      if (!prefix) continue;
      const absolute = resolve(root, prefix);
      const relativePath = relative(root, absolute);
      // A repo-relative scope is the contract this check can prove. Do not turn
      // a malformed/outside path into a filesystem claim here; the existing
      // scope gate will keep such work from landing and report the actual path.
      if (!relativePath || relativePath === ".." || relativePath.startsWith(".." + requirePathSeparator())) continue;
      // Walk the static prefix so the record names the FIRST missing directory
      // (`src/db/`), not a deeper child (`src/db/schema/`) that is absent only
      // because the typo already broke its ancestor. The final leaf of a `/**`
      // scope is excluded by literalScopeDirectoryPrefix and may be created.
      let missing: string | undefined;
      let checked = "";
      for (const part of prefix.split("/")) {
        checked = checked ? `${checked}/${part}` : part;
        const candidate = resolve(root, checked);
        if (!existsSync(candidate)) {
          missing = relative(root, candidate).replace(/\\/g, "/");
          break;
        }
      }
      if (!missing) continue;
      const key = `${task.id}\0${prefix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push(`${task.id}: ${missing}/ (from ${pattern})`);
    }
  }
  return problems;
}

function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function runnableTasksAtBoot(prd: PRD, targetId?: string): Task[] {
  if (targetId) return prd.tasks.filter((task) => task.id === targetId && !hostMismatch(task.required_host));
  const done = new Set(prd.tasks.filter((task) => task.status === "done").map((task) => task.id));
  return prd.tasks.filter((task) => task.status === "todo" && task.deps.every((dep) => done.has(dep)) && !hostMismatch(task.required_host));
}

/**
 * Fail-fast preflight: every configured agent must exist and be logged in.
 * Discovering a missing CLI per task would burn each one's whole retry budget on
 * a problem no retry can fix.
 */
export function prepareRun(cfg: Config, workspace: string): void {
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

export async function startRun(opts: RunOptions, savePRD: (path: string, prd: PRD) => void): Promise<RunSetup> {
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
  // Through log(), not stderr: under the TUI a stderr line scrolls past unread,
  // and it would never reach progress.md — the only record an unattended run
  // leaves. Only here, never on a mid-run reload, which would repeat it per task.
  for (const w of loaded.warnings) log(progress, w);

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

  let mode = runMode(cfg);
  let adv = cfg.advisor ? `${cfg.advisor.cli}:${cfg.advisor.model}` : "none";
  let exe = `${cfg.executor.cli}:${cfg.executor.model}`;

  if (!opts.dryRun && !opts.task && !opts.skipConfirm && process.stdout.isTTY) {
    const { select, isCancel } = await import("@clack/prompts");
    const blockedCount = prd0.tasks.filter((x) => x.status === "blocked").length;

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
        message:
          blockedCount > 0
            ? t("loop.resume.promptBlocked", { exe, adv, n: blockedCount })
            : t("loop.resume.prompt", { exe, adv }),
        options,
      });

      if (isCancel(action) || action === "quit") process.exit(0);
      if (action === "start" || action === "retry_blocked") {
        if (action === "retry_blocked") {
          let changed = false;
          for (const x of prd0.tasks) {
            if (x.status === "blocked") {
              x.status = "todo";
              x.retries = 0;
              invalidatePlan(x);
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

  // A missing scope parent is a plan typo that would otherwise cost an entire
  // executor/reviewer attempt before the objective gate discards the work. The
  // refusal is limited to tasks that can start now: a later task may depend on
  // an earlier task creating that parent, and an absent leaf itself is allowed.
  const scopeProblems = missingScopePrefixes(runnableTasksAtBoot(prd0, opts.task), workspace);
  if (scopeProblems.length > 0) {
    const message = t("loop.err.scopeMissing", { items: scopeProblems.join(", ") });
    log(progress, message);
    console.error(message);
    process.exit(1);
  }

  // The initial menu can replace an unavailable default agent. Once the user
  // starts, every configured agent must pass the same preflight gate.
  if (!opts.dryRun) prepareRun(cfg, workspace);

  // A cell seeds node_modules by copy-on-write clone, which isolates it. Where
  // the filesystem cannot clone, the fallback is a symlink at the REAL tree —
  // and two concurrent installs into that corrupt the user's own dependencies,
  // which discarding a worktree cannot undo. Refuse the combination at load,
  // naming the tasks, rather than discovering it as a broken node_modules.
  //
  // The names that are CONFIGURED are not the hazard; the ones the workspace
  // actually has are. A cell gets nothing seeded for a directory that is not
  // there, so a checkout with no node_modules and `worktree_setup: "npm ci"` —
  // the documented Windows shape — shares nothing at all, and refusing it named
  // a corruption that could not happen.
  const seeded = linkedDirsPresent(workspace, cfg.worktree_link ?? []);
  if (
    !opts.dryRun &&
    cfg.worktree_per_task &&
    (cfg.max_parallel_tasks ?? 1) > 1 &&
    seeded.length > 0 &&
    // the names the workspace HAS, so the probe measures the filesystems the
    // seeding would actually clone between — a `node_modules` mounted on another
    // volume shares even where the repo's own filesystem clones fine
    ignoredDirsWouldBeShared(workspace, seeded)
  ) {
    // worktree_setup FIRST, and as its own refusal rather than folded into the
    // one below. It is the strictly worse shape of the same hazard: it runs in
    // every cell, so an install there is not "these tasks" but all of them at
    // once, and it fires no matter how innocent the backlog's verify commands
    // are. It also has a different fix — the two knobs are alternatives, and
    // naming task ids for a hazard no task caused would send the user editing
    // the wrong file.
    const setup = cfg.worktree_setup?.trim();
    if (setup && verifyInstallsDeps(setup)) {
      console.error(t("loop.err.sharedSetupInstall", { cmd: setup, links: seeded.join(", ") }));
      process.exit(1);
    }
    const hazard = tasksInstallingDeps(prd0.tasks);
    if (hazard.length > 0) {
      console.error(t("loop.err.sharedInstall", { ids: hazard.join(", "), links: seeded.join(", ") }));
      process.exit(1);
    }
  }

  if (!opts.dryRun) {
    // BEFORE the reap, which force-deletes every cell under .ralphrun: a second
    // run in this workspace would otherwise delete the first one's live
    // worktrees while its executors are still writing into them.
    const holder = claimRunLock(workspace);
    if (holder !== null) {
      // "unknown" is a refusal with no pid to name: the only candidates left at
      // that point are a record we positively judged dead and our own pid, so
      // "wait for pid N" would mean "wait for a process that is not running" or
      // "wait for yourself". Name the file instead, which is what the user can
      // actually act on.
      console.error(
        holder === "unknown"
          ? t("loop.err.lockUnclaimable", { path: workspace, file: join(workspace, ".ralphrun", "run.lock") })
          : t("loop.err.alreadyRunning", { pid: String(holder), path: workspace }),
      );
      process.exit(1);
    }

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
    const willRun = opts.task ? new Set([opts.task]) : sessionRunnableIds(prd0, !!process.stdout.isTTY);
    const browserScope = prd0.tasks.filter((x) => willRun.has(x.id) && !hostMismatch(x.required_host));
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

  const elapsedTracker = createElapsedTracker(performance.now());
  // A tracker holds ONE task slot, so a wave needs one tracker per in-flight
  // task or they overwrite each other's start time. Pause has to reach all of
  // them: a run paused mid-wave must not bill that wall clock to any task.
  const trackers = new Set<ElapsedTracker>([elapsedTracker]);
  const setElapsedPaused = (paused: boolean): void => {
    const now = performance.now();
    for (const tr of trackers) tr.setPaused(paused, now);
  };

  // live dashboard: mount the Ink TUI on a real TTY so log() lines and the
  // RunEvents run/executor already emit have somewhere to land. Non-TTY
  // (pipe/CI) falls back to plain log() output; progress.md always gets the raw
  // log either way. Mounted LAST, so a preflight that exits the process never
  // leaves a pane behind. The REPORTER is wired by runLoop, which also rewires
  // it on a remount — one owner for that, not two.
  const tui =
    !opts.dryRun && process.stdout.isTTY
      ? mount(
          prd0.tasks.map((x) => ({ id: x.id, title: x.title, status: x.status })),
          `${prd0.project} — exec: ${exe} | adv: ${adv}`,
          prd0.project,
          false,
          setElapsedPaused,
        )
      : null;

  return { prdPath, workspace, progress, prd0, cfg, mode, exe, adv, tui, reload, elapsedTracker, trackers, setElapsedPaused };
}

export async function configureAgents(
  cfg: Config,
  prdPath: string,
  configFlag: string | undefined,
  workspace: string,
): Promise<Config> {
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
