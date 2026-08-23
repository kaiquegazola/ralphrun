// testing.tsx — the seam every screen test uses.
//
// A screen's only dependency is `../api.ts`, which reaches the main process
// over Electrobun's RPC. There is no main process under vitest, so tests mock
// that module and hand back fixtures. This file holds the fixtures and the
// helper that installs them, so a screen test is three lines of setup.

import type {
  AgentView,
  DecisionView,
  GlobalSettingsView,
  HomeView,
  PrdView,
  ProjectSettingsView,
  ProjectView,
  RunDetailView,
  RunSummary,
  StudioView,
  TaskView,
  TrunkView,
  WorkforceView,
  WorktreeView,
} from "../shared/types.ts";

export const T0 = 1_700_000_000_000;

export function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: "t1",
    title: "Contracts (Valibot)",
    status: "todo",
    deps: [],
    retries: 0,
    wave: 0,
    scope: [],
    ...over,
  };
}

export function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run-1",
    projectId: "p1",
    projectName: "qc-colombia",
    prdPath: "/dev/qc/prd.json",
    prdName: "Launch V1",
    status: "running",
    wave: 2,
    waveCount: 5,
    total: 16,
    done: 4,
    doing: 2,
    blocked: 1,
    startedAt: T0,
    endedAt: null,
    executor: { cli: "codex", model: "gpt-5.6-sol" },
    advisor: { cli: "claude", model: "fable" },
    parallel: 3,
    worktrees: true,
    ...over,
  };
}

export function runDetail(over: Partial<RunDetailView> = {}): RunDetailView {
  return {
    ...run(),
    tasks: [task({ id: "t1", status: "done" }), task({ id: "t2", wave: 1, deps: ["t1"], status: "doing" })],
    timeline: [{ at: T0, taskId: "", kind: "start", label: "start" }],
    focusTaskId: "t2",
    ...over,
  };
}

export function project(over: Partial<ProjectView> = {}): ProjectView {
  return {
    id: "p1",
    name: "qc-colombia",
    dir: "/dev/qc",
    shortDir: "~/dev/qc",
    git: true,
    branch: "main",
    prdCount: 2,
    draftCount: 0,
    runs: [],
    ...over,
  };
}

export function prd(over: Partial<PrdView> = {}): PrdView {
  return {
    path: "/dev/qc/prd.json",
    name: "Launch V1",
    projectId: "p1",
    version: 16,
    taskCount: 16,
    doneCount: 4,
    blockedCount: 0,
    depsOk: true,
    depErrors: [],
    runId: null,
    ...over,
  };
}

export function decision(over: Partial<DecisionView> = {}): DecisionView {
  const kind = over.kind ?? "review-blocked";
  return {
    id: "run-1:t1",
    runId: "run-1",
    projectId: "p1",
    prdPath: "/dev/qc/prd.json",
    taskId: "t1",
    projectName: "qc-colombia",
    prdName: "Launch V1",
    taskTitle: "Contracts (Valibot)",
    kind: "review-blocked",
    reason: "review bloqueado — 3 recusas",
    feedback: "score não pode viver em Question",
    since: T0,
    diffstat: { files: 6, added: 301, removed: 0 },
    // only a task the loop is still HOLDING can be accepted — a stall or a
    // terminal block has no cell left to commit
    canAccept: kind === "review-blocked",
    ...over,
  };
}

export function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    cli: "claude",
    label: "Claude Code",
    initials: "cl",
    color: "#f08a63",
    installed: true,
    loggedIn: true,
    hint: null,
    models: [{ name: "fable", recommended: true }],
    activeTasks: 2,
    ...over,
  };
}

export function workforce(over: Partial<WorkforceView> = {}): WorkforceView {
  return {
    agents: [agent(), agent({ cli: "codex", initials: "cx", color: "#4cc8c0", models: [{ name: "gpt-5.6-sol", recommended: true }] })],
    checkedAt: T0,
    browser: { ok: true, label: "browser de teste presente" },
    ...over,
  };
}

export function home(over: Partial<HomeView> = {}): HomeView {
  return {
    projectCount: 1,
    soleProjectId: null,
    decisions: [],
    runs: [],
    resume: [],
    activity: [],
    workforce: [{ cli: "claude", color: "#f08a63", ok: true, note: null }],
    busy: 0,
    free: 2,
    checkedAt: T0,
    ...over,
  };
}

export function worktree(over: Partial<WorktreeView> = {}): WorktreeView {
  return {
    taskId: "t5",
    path: "/dev/qc/.ralphrun/worktrees/t5",
    shortPath: "worktrees/t5",
    title: "Vendorize Alfheim DS",
    agentCli: "claude",
    state: "active",
    gates: { exec: null, tests: null, review: null },
    note: null,
    files: [{ path: "app/styles/theme.css", added: 171, removed: 0 }],
    totals: { files: 5, added: 412, removed: 0 },
    ...over,
  };
}

export function trunk(over: Partial<TrunkView> = {}): TrunkView {
  return {
    branch: "main",
    commits: [{ sha: "a3f81c2", taskId: "t4", subject: "t4: core domain", ago: "4 minutes ago" }],
    todayCount: 1,
    ...over,
  };
}

export function projectSettings(over: Partial<ProjectSettingsView> = {}): ProjectSettingsView {
  return {
    dir: "/dev/qc",
    configPath: "/dev/qc/ralph.config.json",
    branch: "main",
    branches: ["main", "dev"],
    executor: { cli: "codex", model: "gpt-5.6-sol" },
    advisor: { cli: "claude", model: "fable" },
    maxParallel: 3,
    maxRetries: 3,
    reviewAfter: true,
    worktreePerTask: true,
    commitPerTask: true,
    reviewBlockedPolicy: "block",
    inheritedParallel: 3,
    inheritedRetries: 3,
    worktreesSupported: true,
    ...over,
  };
}

export function globalSettings(over: Partial<GlobalSettingsView> = {}): GlobalSettingsView {
  return {
    configPath: "/home/u/.config/ralphrun/config.json",
    language: "pt-br",
    stallMinutes: 10,
    maxConcurrentRuns: 2,
    notifyDecision: "system",
    notifyMerge: "silent",
    notifyRunEnd: "sound",
    theme: "dark",
    runDetailMode: "surgical",
    ...over,
  };
}

export function studio(over: Partial<StudioView> = {}): StudioView {
  return {
    prdPath: null,
    projectId: "p1",
    messages: [],
    tasks: [],
    attachments: [],
    status: "idle",
    errors: [],
    dirty: false,
    undoDepth: 0,
    planner: { cli: "claude", model: "fable" },
    depsOk: false,
    ...over,
  };
}
