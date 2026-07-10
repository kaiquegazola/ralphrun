// prd.ts — backlog types, recovery/normalize, next task picker

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

export function recoverAndNormalize(prd: PRD): boolean {
  let changed = false;
  for (const t of prd.tasks) {
    const defaults: Array<[keyof Task, unknown]> = [
      ["status", "todo"],
      ["retries", 0],
      ["deps", []],
      ["acceptance", []],
    ];
    for (const [key, def] of defaults) {
      if (t[key] === undefined) {
        // @ts-expect-error generic default fill
        t[key] = def;
        changed = true;
      }
    }
    if (t.status === "doing") {
      t.status = "todo";
      changed = true;
    }
  }
  return changed;
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