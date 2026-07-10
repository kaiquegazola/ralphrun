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
  line?: string; // one executor output line (for the live pane)
  status?: "doing" | "done" | "blocked" | "retry";
  reason?: string; // when status==="blocked" (e.g. "skipped by user" / "max retries")
  elapsedMs?: number;
  timeoutMs?: number;
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
