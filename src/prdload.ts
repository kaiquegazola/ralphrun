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
import type { PRD, ResourceAccess, TaskResources } from "./prd.js";
import { isRequiredHost } from "./host.js";

const STATUSES = new Set(["todo", "doing", "done", "blocked"]);
const RESOURCE_ACCESS = new Set<ResourceAccess>(["isolated", "read", "write", "reset"]);

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
    // STAGED AUTHORING: a skeleton task legitimately omits its description.
    // Defaulting it here (not in the view layer) is what makes every consumer —
    // detail pane, prompt builder, scope gate — type-safe without each one
    // re-guarding the same absent field.
    if (task.description === undefined) {
      task.description = "";
      changed = true;
    }
  }
  return changed;
}

/**
 * One cycle per BACK EDGE — the path that closes at each edge pointing back into
 * the current stack — not every simple cycle. Enumerating those is Johnson's,
 * exponential, and not worth it for a validator that already fails closed on the
 * first cycle it reports.
 *
 * That still avoids the round trip this exists to avoid, because every cycle
 * contains a back edge and every back edge is reported: cut the LAST arrow of
 * every reported path and the backlog is acyclic in ONE pass. Cut a different
 * arrow of a reported path instead (A→B rather than B→A in A→B→A, with C→B also
 * present) and the leftover loop only surfaces on the next run.
 *
 * Iterative colours would be cheaper to reason about, but a backlog is tens of
 * tasks deep, so recursion is fine and the path falls out of the stack. The walk
 * stops descending into a node it has already closed, so a diamond (A→B, A→C,
 * B/C→D) is not mistaken for a cycle.
 */
function findDepCycles(edges: Map<string, string[]>): string[][] {
  const state = new Map<string, "open" | "closed">();
  const path: string[] = [];
  const found: string[][] = [];
  // A cycle is reachable from every node on it, so the same loop would be
  // reported once per entry point without this.
  const seen = new Set<string>();
  const visit = (id: string): void => {
    const s = state.get(id);
    if (s === "closed") return;
    if (s === "open") {
      const cycle = path.slice(path.indexOf(id)).concat(id);
      // canonical key: the members, order-independent, so the same loop entered
      // from B instead of A is recognised as the one already recorded
      const key = JSON.stringify([...cycle].sort());
      if (!seen.has(key)) {
        seen.add(key);
        found.push(cycle);
      }
      return;
    }
    state.set(id, "open");
    path.push(id);
    // the caller filtered every dep down to a key of this same map, so a lookup
    // here cannot miss — and a `?? []` fallback would silently hide it if it did
    for (const d of edges.get(id)!) visit(d);
    path.pop();
    state.set(id, "closed");
  };
  for (const id of edges.keys()) visit(id);
  return found;
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
 * This is a GATE (see taskrun.ts): a task that edits outside its declared scope
 * invalidated the proof its wave was scheduled on, so the merge is no longer
 * known to be safe and the task fails.
 *
 * An empty scope declares nothing and so escapes nothing, which is what bounds
 * the blast radius: only a backlog authored WITH scopes is gated, and every one
 * written before the field existed runs exactly as before.
 *
 * The cost is real and worth naming: a scope is the planner's guess, so a task
 * that legitimately has to touch a shared file fails until the plan says so. In
 * THIS repo, MsgKey derives from the `en` dict, so any task adding a message
 * must edit src/i18n.ts — a plan for this project has to put it in scope.
 */
export function pathsOutsideScope(paths: string[], scope: string[]): string[] {
  const allowed = scope.map((p) => globToRegExp(p));
  if (allowed.length === 0) return [];
  return paths.filter((p) => {
    const norm = p.replace(/^\.\//, "");
    return !allowed.some((re) => re.test(norm));
  });
}

/**
 * The directory a scope pattern needs BEFORE this task can create anything
 * underneath it. A literal file checks its parent; a `**` suffix checks the
 * directory before the suffix's literal leaf, because that leaf is exactly
 * what the task may be creating. A wildcard filename still checks its parent.
 *
 * This is deliberately a prefix check, not a glob expansion: an absent leaf
 * is a valid task target, while an absent parent is the typo that makes the
 * scope gate discard a perfectly good implementation after the agent paid for
 * it. The caller resolves the returned repo-relative path against the workspace.
 */
export function literalScopeDirectoryPrefix(pattern: string): string {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  const wildcardAt = parts.findIndex((part) => /[*?\[\]]/.test(part));
  if (wildcardAt === -1) return parts.slice(0, -1).join("/");
  if (parts[wildcardAt] === "**") return parts.slice(0, Math.max(0, wildcardAt - 1)).join("/");
  return parts.slice(0, wildcardAt).join("/");
}

/** the heading the run writes under, so a human can see which half is theirs */
export const LEARNED_HEADING = "## Learned during runs";
// The notes go into EVERY later prompt, so this section is a standing tax on the
// whole run. Capped so it cannot become the accumulated-summary memory the fresh
// context rule exists to prevent — arriving one honest line at a time.
const MAX_LEARNED_CHARS = 1200;

/**
 * Append a fact a run learned to the architecture notes.
 *
 * Returns the new notes, or null when nothing should change: a duplicate, or a
 * section already at its cap. Null is not a failure — a full section means the
 * human should curate, and silently dropping the OLDEST entry would delete
 * something a person may have promoted there deliberately.
 *
 * Pure: the caller owns the write, because prd.json has exactly one writer rule.
 */
export function appendLearnedNote(notes: string, taskId: string, note: string): string | null {
  const line = `- ${taskId}: ${note.trim()}`;
  if (!note.trim()) return null;
  // Compared on the NOTE body, not the whole line: the same fact learned twice
  // arrives under two different task ids and is still the same fact.
  const idx = notes.indexOf(LEARNED_HEADING);
  const existing = idx === -1 ? "" : notes.slice(idx + LEARNED_HEADING.length);
  if (existing.includes(note.trim())) return null;
  if (existing.length + line.length + 1 > MAX_LEARNED_CHARS) return null;
  return idx === -1 ? `${notes.trimEnd()}\n\n${LEARNED_HEADING}\n${line}\n` : `${notes.trimEnd()}\n${line}\n`;
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
  // STAGED AUTHORING: a planner working in phases emits a SKELETON first
  // (id/title/deps only) and expands tasks over later turns. Draft mode judges
  // the skeleton's shape — ids, deps, cycles — and forgives the fields a later
  // expansion fills (description, acceptance). The RUN gates never pass this
  // flag: a task that reaches the loop without its details is exactly what
  // verifyRequired exists to catch.
  draft?: boolean;
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
    // draft forgives only ABSENT fields (the skeleton omits them); a field that
    // IS present must still be well-typed, or render/code downstream chokes.
    if (!(opts?.draft && t.description === undefined) && typeof t.description !== "string")
      errors.push(msg("prd.err.description", { i }));
    if (opts?.draft && t.acceptance === undefined) {
      // omitted wholesale: fine in a skeleton
    } else if (!Array.isArray(t.acceptance)) {
      errors.push(msg("prd.err.acceptance", { i }));
    } else if (t.acceptance.some((a) => typeof a !== "string")) {
      errors.push(msg("prd.err.acceptanceItem", { i }));
    }
    if (!Array.isArray(t.deps)) errors.push(msg("prd.err.deps", { i }));
    else for (const d of t.deps) if (!ids.has(d)) errors.push(msg("prd.err.depUnknown", { i, d }));
    if (t.scope !== undefined) {
      if (!Array.isArray(t.scope)) errors.push(msg("prd.err.scope", { i }));
      else if (t.scope.some((s) => typeof s !== "string")) errors.push(msg("prd.err.scopeItem", { i }));
    }
    if (t.required_host !== undefined && !isRequiredHost(t.required_host)) errors.push(msg("prd.err.requiredHost", { i }));
    if (t.parallel !== undefined && t.parallel !== "safe" && t.parallel !== "exclusive")
      errors.push(msg("prd.err.parallel", { i }));
    if (t.resources !== undefined) {
      const r = t.resources as Record<string, unknown>;
      if (!r || typeof r !== "object" || Array.isArray(r)) errors.push(msg("prd.err.resources", { i }));
      else {
        for (const key of ["database", "cache"] as const)
          if (r[key] !== undefined && !RESOURCE_ACCESS.has(r[key] as ResourceAccess))
            errors.push(msg("prd.err.resourceAccess", { i, key }));
        for (const key of ["ports", "services"] as const)
          if (r[key] !== undefined && (!Array.isArray(r[key]) || r[key].some((x) => typeof x !== "string")))
            errors.push(msg("prd.err.resourceList", { i, key }));
      }
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
  for (const cycle of findDepCycles(edges)) errors.push(msg("prd.err.depCycle", { cycle: cycle.join(" -> ") }));

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
    if (t.parallel !== undefined && t.parallel !== "safe" && t.parallel !== "exclusive") delete t.parallel;
    if (t.resources !== undefined) {
      const r = t.resources as Record<string, unknown>;
      if (!r || typeof r !== "object" || Array.isArray(r)) delete t.resources;
      else {
        const safe: TaskResources = {};
        for (const key of ["database", "cache"] as const)
          if (RESOURCE_ACCESS.has(r[key] as ResourceAccess)) safe[key] = r[key] as ResourceAccess;
        for (const key of ["ports", "services"] as const)
          if (Array.isArray(r[key]) && r[key].every((x) => typeof x === "string")) safe[key] = r[key] as string[];
        if (Object.keys(safe).length) t.resources = safe;
        else delete t.resources;
      }
    }
    if (t.required_host !== undefined && !isRequiredHost(t.required_host)) delete t.required_host;
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
  | { ok: true; prd: PRD; normalized: boolean; warnings: string[] }
  | { ok: false; errors: string[]; prd?: PRD };

export function loadPrdFile(path: string, opts?: NormalizePrdOptions): PrdLoadResult {
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, errors: [msg("prd.err.json", { msg: e instanceof Error ? e.message : String(e) })] };
  }
  const normalized = normalizePrd(obj, opts);
  // The FILE is authoring output: a SKELETON backlog (staged authoring) must
  // load and run — the JIT expansion fills the details mid-loop, and the
  // unverified-warnings below keep the operator informed. Present-but-wrong
  // fields still fail (draft forgives absence, not corruption).
  const v = validatePrd(obj, { draft: true });
  if (!v.ok) {
    return typeof obj === "object" && obj !== null
      ? { ok: false, errors: v.errors, prd: seedSafe(obj) }
      : { ok: false, errors: v.errors };
  }
  // Whole-PRD posture check, distinct from run.ts's per-task "this task has no
  // gate" line: a backlog that is MOSTLY unverified is a plan problem, and the
  // operator has to see it before the loop starts.
  //
  // RETURNED rather than printed. Intake runs before any logger exists, so this
  // used to go straight to stderr — where it scrolls past under the TUI and,
  // worse, never reaches progress.md, which is the only record an unattended run
  // leaves behind. The caller decides; startRun logs it.
  const warnings: string[] = [];
  const unverified = unverifiedTaskIndexes((obj as { tasks: Record<string, unknown>[] }).tasks);
  if (unverified.length > 0) {
    warnings.push(msg("prd.warn.noVerify", { n: unverified.length, total: (obj as PRD).tasks.length }));
  }
  return { ok: true, prd: obj as PRD, normalized, warnings };
}
