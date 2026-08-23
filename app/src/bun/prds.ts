// prds.ts — a project's backlogs. A PRD is a file at the project ROOT:
// `prd.json` (what `ralphrun init` writes) plus `prd-<name>.json` for the extra
// backlogs the studio authors. Root, because the core resolves
// ralph.config.json next to the PRD — a backlog anywhere else would run on
// defaults for anyone typing `ralphrun --prd …`.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { PRD, Task } from "../../../src/prd.js";
import { loadPrdFile, validatePrd } from "../../../src/prdload.js";
import type { PrdView, TaskView } from "../shared/types.ts";

/**
 * Every candidate backlog file. Non-PRD json is filtered out by the load, which
 * needs project/stack/architecture_notes/tasks — package.json and tsconfig do
 * not accidentally qualify. ROOT only: the core resolves ralph.config.json next
 * to the PRD, so a backlog anywhere else would run on different settings in the
 * CLI than the ones the app's settings screen edits.
 */
export function findPrdFiles(projectDir: string): string[] {
  const out: string[] = [];
  const root = join(projectDir, "prd.json");
  if (existsSync(root)) out.push(root);
  try {
    for (const f of readdirSync(projectDir)) {
      if (f.startsWith("prd-") && f.endsWith(".json")) out.push(join(projectDir, f));
    }
  } catch {
    // an unreadable project dir shows no backlogs rather than crashing the screen
  }
  return out.filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export function readPrd(path: string): PRD | null {
  const res = loadPrdFile(resolve(path));
  return res.ok ? res.prd : (res.prd ?? null);
}

/**
 * Wave index per task: 0 when a task has no deps, otherwise one past the
 * deepest dep. This is the same layering the loop dispatches by — `readyTasks`
 * picks a whole wave at once — so a board drawn from it matches what actually
 * runs. A dep the PRD never declares is treated as depth -1 (validatePrd is
 * what refuses those; the board must still draw).
 */
export function waveOf(tasks: Task[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const walk = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id);
    if (!task) return -1;
    // A cycle is a validation error, not a crash. Returning 0 for a node
    // already on the stack makes the walk TERMINATE; it does not give the
    // cycle's members a meaningful layer (the enclosing frames still add 1, so
    // their waves depend on declaration order). That is fine: validatePrd
    // refuses a cyclic backlog, so those numbers only ever draw a board the
    // deps-ok badge has already marked unrunnable.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = task.deps.length === 0 ? 0 : Math.max(...task.deps.map((dep) => walk(dep) + 1), 0);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  for (const t of tasks) walk(t.id);
  return depth;
}

export function toTaskViews(prd: PRD): TaskView[] {
  const waves = waveOf(prd.tasks);
  return prd.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    deps: t.deps,
    retries: t.retries,
    wave: waves.get(t.id) ?? 0,
    scope: t.scope ?? [],
    verify: t.verify,
  }));
}

/** The wave a run is CURRENTLY on: the shallowest one still holding work. */
export function currentWave(tasks: TaskView[]): number {
  const pending = tasks.filter((t) => t.status !== "done");
  if (pending.length === 0) return waveCount(tasks);
  return Math.min(...pending.map((t) => t.wave)) + 1;
}

export function waveCount(tasks: TaskView[]): number {
  return tasks.length === 0 ? 0 : Math.max(...tasks.map((t) => t.wave)) + 1;
}

export function prdName(path: string, prd: PRD | null): string {
  const file = basename(path).replace(/\.json$/, "");
  const named = prd?.project?.trim();
  return named && named.length > 0 ? named : file;
}

export function toPrdView(projectId: string, path: string, runId: string | null): PrdView | null {
  // an INVALID prd still renders: the project screen's job is to show that a
  // backlog exists and why it cannot run, which needs its tasks and its errors
  const res = loadPrdFile(resolve(path));
  const prd = res.prd;
  if (!prd || !Array.isArray(prd.tasks)) return null;
  // draft: true on purpose. A SKELETON task (no verify/description yet) is not
  // an unfinished backlog the app should refuse — taskrun expands one just in
  // time, mid-loop, which is the whole point of staged authoring. Strict
  // validation here would block a flow the core supports; the studio's own
  // `canSave` is where authoring completeness is judged.
  const v = validatePrd(prd, { draft: true });
  const tasks = prd.tasks;
  return {
    path,
    name: prdName(path, prd),
    projectId,
    version: tasks.length,
    taskCount: tasks.length,
    doneCount: tasks.filter((t) => t.status === "done").length,
    blockedCount: tasks.filter((t) => t.status === "blocked").length,
    depsOk: v.ok,
    depErrors: v.errors,
    runId,
  };
}
