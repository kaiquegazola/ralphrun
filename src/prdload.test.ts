// prdload.test.ts — normalizePrd coercions + changed-flag, loadPrdFile parse/
// normalize/validate outcomes (fs mocked). validatePrd branches are covered by
// validatePrd.test.ts through the tui shim.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import {
  appendLearnedNote,
  literalScopeDirectoryPrefix,
  loadPrdFile,
  normalizePrd,
  overlappingScopePairs,
  pathsOutsideScope,
  type ScopedTask,
  validatePrd,
} from "./prdload.js";

const mRead = vi.mocked(readFileSync);

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T1",
    title: "t",
    status: "todo",
    deps: [],
    retries: 0,
    description: "d",
    acceptance: [],
    scope: [],
    verify: "npm test",
    ...over,
  };
}

function prd(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { project: "p", stack: "s", architecture_notes: "a", tasks: [task()], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizePrd", () => {
  it("returns false when tasks is not an array (or obj is not an object)", () => {
    expect(normalizePrd(prd({ tasks: {} }))).toBe(false);
    expect(normalizePrd(null)).toBe(false);
    expect(normalizePrd(42)).toBe(false);
  });

  it("skips non-object task entries", () => {
    expect(normalizePrd(prd({ tasks: [42, null] }))).toBe(false);
  });

  it("coerces invented statuses case-insensitively, else todo", () => {
    const p = prd({ tasks: [task({ status: "PENDING" }), task({ id: "T2", status: "Done" }), task({ id: "T3" })] });
    expect(normalizePrd(p)).toBe(true);
    const tasks = p.tasks as Record<string, unknown>[];
    expect(tasks[0].status).toBe("todo");
    expect(tasks[1].status).toBe("done");
    expect(tasks[2].status).toBe("todo");
  });

  it("coerces a missing/non-string status to todo", () => {
    const p = prd({ tasks: [task({ status: undefined }), task({ id: "T2", status: 7 })] });
    expect(normalizePrd(p)).toBe(true);
    const tasks = p.tasks as Record<string, unknown>[];
    expect(tasks[0].status).toBe("todo");
    expect(tasks[1].status).toBe("todo");
  });

  it("resets doing -> todo (crash recovery)", () => {
    const p = prd({ tasks: [task({ status: "doing" })] });
    expect(normalizePrd(p)).toBe(true);
    expect((p.tasks as Record<string, unknown>[])[0].status).toBe("todo");
  });

  it("keepDoing preserves an in-flight doing status (planner path)", () => {
    const p = prd({ tasks: [task({ status: "doing" })] });
    expect(normalizePrd(p, { keepDoing: true })).toBe(false);
    expect((p.tasks as Record<string, unknown>[])[0].status).toBe("doing");
  });

  it("fills non-number retries and undefined deps/acceptance/scope", () => {
    const p = prd({ tasks: [task({ retries: "5", deps: undefined, acceptance: undefined, scope: undefined })] });
    expect(normalizePrd(p)).toBe(true);
    const t0 = (p.tasks as Record<string, unknown>[])[0];
    expect(t0.retries).toBe(0);
    expect(t0.deps).toEqual([]);
    expect(t0.acceptance).toEqual([]);
    expect(t0.scope).toEqual([]);
  });

  it("leaves wrong-TYPE deps/acceptance/scope untouched (validation rejects them)", () => {
    const p = prd({ tasks: [task({ deps: {}, acceptance: "x", scope: "src/" })] });
    expect(normalizePrd(p)).toBe(false);
    const t0 = (p.tasks as Record<string, unknown>[])[0];
    expect(t0.deps).toEqual({});
    expect(t0.acceptance).toBe("x");
    expect(t0.scope).toBe("src/");
  });

  it("returns false on an already-normalized PRD", () => {
    expect(normalizePrd(prd())).toBe(false);
  });
});

describe("overlappingScopePairs", () => {
  const st = (id: string, deps: string[], scope: string[]): ScopedTask => ({ id, deps, scope });

  it("reports two independent tasks that edit the same files", () => {
    const r = overlappingScopePairs([st("A", [], ["src/api/**"]), st("B", [], ["src/api/handler.ts"])]);
    expect(r).toEqual([{ a: "A", b: "B", pa: "src/api/**", pb: "src/api/handler.ts" }]);
  });

  // the whole point of the rule: an edge means the two are ordered, so they can
  // never race for the same file and the overlap is legitimate.
  it("allows overlap between tasks joined by a dependency edge", () => {
    expect(overlappingScopePairs([st("A", [], ["src/db.ts"]), st("B", ["A"], ["src/db.ts"])])).toEqual([]);
  });

  // A -> B -> C orders A and C just as firmly as a direct edge; without the
  // transitive walk this pair would be refused for an overlap that cannot race.
  it("allows overlap across a transitive dependency chain", () => {
    expect(
      overlappingScopePairs([st("A", [], ["src/db.ts"]), st("B", ["A"], []), st("C", ["B"], ["src/db.ts"])]),
    ).toEqual([]);
  });

  // the middle task carries no scope of its own, but dropping it from the input
  // would break the chain and turn an ordered pair into a false conflict
  it("still orders a pair through an unscoped middle task", () => {
    const chain = [st("A", [], ["src/db.ts"]), st("B", ["A"], []), st("C", ["A", "B"], ["src/db.ts"])];
    expect(overlappingScopePairs(chain)).toEqual([]);
  });

  it("distinguishes sibling globs that cannot share a file", () => {
    expect(overlappingScopePairs([st("A", [], ["src/api/**"]), st("B", [], ["src/ui/**"])])).toEqual([]);
    expect(overlappingScopePairs([st("A", [], ["src/*.ts"]), st("B", [], ["src/*.css"])])).toEqual([]);
    expect(overlappingScopePairs([st("A", [], ["src/*.ts"]), st("B", [], ["src/db.ts"])])).toHaveLength(1);
  });

  // validatePrd filters deps down to declared ids before calling this, but the
  // function is exported and takes whatever list it is given: a dangling id has
  // to order nothing rather than throw halfway through the compile.
  it("ignores a dep naming a task outside the list it was given", () => {
    expect(overlappingScopePairs([st("A", ["ghost"], ["x.ts"]), st("B", [], ["x.ts"])])).toHaveLength(1);
  });

  it("matches a single-character wildcard, and reads a dot as a literal dot", () => {
    expect(overlappingScopePairs([st("A", [], ["src/v?/api.ts"]), st("B", [], ["src/v2/api.ts"])])).toHaveLength(1);
    // a scope is a glob, not a regex — the "." must not stand in for the "x"
    expect(overlappingScopePairs([st("A", [], ["src/a.ts"]), st("B", [], ["src/axts"])])).toEqual([]);
  });

  it("treats a trailing slash and a ./ prefix as the same directory", () => {
    expect(overlappingScopePairs([st("A", [], ["src/"]), st("B", [], ["./src/db.ts"])])).toHaveLength(1);
  });

  it("ignores tasks with an empty scope — nothing declared, nothing to collide", () => {
    expect(overlappingScopePairs([st("A", [], []), st("B", [], [])])).toEqual([]);
    expect(overlappingScopePairs([st("A", [], [""]), st("B", [], [" "])])).toEqual([]);
  });

  // a cyclic plan is rejected by the cycle check anyway; this only pins that the
  // memoized walk terminates instead of recursing forever
  it("terminates on a cyclic graph", () => {
    expect(overlappingScopePairs([st("A", ["B"], ["x.ts"]), st("B", ["A"], ["x.ts"])])).toEqual([]);
  });
});

describe("loadPrdFile", () => {
  it("unparseable JSON -> ok:false with an invalid-JSON message, no prd", () => {
    mRead.mockReturnValue("{oops");
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^invalid JSON: /);
      expect(r.prd).toBeUndefined();
    }
    expect(mRead).toHaveBeenCalledWith("/x/prd.json", "utf8");
  });

  it("fs throw -> ok:false invalid-JSON message (non-Error stringified)", () => {
    mRead.mockImplementation(() => {
      throw "boom";
    });
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toBe("invalid JSON: boom");
  });

  it("parseable non-object (42) -> ok:false with prd ABSENT", () => {
    mRead.mockReturnValue("42");
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("prd must be an object");
      expect(r.prd).toBeUndefined();
    }
  });

  it("parseable-but-invalid object -> ok:false with the normalized prd PRESENT", () => {
    mRead.mockReturnValue(JSON.stringify(prd({ project: 1, tasks: [task({ status: "PENDING" })] })));
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("project must be a string");
      expect(r.prd).toBeDefined();
      // normalization already ran on the seeded object
      expect(r.prd?.tasks[0].status).toBe("todo");
    }
  });

  it("seeds a render-safe prd: wrong-type fields coerced AFTER errors are recorded", () => {
    mRead.mockReturnValue(
      JSON.stringify({
        project: 5,
        stack: "s",
        architecture_notes: "a",
        tasks: [
          42,
          null,
          { id: 1, title: 2, description: 3, deps: "x", acceptance: [1, { a: 1 }], verify: 42, plan: 42, planKey: 42, status: "todo" },
          { acceptance: "x" },
        ],
      }),
    );
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0); // the real errors were recorded first
      const p = r.prd!;
      expect(p.project).toBeUndefined();
      expect(p.tasks).toHaveLength(2); // non-object entries dropped
      expect(p.tasks[0]).toMatchObject({ id: "", title: "", description: "", deps: [] });
      expect(p.tasks[0].acceptance).toEqual(["1", "[object Object]"]); // stringified for render
      expect(p.tasks[0].verify).toBeUndefined();
      expect(p.tasks[0].plan).toBeUndefined();
      expect(p.tasks[0].planKey).toBeUndefined();
      expect(p.tasks[1].acceptance).toEqual([]);
    }
  });

  it("seeds tasks:[] when tasks is missing or not an array (studio must not crash)", () => {
    mRead.mockReturnValue(JSON.stringify({ project: "x" }));
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.prd?.tasks).toEqual([]);
    mRead.mockReturnValue(JSON.stringify({ tasks: 5 }));
    const r2 = loadPrdFile("/x/prd.json");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.prd?.tasks).toEqual([]);
  });

  it("seed keeps well-typed fields untouched (invalid via another field)", () => {
    mRead.mockReturnValue(JSON.stringify(prd({ stack: 1, tasks: [task({ verify: "npm test" })] })));
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.prd?.project).toBe("p");
      expect(r.prd?.tasks[0]).toMatchObject({ id: "T1", title: "t", description: "d", verify: "npm test" });
    }
  });

  it("valid PRD -> ok:true, normalized:false", () => {
    mRead.mockReturnValue(JSON.stringify(prd()));
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toBe(false);
      expect(r.prd.tasks[0].id).toBe("T1");
    }
  });

  it("valid-after-normalize PRD -> ok:true, normalized:true, coercions applied", () => {
    mRead.mockReturnValue(
      JSON.stringify(prd({ tasks: [{ id: "A", title: "x", status: "doing", description: "", verify: "npm test" }] })),
    );
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toBe(true);
      const t0 = r.prd.tasks[0];
      expect(t0.status).toBe("todo");
      expect(t0.retries).toBe(0);
      expect(t0.deps).toEqual([]);
      expect(t0.acceptance).toEqual([]);
      expect(t0.scope).toEqual([]);
    }
  });

  // COMPAT: requiring verify is an authoring-time rule (the tui shim turns it
  // on). Every backlog written before the rule exists still has to load, so the
  // load path only warns — and it warns about the PRD as a whole, which is what
  // run.ts's per-task "no verify" line cannot say.
  // RETURNED, not printed: a stderr line scrolls past unread under the TUI and
  // never reaches progress.md, which is all an unattended run leaves behind.
  it("loads an unverified backlog but warns once with the whole-PRD count", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mRead.mockReturnValue(
      JSON.stringify(prd({ tasks: [task({ id: "A", verify: undefined }), task({ id: "B", verify: "  " })] })),
    );
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain("2/2 tasks have no verify command");
    }
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("stays quiet when every task has a verify command", () => {
    mRead.mockReturnValue(JSON.stringify(prd()));
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual([]);
  });

  // the load path must NOT inherit the shim's requireVerify default
  it("does not turn a missing verify into a load error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mRead.mockReturnValue(JSON.stringify(prd({ tasks: [task({ verify: undefined })] })));
    expect(loadPrdFile("/x/prd.json").ok).toBe(true);
    vi.restoreAllMocks();
  });

  // a cyclic backlog used to load clean and only fail later inside the loop
  it("rejects a cyclic backlog at intake", () => {
    mRead.mockReturnValue(
      JSON.stringify(prd({ tasks: [task({ id: "A", deps: ["B"] }), task({ id: "B", deps: ["A"] })] })),
    );
    const r = loadPrdFile("/x/prd.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith("dependency cycle:"))).toBe(true);
  });
});

describe("pathsOutsideScope", () => {
  it("reports only the paths no declared glob covers", () => {
    expect(pathsOutsideScope(["src/api/h.ts", "src/i18n.ts"], ["src/api/**"])).toEqual(["src/i18n.ts"]);
  });

  it("treats an empty scope as declaring nothing, so nothing can escape it", () => {
    // a backlog written before `scope` existed must not start emitting a warning
    // on every task it ever runs
    expect(pathsOutsideScope(["anything.ts"], [])).toEqual([]);
  });

  it("matches a directory scope and a ./-prefixed path the same way globs do", () => {
    expect(pathsOutsideScope(["./src/a.ts", "docs/x.md"], ["src/"])).toEqual(["docs/x.md"]);
  });
});

describe("literalScopeDirectoryPrefix", () => {
  it("checks the existing parent of a literal file", () => {
    expect(literalScopeDirectoryPrefix("apps/api/src/db/schema/users.ts")).toBe("apps/api/src/db/schema");
  });

  it("lets a recursive scope create its literal leaf", () => {
    expect(literalScopeDirectoryPrefix("apps/api/src/modules/auth/**")).toBe("apps/api/src/modules");
  });

  it("keeps the parent for a wildcard filename", () => {
    expect(literalScopeDirectoryPrefix("src/database/schema/*.ts")).toBe("src/database/schema");
  });
});

// These lines go into EVERY later prompt, so the section is a standing tax on
// the whole run — and unbounded it becomes the accumulated-summary memory the
// fresh-context rule exists to prevent, one honest line at a time.
describe("appendLearnedNote", () => {
  it("starts the section on the first note and appends to it after", () => {
    const one = appendLearnedNote("Existing notes.", "T1", "webhook unreachable from CI")!;
    expect(one).toContain("Existing notes.");
    expect(one).toContain("## Learned during runs");
    expect(one).toContain("- T1: webhook unreachable from CI");

    const two = appendLearnedNote(one, "T2", "the db resets between suites")!;
    expect(two.match(/## Learned during runs/g)).toHaveLength(1);
    expect(two).toContain("- T2: the db resets between suites");
  });

  // the same fact learned twice arrives under two task ids and is still one fact
  it("refuses a fact already recorded, whoever learned it", () => {
    const one = appendLearnedNote("x", "T1", "webhook unreachable")!;
    expect(appendLearnedNote(one, "T9", "webhook unreachable")).toBeNull();
  });

  it("refuses once the section is at its cap, rather than dropping the oldest", () => {
    let notes = "base";
    for (let i = 0; i < 40; i++) {
      const next = appendLearnedNote(notes, `T${i}`, `fact number ${i} ` + "y".repeat(40));
      if (!next) break;
      notes = next;
    }
    // a human may have promoted something into that section deliberately, so a
    // full budget is the human's to curate, not ours to silently prune
    expect(appendLearnedNote(notes, "TZ", "one more distinct fact entirely")).toBeNull();
    expect(notes).toContain("- T0:");
  });

  it("refuses an empty note", () => {
    expect(appendLearnedNote("x", "T1", "   ")).toBeNull();
  });
});

// STAGED AUTHORING: draft mode judges the skeleton's shape and forgives the
// fields a later expansion fills — while the default stays run-gate strict.
describe("draft option", () => {
  const skeleton = {
    project: "p",
    stack: "s",
    architecture_notes: "a",
    tasks: [{ id: "A", title: "A", status: "todo", deps: [], retries: 0 }],
  };
  it("forgives description/acceptance on a skeleton", () => {
    expect(validatePrd(skeleton, { draft: true }).ok).toBe(true);
  });
  it("the default (run gate) still refuses the same skeleton", () => {
    const v = validatePrd(skeleton);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
});

describe("loadPrdFile skeleton intake", () => {
  it("loads a SKELETON backlog (draft) instead of refusing the run", () => {
    mRead.mockReturnValue(
      JSON.stringify({
        project: "p",
        stack: "s",
        architecture_notes: "a",
        tasks: [{ id: "A", title: "A", status: "todo", deps: [], retries: 0 }],
      }),
    );
    const r = loadPrdFile("/p/prd.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prd.tasks[0].description).toBe("");
  });
});
