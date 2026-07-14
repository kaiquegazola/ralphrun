// prd.ts — backlog types, next task picker (recovery/normalize live in prdload.ts)

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  deps: string[];
  retries: number;
  description: string;
  acceptance: string[];
  verify?: string;
}

export interface PRD {
  project: string;
  stack: string;
  architecture_notes: string;
  tasks: Task[];
}

export function nextTask(prd: PRD): Task | null {
  const done = new Set(prd.tasks.filter((t) => t.status === "done").map((t) => t.id));
  for (const t of prd.tasks) {
    if (t.status === "todo" && t.deps.every((d) => done.has(d))) {
      return t;
    }
  }
  return null;
}

export function findTask(prd: PRD, id: string): Task | null {
  return prd.tasks.find((t) => t.id === id) ?? null;
}

// Optimistic set of task ids that COULD execute this session. Start from the
// done tasks, then repeatedly admit any task that can START — todo, or blocked
// when the TTY menus can promote it (retry-blocked / stalled retry) — once all
// its deps are already done/admitted, to a fixpoint. A todo task transitively
// gated by a non-promotable blocked dep never becomes runnable and is correctly
// excluded, so a preflight scoped to this set never demands a tool for work that
// cannot run this session, nor misses work that can.
export function sessionRunnableIds(prd: PRD, canPromoteBlocked: boolean): Set<string> {
  const done = new Set(prd.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const canStart = (t: Task): boolean =>
    (t.status === "todo" || (canPromoteBlocked && t.status === "blocked")) && t.deps.every((d) => done.has(d));
  const willRun = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of prd.tasks) {
      if (done.has(t.id) || willRun.has(t.id) || !canStart(t)) continue;
      willRun.add(t.id);
      done.add(t.id); // admitting t can unblock its dependents on the next sweep
      changed = true;
    }
  }
  return willRun;
}