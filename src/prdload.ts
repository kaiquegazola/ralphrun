// prdload.ts — the canonical PRD intake pipeline: parse → normalize → validate.
// Every entry point (loop preflight, wizard run-it-now, studio seed, planner
// replies) routes through here so a broken prd.json never crashes mid-loop.
// NOTE: normalizePrd resets "doing" → "todo" (crash recovery) by default; the
// planner path passes keepDoing so a planner echoing a "doing" task keeps it
// (matching the old prdChat normalizeDraft byte-for-byte).
// fs lives ONLY in loadPrdFile; normalizePrd/validatePrd are pure.

import { readFileSync } from "node:fs";

// aliased: per-task loop vars below are named `t` and would shadow t()
import { t as msg } from "./i18n.js";
import type { PRD } from "./prd.js";

const STATUSES = new Set(["todo", "doing", "done", "blocked"]);

// SAFE coercions only, superset of the old normalizeDraft + recoverAndNormalize:
// invalid/missing status → enum-coerced (case-insensitive) else "todo"; then
// "doing" → "todo" (crash recovery — skipped with keepDoing, the planner path);
// retries non-number → 0; deps/acceptance UNDEFINED → []
// (wrong TYPE untouched — validation rejects). Returns whether anything changed.
export function normalizePrd(obj: unknown, opts?: { keepDoing?: boolean }): boolean {
  const tasks = (obj as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return false;
  let changed = false;
  for (const t of tasks) {
    if (typeof t !== "object" || t === null) continue;
    const task = t as Record<string, unknown>;
    const low = typeof task.status === "string" ? task.status.toLowerCase() : "";
    const status = !STATUSES.has(low) || (low === "doing" && !opts?.keepDoing) ? "todo" : low;
    if (task.status !== status) {
      task.status = status;
      changed = true;
    }
    if (typeof task.retries !== "number") {
      task.retries = 0;
      changed = true;
    }
    if (task.deps === undefined) {
      task.deps = [];
      changed = true;
    }
    if (task.acceptance === undefined) {
      task.acceptance = [];
      changed = true;
    }
  }
  return changed;
}

// Structural validator: top-level shape, per-task shape, unique ids, dep
// references. Errors render in the studio chat pane, so they route through t().
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
    if (!STATUSES.has(t.status as string)) errors.push(msg("prd.err.status", { i }));
    if (typeof t.retries !== "number") errors.push(msg("prd.err.retries", { i }));
    if (typeof t.description !== "string") errors.push(msg("prd.err.description", { i }));
    if (!Array.isArray(t.acceptance)) errors.push(msg("prd.err.acceptance", { i }));
    else if (t.acceptance.some((a) => typeof a !== "string")) errors.push(msg("prd.err.acceptanceItem", { i }));
    if (!Array.isArray(t.deps)) errors.push(msg("prd.err.deps", { i }));
    else for (const d of t.deps) if (!ids.has(d)) errors.push(msg("prd.err.depUnknown", { i, d }));
    if (t.verify !== undefined && typeof t.verify !== "string") errors.push(msg("prd.err.verify", { i }));
  });

  return { ok: errors.length === 0, errors };
}

// seedSafe — the parseable-but-invalid branch below seeds the PRD studio, whose
// render (and the planner prompt) dereference tasks/id/title/description/deps/
// acceptance directly. Coerce wrong-TYPE fields to renderable shapes AFTER
// validation recorded the real errors, so a broken file opens as an editable
// draft instead of crashing the TUI with a raw stack.
function seedSafe(obj: object): PRD {
  const p = obj as Record<string, unknown>;
  if (typeof p.project !== "string") delete p.project; // header falls back to "new project"
  if (!Array.isArray(p.tasks)) p.tasks = [];
  p.tasks = (p.tasks as unknown[]).filter((t) => typeof t === "object" && t !== null);
  for (const t of p.tasks as Record<string, unknown>[]) {
    for (const k of ["id", "title", "description"] as const) if (typeof t[k] !== "string") t[k] = "";
    if (!Array.isArray(t.deps)) t.deps = [];
    if (!Array.isArray(t.acceptance)) t.acceptance = [];
    t.acceptance = (t.acceptance as unknown[]).map(String); // React can't render object children
    if (t.verify !== undefined && typeof t.verify !== "string") delete t.verify;
  }
  return p as unknown as PRD;
}

// ok:false with prd PRESENT = parseable-but-invalid (already normalized and
// made render-safe — seeds the studio); prd ABSENT = unparseable/non-object →
// back-to-filepick flows.
// ok:true carries `normalized` so each caller persists the cleanup itself.
export type PrdLoadResult =
  | { ok: true; prd: PRD; normalized: boolean }
  | { ok: false; errors: string[]; prd?: PRD };

export function loadPrdFile(path: string): PrdLoadResult {
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, errors: [msg("prd.err.json", { msg: e instanceof Error ? e.message : String(e) })] };
  }
  const normalized = normalizePrd(obj);
  const v = validatePrd(obj);
  if (!v.ok) {
    return typeof obj === "object" && obj !== null
      ? { ok: false, errors: v.errors, prd: seedSafe(obj) }
      : { ok: false, errors: v.errors };
  }
  return { ok: true, prd: obj as PRD, normalized };
}
