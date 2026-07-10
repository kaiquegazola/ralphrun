// validatePrd.ts — structural validator for a PRD object.
// Checks top-level shape, per-task shape, unique ids, and dep references.
// Errors render in the studio chat pane, so they route through t().

// aliased: the per-task forEach param below is named `t` and would shadow t()
import { t as msg } from "../../i18n.js";
import type { PRD } from "../../prd.js";

const STATUSES = ["todo", "doing", "done", "blocked"];

export function validatePrd(obj: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof obj !== "object" || obj === null) return { ok: false, errors: [msg("prd.err.notObject")] };
  const p = obj as Record<string, unknown>;
  if (typeof p.project !== "string") errors.push(msg("prd.err.project"));
  if (typeof p.stack !== "string") errors.push(msg("prd.err.stack"));
  if (typeof p.architecture_notes !== "string") errors.push(msg("prd.err.arch"));
  if (!Array.isArray(p.tasks)) {
    errors.push(msg("prd.err.tasksArray"));
    return { ok: false, errors };
  }

  const tasks = p.tasks as Record<string, unknown>[];
  // an empty backlog is structurally fine but useless — the run loop would report
  // "all tasks done" immediately. Block it so it can't be finalized.
  if (tasks.length === 0) errors.push(msg("prd.err.noTasks"));
  // first pass: collect every declared id so deps can reference later tasks
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t && typeof t === "object" && typeof t.id === "string") ids.add(t.id);
  }

  const seen = new Set<string>();
  tasks.forEach((t, i) => {
    if (typeof t !== "object" || t === null) {
      errors.push(msg("prd.err.taskObject", { i }));
      return;
    }
    if (typeof t.id !== "string") errors.push(msg("prd.err.id", { i }));
    else if (seen.has(t.id)) errors.push(msg("prd.err.dupId", { id: t.id }));
    else seen.add(t.id);
    if (typeof t.title !== "string") errors.push(msg("prd.err.title", { i }));
    if (!STATUSES.includes(t.status as string)) errors.push(msg("prd.err.status", { i }));
    if (typeof t.retries !== "number") errors.push(msg("prd.err.retries", { i }));
    if (typeof t.description !== "string") errors.push(msg("prd.err.description", { i }));
    if (!Array.isArray(t.acceptance)) errors.push(msg("prd.err.acceptance", { i }));
    if (!Array.isArray(t.deps)) errors.push(msg("prd.err.deps", { i }));
    else for (const d of t.deps) if (!ids.has(d)) errors.push(msg("prd.err.depUnknown", { i, d }));
  });

  return { ok: errors.length === 0, errors };
}

export type { PRD };
