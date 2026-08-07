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
  // paths or globs this task is allowed to edit. Declared, not enforced yet: it
  // exists so (a) the plan compiler can refuse overlapping editor scopes between
  // tasks with no dependency edge between them, and (b) the reviewer gets a
  // verifiable contract — taskChangedPaths outside scope is an objective
  // violation instead of an LLM judgement call.
  scope?: string[];
  verify?: string;
  plan?: string;
  planKey?: string;
}

export interface PRD {
  project: string;
  stack: string;
  architecture_notes: string;
  tasks: Task[];
}

/**
 * Every task runnable RIGHT NOW: todo, with every dep already `done`.
 *
 * NOT sessionRunnableIds, which looks like the same fixpoint and is not: that
 * one admits a task whose deps are merely *admitted*, which is correct for a
 * preflight ("could this run at some point this session?") and catastrophic for
 * a scheduler, since it would dispatch T2 while T1 is still executing.
 *
 * The members of the returned array are pairwise UNORDERED — if A depends on B
 * then A is only ready once B is done, and a done B is not itself ready — which
 * is what lets the loop dispatch several of them at once.
 */
export function readyTasks(prd: PRD): Task[] {
  const done = new Set(prd.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return prd.tasks.filter((t) => t.status === "todo" && t.deps.every((d) => done.has(d)));
}

export function nextTask(prd: PRD): Task | null {
  return readyTasks(prd)[0] ?? null;
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
