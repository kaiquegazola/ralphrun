import { hostMismatch, type RequiredHost } from "./host.js";

// prd.ts — backlog types, next task picker (recovery/normalize live in prdload.ts)

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

export type ResourceAccess = "isolated" | "read" | "write" | "reset";

export interface TaskResources {
  database?: ResourceAccess;
  cache?: ResourceAccess;
  ports?: string[];
  services?: string[];
}

export interface ScopeRequest {
  paths: string[];
  reason: string;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  deps: string[];
  retries: number;
  description: string;
  acceptance: string[];
  // paths or globs this task is allowed to edit. ENFORCED: taskrun.ts fails an
  // otherwise-passing task that edited outside it, before the work lands, and
  // feeds the escaped paths into its next attempt. It also exists so (a) the
  // plan compiler can refuse overlapping editor scopes between tasks with no
  // dependency edge between them, and (b) the reviewer gets a verifiable
  // contract — taskChangedPaths outside scope is an objective violation instead
  // of an LLM judgement call. An empty scope declares nothing and so gates
  // nothing (nor does a workspace with no git baseline to diff against).
  scope?: string[];
  /** Paths/globs that this task may edit as a shared integration surface. */
  shared_scope?: string[];
  /** Paths/globs this task must never edit, even when another scope allows them. */
  forbidden_scope?: string[];
  /** Reviewer evidence that the plan needs an explicit scope change. */
  scope_requests?: ScopeRequest[];
  /** Host OS required by this task; omit for portable or cross-platform work. */
  required_host?: RequiredHost;
  /** Explicit concurrency contract. Missing means conservative serial execution. */
  parallel?: "safe" | "exclusive";
  /** External resources the task's verify or implementation may touch. */
  resources?: TaskResources;
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
    (t.status === "todo" || (canPromoteBlocked && t.status === "blocked")) && !hostMismatch(t.required_host) && t.deps.every((d) => done.has(d));
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
