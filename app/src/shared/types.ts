// types.ts — the shape of everything that crosses the RPC seam. Imported by
// both the bun main process and the webview, so it must stay free of runtime
// imports from either side.

export type TaskStatus = "todo" | "doing" | "done" | "blocked";
export type Gate = "exec" | "tests" | "review";
export type Subphase = "advising" | "executing" | "verifying" | "reviewing" | "fixing" | "idle";

// queued = admitted but not spawned: the core takes a run lock per workspace,
// so a project already running one backlog makes the next one wait.
export type RunStatus = "queued" | "running" | "paused" | "attention" | "done" | "failed";

export interface AgentSpecView {
  cli: string;
  model: string;
}

export interface ProjectView {
  id: string;
  name: string;
  dir: string;
  shortDir: string;
  git: boolean;
  branch: string | null;
  prdCount: number;
  draftCount: number;
  runs: RunSummary[];
}

export interface PrdView {
  path: string;
  name: string;
  projectId: string;
  version: number; // undo depth is not tracked on disk; this is the task-count generation
  taskCount: number;
  doneCount: number;
  blockedCount: number;
  depsOk: boolean;
  depErrors: string[];
  runId: string | null;
}

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  deps: string[];
  retries: number;
  wave: number;
  scope: string[];
  verify?: string;
  // live, only while a run is attached
  subphase?: Subphase;
  gates?: { exec?: boolean; tests?: boolean; review?: boolean };
  round?: { n: number; max: number };
  attempt?: { n: number; max: number };
  elapsedMs?: number;
  agentCli?: string;
  reason?: string;
  lastLineAt?: number;
}

export interface StreamLine {
  at: number;
  text: string;
  source: "executor" | "advisor" | "review" | "system";
}

export interface TimelineEvent {
  at: number;
  taskId: string;
  kind: "start" | "pass" | "fail" | "merge" | "blocked" | "done";
  label: string;
}

export interface RunSummary {
  id: string;
  projectId: string;
  projectName: string;
  prdPath: string;
  prdName: string;
  status: RunStatus;
  wave: number;
  waveCount: number;
  total: number;
  done: number;
  doing: number;
  blocked: number;
  startedAt: number;
  endedAt: number | null;
  executor: AgentSpecView;
  advisor: AgentSpecView | null;
  parallel: number;
  worktrees: boolean;
}

export interface RunDetailView extends RunSummary {
  tasks: TaskView[];
  timeline: TimelineEvent[];
  focusTaskId: string | null;
}

export interface DecisionView {
  id: string;
  /** null when the decision outlived its run — see listDecisions */
  runId: string | null;
  projectId: string;
  prdPath: string;
  taskId: string;
  projectName: string;
  prdName: string;
  taskTitle: string;
  kind: "review-blocked" | "stall" | "blocked";
  reason: string;
  feedback: string | null;
  since: number;
  diffstat: { files: number; added: number; removed: number } | null;
  /**
   * Is "aceitar" a real option? Only while the run is PARKED on this task: the
   * loop then commits and cherry-picks through its own path. Once a run has
   * blocked a task for good its worktree is gone, and accepting could only mark
   * absent work as delivered.
   */
  canAccept: boolean;
}

export interface WorktreeView {
  taskId: string;
  path: string;
  shortPath: string;
  title: string;
  agentCli: string | null;
  state: "active" | "attention" | "merged";
  gates: { exec: boolean | null; tests: boolean | null; review: boolean | null };
  note: string | null;
  files: { path: string; added: number; removed: number }[];
  totals: { files: number; added: number; removed: number };
}

export interface TrunkView {
  branch: string;
  commits: { sha: string; taskId: string | null; subject: string; ago: string }[];
  todayCount: number;
}

export interface AgentView {
  cli: string;
  label: string;
  initials: string;
  color: string;
  installed: boolean;
  loggedIn: boolean;
  hint: string | null; // the command that fixes it
  models: { name: string; recommended: boolean }[];
  activeTasks: number;
}

export interface WorkforceView {
  agents: AgentView[];
  checkedAt: number;
  browser: { ok: boolean; label: string };
}

export interface ProjectSettingsView {
  dir: string;
  configPath: string;
  branch: string | null;
  branches: string[];
  executor: AgentSpecView;
  advisor: AgentSpecView | null;
  maxParallel: number;
  maxRetries: number;
  reviewAfter: boolean;
  worktreePerTask: boolean;
  commitPerTask: boolean;
  reviewBlockedPolicy: "block" | "accept";
  inheritedParallel: number;
  inheritedRetries: number;
  /** false = this machine's git predates `git worktree`, so the toggle is a lie */
  worktreesSupported: boolean;
}

export interface GlobalSettingsView {
  configPath: string;
  language: "en" | "pt-br";
  stallMinutes: number;
  maxConcurrentRuns: number;
  notifyDecision: "silent" | "system" | "sound";
  notifyMerge: "silent" | "system" | "sound";
  notifyRunEnd: "silent" | "system" | "sound";
  theme: "dark" | "light" | "system";
  runDetailMode: "calm" | "surgical";
}

export interface ChatMessageView {
  role: "you" | "planner" | "error";
  text: string;
}

export interface StudioView {
  prdPath: string | null;
  projectId: string;
  messages: ChatMessageView[];
  tasks: TaskView[];
  attachments: string[];
  status: "idle" | "drafting" | "error";
  errors: string[];
  dirty: boolean;
  undoDepth: number;
  planner: AgentSpecView;
  depsOk: boolean;
}

export interface ActivityItem {
  at: number;
  kind: "merge" | "run-start" | "run-end";
  text: string;
  projectName: string;
}

export interface HomeView {
  /** how many projects are REGISTERED — not how many are busy right now */
  projectCount: number;
  /** the only registered project's id, when there is exactly one */
  soleProjectId: string | null;
  decisions: DecisionView[];
  runs: RunSummary[];
  // runnable = saved AND valid: the play button must not start a run the child
  // would refuse on a skeleton or a broken dep graph
  resume: { prdPath: string; projectId: string; name: string; note: string; runnable: boolean }[];
  activity: ActivityItem[];
  workforce: { cli: string; color: string; ok: boolean; note: string | null }[];
  busy: number;
  free: number;
  checkedAt: number;
}

export interface NewProjectProbe {
  dir: string;
  exists: boolean;
  empty: boolean;
  git: boolean;
  branch: string | null;
  packageManager: string | null;
  gitVersion: string | null;
  worktreesSupported: boolean;
  name: string;
}
