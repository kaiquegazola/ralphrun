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
// retries non-number → 0; deps/acceptance/scope UNDEFINED → []
// (wrong TYPE untouched — validation rejects). Returns whether anything changed.
export interface NormalizePrdOptions {
  keepDoing?: boolean;
}

export function normalizePrd(obj: unknown, opts?: NormalizePrdOptions): boolean {
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
    if (task.scope === undefined) {
      task.scope = [];
      changed = true;
    }
  }
  return changed;
}

// First dependency cycle in the graph, as the path that closes it (T1→T2→T1),
// or null. Iterative colours would be cheaper to reason about, but a backlog is
// tens of tasks deep, so recursion is fine and the path falls out of the stack.
// Only the FIRST cycle is reported: the rest are usually the same knot seen from
// another node, and one named cycle is enough to make the PRD fixable.
function findDepCycle(edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, "open" | "closed">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === "closed") return null;
    if (s === "open") return path.slice(path.indexOf(id)).concat(id);
    state.set(id, "open");
    path.push(id);
    for (const d of edges.get(id) ?? []) {
      const cycle = visit(d);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "closed");
    return null;
  };
  for (const id of edges.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

// Glob → anchored RegExp. "**" crosses directories, "*"/"?" do not. A trailing
// slash means the whole directory ("src/" == "src/**").
function globToRegExp(pattern: string): RegExp {
  const body = normGlob(pattern).replace(/\*\*|[*?]|[.+^${}()|[\]\\]/g, (m) =>
    m === "**" ? ".*" : m === "*" ? "[^/]*" : m === "?" ? "[^/]" : "\\" + m,
  );
  return new RegExp(`^${body}$`);
}

function normGlob(pattern: string): string {
  const p = pattern.trim().replace(/^\.\//, "");
  return p.endsWith("/") ? p + "**" : p;
}

// Deciding whether two globs share a file is exact-cover reasoning; this instead
// expands one and matches the other AS A LITERAL STRING, both ways. It catches
// what plans actually write ("src/**" vs "src/api/handler.ts", "src/*.ts" vs
// "src/db.ts"), and only misses mutual partial wildcards ("src/a*.ts" vs
// "src/*b.ts", which both match src/ab.ts) — a false NEGATIVE, so the cheap
// version never refuses a plan that was fine.
function patternsOverlap(a: string, b: string): boolean {
  if (normGlob(a) === "" || normGlob(b) === "") return false;
  return globToRegExp(a).test(normGlob(b)) || globToRegExp(b).test(normGlob(a));
}

/**
 * Paths a task actually touched that its declared `scope` does not cover.
 *
 * WARN only, deliberately: `scope` is the planner's GUESS, while the merge-back
 * cherry-pick enforces the FACT that two tasks really did edit the same lines.
 * Failing a task on the guess blocks work that would have merged fine — in THIS
 * repo it would block nearly everything, since MsgKey derives from the `en`
 * dict, so any task adding a message must edit src/i18n.ts and no planner puts
 * that in a task's scope. An empty scope declares nothing, so it escapes nothing.
 *
 * ponytail: revisit fail-closed once planner scope declarations stop producing
 * false positives; it is a product call, not a technical one.
 */
export function pathsOutsideScope(paths: string[], scope: string[]): string[] {
  const allowed = scope.map((p) => globToRegExp(p));
  if (allowed.length === 0) return [];
  return paths.filter((p) => {
    const norm = p.replace(/^\.\//, "");
    return !allowed.some((re) => re.test(norm));
  });
}

export interface ScopedTask {
  id: string;
  deps: string[];
  scope: string[];
}

// "Overlapping editor scopes forbidden": two tasks the graph does NOT order can
// run at the same time, so declaring the same files in both is a merge conflict
// the plan compiler can refuse before the loop starts. Tasks joined by a dep
// path — direct OR transitive, A -> B -> C orders A and C — are sequenced, so
// they may overlap freely. Pass EVERY task, not only the scoped ones: an
// unscoped task in the middle of a chain is what makes its ends ordered.
export function overlappingScopePairs(tasks: ScopedTask[]): { a: string; b: string; pa: string; pb: string }[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, Set<string>>();
  // deps point at what must come FIRST, so reachability along them is exactly
  // "ordered before". Seeding the memo before recursing keeps a cyclic plan from
  // spinning here; a cycle is already its own error, so the partial closure it
  // yields never decides anything.
  const orderedBefore = (id: string): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    const out = new Set<string>();
    memo.set(id, out);
    for (const d of byId.get(id)?.deps ?? []) {
      out.add(d);
      for (const x of orderedBefore(d)) out.add(x);
    }
    return out;
  };

  const found: { a: string; b: string; pa: string; pb: string }[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (a.scope.length === 0 || b.scope.length === 0) continue;
      if (orderedBefore(a.id).has(b.id) || orderedBefore(b.id).has(a.id)) continue;
      // one pair, one error: listing every colliding glob buries the fix
      const pa = a.scope.find((p) => b.scope.some((q) => patternsOverlap(p, q)));
      if (pa !== undefined) found.push({ a: a.id, b: b.id, pa, pb: b.scope.find((q) => patternsOverlap(pa, q))! });
    }
  }
  return found;
}

// tasks with no verify command, by index. Feeds two different postures: a hard
// error while a PRD is being AUTHORED (requireVerify), a warning when an already
// existing backlog is loaded — see validatePrd/loadPrdFile below.
function unverifiedTaskIndexes(tasks: Record<string, unknown>[]): number[] {
  return tasks.flatMap((t, i) =>
    t && typeof t === "object" && typeof t.verify === "string" && t.verify.trim() !== "" ? [] : [i],
  );
}

export interface ValidatePrdOptions {
  // "unverified branches forbidden": a task that can never fail its own gate is
  // a hole in the loop. Hard error on the authoring paths (planner reply,
  // studio finalize) via the tui shim; the load path only warns, because every
  // backlog written before this rule exists would otherwise stop loading.
  requireVerify?: boolean;
}

// Structural validator: top-level shape, per-task shape, unique ids, dep
// references, dep cycles. Errors render in the studio chat pane, so they route
// through t().
export function validatePrd(obj: unknown, opts?: ValidatePrdOptions): { ok: boolean; errors: string[] } {
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
    if (t.scope !== undefined) {
      if (!Array.isArray(t.scope)) errors.push(msg("prd.err.scope", { i }));
      else if (t.scope.some((s) => typeof s !== "string")) errors.push(msg("prd.err.scopeItem", { i }));
    }
    if (t.verify !== undefined && typeof t.verify !== "string") errors.push(msg("prd.err.verify", { i }));
    if (t.plan !== undefined && typeof t.plan !== "string") errors.push(msg("prd.err.plan", { i }));
    if (t.planKey !== undefined && typeof t.planKey !== "string") errors.push(msg("prd.err.planKey", { i }));
  });

  if (opts?.requireVerify) {
    for (const i of unverifiedTaskIndexes(tasks)) errors.push(msg("prd.err.verifyRequired", { i }));
  }

  // cycle check runs on the resolvable edges only (known ids, string deps), so a
  // reported cycle is always real. Without it a cyclic backlog validates, then
  // nextTask returns null forever and the run dies blaming "no runnable tasks"
  // when the PRD itself is unsatisfiable.
  const edges = new Map<string, string[]>();
  const scoped: ScopedTask[] = [];
  for (const t of tasks) {
    if (!t || typeof t !== "object" || typeof t.id !== "string" || edges.has(t.id)) continue;
    const raw = Array.isArray(t.deps) ? t.deps : [];
    const deps = raw.filter((d): d is string => typeof d === "string" && ids.has(d));
    edges.set(t.id, deps);
    const scope = Array.isArray(t.scope) ? t.scope.filter((s): s is string => typeof s === "string") : [];
    scoped.push({ id: t.id, deps, scope });
  }
  const cycle = findDepCycle(edges);
  if (cycle) errors.push(msg("prd.err.depCycle", { cycle: cycle.join(" -> ") }));

  for (const o of overlappingScopePairs(scoped)) errors.push(msg("prd.err.scopeOverlap", o));

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
    if (t.plan !== undefined && typeof t.plan !== "string") delete t.plan;
    if (t.planKey !== undefined && typeof t.planKey !== "string") delete t.planKey;
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

export function loadPrdFile(path: string, opts?: NormalizePrdOptions): PrdLoadResult {
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, errors: [msg("prd.err.json", { msg: e instanceof Error ? e.message : String(e) })] };
  }
  const normalized = normalizePrd(obj, opts);
  const v = validatePrd(obj);
  if (!v.ok) {
    return typeof obj === "object" && obj !== null
      ? { ok: false, errors: v.errors, prd: seedSafe(obj) }
      : { ok: false, errors: v.errors };
  }
  // Whole-PRD posture check, distinct from run.ts's per-task "this task has no
  // gate" line: a backlog that is MOSTLY unverified is a plan problem, and the
  // operator has to see it before the loop starts. Straight to stderr because
  // intake happens before any logger or TUI exists.
  const unverified = unverifiedTaskIndexes((obj as { tasks: Record<string, unknown>[] }).tasks);
  if (unverified.length > 0) {
    console.error(msg("prd.warn.noVerify", { n: unverified.length, total: (obj as PRD).tasks.length }));
  }
  return { ok: true, prd: obj as PRD, normalized };
}
