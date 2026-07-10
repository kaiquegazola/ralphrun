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
import { loadPrdFile, normalizePrd } from "./prdload.js";

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

  it("fills non-number retries and undefined deps/acceptance", () => {
    const p = prd({ tasks: [task({ retries: "5", deps: undefined, acceptance: undefined })] });
    expect(normalizePrd(p)).toBe(true);
    const t0 = (p.tasks as Record<string, unknown>[])[0];
    expect(t0.retries).toBe(0);
    expect(t0.deps).toEqual([]);
    expect(t0.acceptance).toEqual([]);
  });

  it("leaves wrong-TYPE deps/acceptance untouched (validation rejects them)", () => {
    const p = prd({ tasks: [task({ deps: {}, acceptance: "x" })] });
    expect(normalizePrd(p)).toBe(false);
    const t0 = (p.tasks as Record<string, unknown>[])[0];
    expect(t0.deps).toEqual({});
    expect(t0.acceptance).toBe("x");
  });

  it("returns false on an already-normalized PRD", () => {
    expect(normalizePrd(prd())).toBe(false);
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
          { id: 1, title: 2, description: 3, deps: "x", acceptance: [1, { a: 1 }], verify: 42, status: "todo" },
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
      JSON.stringify(prd({ tasks: [{ id: "A", title: "x", status: "doing", description: "" }] })),
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
    }
  });
});
