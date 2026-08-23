// settings.ts — the two scopes turn 3 designed: the PROJECT's ralph.config.json
// and ralphrun's own global config. Both are files the CLI already reads, so a
// change made here is a change the next `ralphrun --prd …` run obeys too — the
// GUI is not a second source of configuration.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULTS, loadConfig, type Config } from "../../../src/config.js";
import { git, gitOut } from "../../../src/git.js";
import { configPath, loadUserConfig, saveUserConfig } from "../../../src/userconfig.js";
import { loadAppSettings, saveAppSettings } from "./appsettings.ts";
import { findPrdFiles } from "./prds.ts";
import { supportsWorktrees } from "./projects.ts";
import { activeRuns } from "./runs.ts";
import { currentBranch, getProject } from "./registry.ts";
import type { GlobalSettingsView, ProjectSettingsView } from "../shared/types.ts";

/**
 * One config per project, at its root — where the core looks when it resolves
 * ralph.config.json next to the PRD, because every backlog the app writes lives
 * at the root too. So the file this screen edits is the file a plain
 * `ralphrun --prd …` reads.
 */
export function projectConfigPath(projectDir: string): string {
  return join(projectDir, "ralph.config.json");
}

function readRaw(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // an ARRAY is typeof "object" too, and adding properties to one is silently
    // dropped by JSON.stringify — the save would report success and write nothing
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function gitVersion(dir: string): string | null {
  return (gitOut(dir, "--version") ?? "").replace("git version ", "") || null;
}

function hasHead(dir: string): boolean {
  return gitOut(dir, "rev-parse", "--verify", "--quiet", "HEAD") !== null;
}

function branches(dir: string): string[] {
  const out = gitOut(dir, "branch", "--format=%(refname:short)");
  return out ? out.split("\n").map((b) => b.trim()).filter(Boolean) : [];
}

function effectiveConfig(projectDir: string): Config {
  // the same layering the loop uses: defaults < global user config < this file
  const prd = findPrdFiles(projectDir)[0] ?? join(projectDir, "prd.json");
  const cfgPath = projectConfigPath(projectDir);
  try {
    return loadConfig(prd, existsSync(cfgPath) ? cfgPath : undefined, {});
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function projectSettings(projectId: string): ProjectSettingsView {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  const cfg = effectiveConfig(project.dir);
  const user = loadUserConfig();
  return {
    dir: project.dir,
    configPath: projectConfigPath(project.dir),
    branch: currentBranch(project.dir),
    branches: branches(project.dir),
    executor: cfg.executor,
    advisor: cfg.advisor,
    maxParallel: cfg.max_parallel_tasks ?? 1,
    maxRetries: cfg.max_retries_per_task,
    reviewAfter: cfg.review_after,
    worktreePerTask: !!cfg.worktree_per_task,
    commitPerTask: cfg.commit_per_task,
    reviewBlockedPolicy: cfg.review_blocked_policy ?? "block",
    // what the row would fall back to if the project stopped overriding it —
    // this is what the "herda ⌂ 1" badge reports. It is the CORE default, not
    // an app preference: the loop reads ralph.config.json and nothing else.
    inheritedParallel: DEFAULTS.max_parallel_tasks ?? 1,
    inheritedRetries: user.max_retries_per_task ?? DEFAULTS.max_retries_per_task,
    // AND a HEAD: `git worktree add` needs a commit to cut from, so a freshly
    // `git init`-ed project cannot do worktrees (or parallelism) until its
    // first commit exists, whatever the git version says.
    worktreesSupported: supportsWorktrees(gitVersion(project.dir)) && hasHead(project.dir),
  };
}

export function saveProjectSettings(projectId: string, patch: Partial<ProjectSettingsView>): void {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  const path = projectConfigPath(project.dir);
  const raw = readRaw(path);

  if (patch.executor) raw.executor = patch.executor;
  if (patch.advisor !== undefined) raw.advisor = patch.advisor;
  if (patch.maxParallel !== undefined) raw.max_parallel_tasks = patch.maxParallel;
  if (patch.maxRetries !== undefined) raw.max_retries_per_task = patch.maxRetries;
  if (patch.reviewAfter !== undefined) raw.review_after = patch.reviewAfter;
  if (patch.commitPerTask !== undefined) raw.commit_per_task = patch.commitPerTask;
  if (patch.reviewBlockedPolicy !== undefined) raw.review_blocked_policy = patch.reviewBlockedPolicy;
  if (patch.worktreePerTask !== undefined) {
    raw.worktree_per_task = patch.worktreePerTask;
    // The core REFUSES parallelism without worktrees (two executors in one
    // checkout is data loss), so turning worktrees off has to bring the knob
    // down with it or the next run dies on a config error the user never saw.
    if (!patch.worktreePerTask) raw.max_parallel_tasks = 1;
  }
  if (patch.branch) {
    const current = currentBranch(project.dir);
    if (patch.branch !== current) {
      // NOT while a run is going. A worktree run cherry-picks each approved
      // task onto whatever branch is checked out at that moment, so switching
      // underneath one lands finished work on a trunk it never targeted.
      if (activeRuns().some((r) => r.projectId === projectId)) {
        throw new Error(`há uma run ativa em ${project.name} — pare a run antes de trocar de branch`);
      }
      // A checkout can also REFUSE — the branch was deleted, the tree is dirty.
      // Saying nothing would leave the user starting a run against a branch the
      // settings screen claims is active and the repository never switched to.
      if (git(project.dir, "checkout", patch.branch) !== 0) {
        throw new Error(`não deu para trocar para a branch ${patch.branch} — confira se ela existe e se a árvore está limpa`);
      }
    }
  }

  // The core REFUSES this pair at load: the commit is how a task's work leaves
  // its worktree, so worktrees-without-commits is a config that cannot run.
  // Settling it here means the user never gets a run that dies on startup for a
  // combination the UI let them pick.
  if (raw.worktree_per_task === true) raw.commit_per_task = true;

  // atomic: this file is shared with the CLI, and a run that reads it midway
  // through a truncate-then-write would die on half a JSON object
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
  renameSync(tmp, path);
}

export function globalSettings(): GlobalSettingsView {
  const user = loadUserConfig();
  const app = loadAppSettings();
  return {
    configPath: configPath(),
    language: user.language ?? "pt-br",
    stallMinutes: app.stallMinutes,
    maxConcurrentRuns: app.maxConcurrentRuns,
    notifyDecision: app.notifyDecision,
    notifyMerge: app.notifyMerge,
    notifyRunEnd: app.notifyRunEnd,
    theme: app.theme,
    runDetailMode: app.runDetailMode,
  };
}

export function saveGlobalSettings(patch: Partial<GlobalSettingsView>): void {
  if (patch.language) saveUserConfig({ language: patch.language });
  saveAppSettings({
    stallMinutes: patch.stallMinutes,
    maxConcurrentRuns: patch.maxConcurrentRuns,
    notifyDecision: patch.notifyDecision,
    notifyMerge: patch.notifyMerge,
    notifyRunEnd: patch.notifyRunEnd,
    theme: patch.theme,
    runDetailMode: patch.runDetailMode,
  });
}

/** The global stall threshold, in minutes. 0 = a silent task is never escalated. */
export function stallMinutes(): number {
  return loadAppSettings().stallMinutes;
}
