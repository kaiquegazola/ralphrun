// events.ts — tiny typed event bus for the TUI dashboard. Pure, no deps.
// Producers (executor/run/loop) emit RunEvents; the mount store subscribes and
// folds them via controller.reducer. emit() is a no-op when nothing subscribed
// (non-TTY / CI), so producers never branch on whether a dashboard is mounted.

export type Subphase = "advising" | "executing" | "verifying" | "reviewing" | "fixing" | "idle";

export interface RunEvent {
  taskId: string;
  title?: string;
  subphase?: Subphase;
  round?: { n: number; max: number };
  attempt?: { n: number; max: number };
  gates?: { exec?: boolean; tests?: boolean; review?: boolean };
  line?: string; // one output/log line (for the live pane)
  lineSource?: "executor" | "advisor" | "review" | "system";
  status?: "todo" | "doing" | "done" | "blocked" | "retry";
  reason?: string; // when status==="blocked" (e.g. "skipped by user" / "max retries")
  /**
   * The tree object snapshotting the workspace as this task FOUND it
   * (git.captureReviewBase). A host with no dashboard uses it to show a diff
   * that is this task's work and not whatever the user had uncommitted when
   * the run started — the TUI reads the same thing off its own state.
   */
  baseline?: string;
  /**
   * WHERE that baseline was taken — the task's worktree, or the main checkout
   * when this task has no cell of its own. A host cannot infer it: a missing
   * worktree means either "ran in the main checkout" or "the cell was
   * discarded", and those two want opposite diffs.
   */
  baselineDir?: string;
  elapsedMs?: number;
  timeoutMs?: number;
  globalElapsedMs?: number;
  taskElapsedMs?: number;
}

type Listener = (e: RunEvent) => void;
const listeners: Listener[] = [];

export function on(l: Listener): () => void {
  listeners.push(l);
  return () => {
    const i = listeners.indexOf(l);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function emit(e: RunEvent): void {
  for (const l of listeners.slice()) l(e);
}

export function clear(): void {
  listeners.length = 0;
}
