// prds.test.ts — wave layering is load-bearing twice over: it is what the board
// draws AND the order the loop dispatches in, so a wrong layer is a wrong run.
// The core loader is mocked whole — these are decisions about a backlog, not
// about reading files.

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { PRD, Task, TaskStatus } from "../../../src/prd.js";

const loadPrdFile = vi.fn();
const validatePrd = vi.fn();

vi.mock("../../../src/prdload.js", () => ({
  loadPrdFile: (...a: unknown[]) => loadPrdFile(...a),
  validatePrd: (...a: unknown[]) => validatePrd(...a),
}));

const { waveOf, toTaskViews, currentWave, waveCount, prdName, toPrdView } = await import("./prds.ts");
const { task: taskView } = await import("../mainview/testing.tsx");

function t(id: string, deps: string[] = [], status: TaskStatus = "todo"): Task {
  return { id, title: id, status, deps, retries: 0, description: "", acceptance: [] };
}

function prdOf(tasks: Task[], over: Partial<PRD> = {}): PRD {
  return { project: "qc-colombia", stack: "ts", architecture_notes: "", tasks, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  validatePrd.mockReturnValue({ ok: true, errors: [] });
});

describe("waveOf", () => {
  it("puts every dependency-free task in wave 0", () => {
    const waves = waveOf([t("a"), t("b"), t("c")]);
    expect([...waves.values()]).toEqual([0, 0, 0]);
  });

  it("layers a chain one wave per link", () => {
    const waves = waveOf([t("a"), t("b", ["a"]), t("c", ["b"])]);
    expect(waves.get("a")).toBe(0);
    expect(waves.get("b")).toBe(1);
    expect(waves.get("c")).toBe(2);
  });

  it("layers a diamond by its DEEPEST leg, not its first", () => {
    // d joins two legs of different lengths; dispatching it in wave 2 would
    // start it while the long leg is still running.
    const waves = waveOf([t("a"), t("b", ["a"]), t("long", ["b"]), t("d", ["a", "long"])]);
    expect(waves.get("d")).toBe(3);
  });

  it("layers dependents in declaration order too — the map does not need a topo sort", () => {
    // PRDs are hand-authored: a task may be listed before the one it depends on.
    const waves = waveOf([t("c", ["b"]), t("b", ["a"]), t("a")]);
    expect(waves.get("c")).toBe(2);
    expect(waves.get("a")).toBe(0);
  });

  it("draws a task whose dep does not exist instead of crashing", () => {
    // validatePrd is what refuses a dangling dep; the board still has to render
    // the backlog so the operator can SEE the broken edge.
    const waves = waveOf([t("a", ["ghost"]), t("b", ["a"])]);
    expect(waves.get("a")).toBe(0); // missing dep counts as depth -1
    expect(waves.get("b")).toBe(1);
  });

  it("terminates on a cycle instead of hanging or overflowing the stack", () => {
    const waves = waveOf([t("a", ["b"]), t("b", ["a"]), t("free")]);
    expect(waves.size).toBe(3);
    for (const [, d] of waves) expect(Number.isFinite(d)).toBe(true);
    // the healthy task keeps its own layer — one bad edge must not smear the board
    expect(waves.get("free")).toBe(0);
    // NOT asserting the cycle members' own waves: they come out order-dependent
    // (a=2/b=1 here, mirrored if the two are declared the other way round).
    // Terminating is the contract; depsOk is what tells the operator it is broken.
  });

  it("terminates on a self-dependency", () => {
    const waves = waveOf([t("a", ["a"])]);
    expect(Number.isFinite(waves.get("a"))).toBe(true);
  });

  it("returns an empty map for an empty backlog", () => {
    expect(waveOf([]).size).toBe(0);
  });
});

describe("toTaskViews", () => {
  it("carries the computed wave and defaults an absent scope to empty", () => {
    const views = toTaskViews(prdOf([t("a"), { ...t("b", ["a"]), scope: ["src/b.ts"], verify: "npm test" }]));
    expect(views.map((v) => v.wave)).toEqual([0, 1]);
    expect(views[0].scope).toEqual([]);
    expect(views[1].scope).toEqual(["src/b.ts"]);
    expect(views[1].verify).toBe("npm test");
  });
});

describe("currentWave / waveCount", () => {
  const backlog = [
    taskView({ id: "a", wave: 0, status: "done" }),
    taskView({ id: "b", wave: 1, status: "done" }),
    taskView({ id: "c", wave: 1, status: "doing" }),
    taskView({ id: "d", wave: 2, status: "todo" }),
  ];

  it("reports the shallowest wave still holding work, 1-indexed for the header", () => {
    expect(currentWave(backlog)).toBe(2);
    expect(waveCount(backlog)).toBe(3);
  });

  it("counts a blocked task as work — a stuck wave is not a finished one", () => {
    const stuck = [taskView({ id: "a", wave: 0, status: "blocked" }), taskView({ id: "b", wave: 1, status: "done" })];
    expect(currentWave(stuck)).toBe(1);
  });

  it("lands on wave count once everything is done, so the header reads N/N", () => {
    const finished = backlog.map((v) => ({ ...v, status: "done" as const }));
    expect(currentWave(finished)).toBe(3);
    expect(waveCount(finished)).toBe(3);
  });

  it("says 0 of 0 for an empty backlog rather than dividing by nothing", () => {
    expect(currentWave([])).toBe(0);
    expect(waveCount([])).toBe(0);
  });
});

describe("prdName", () => {
  it("prefers the PRD's own project name", () => {
    expect(prdName("/dev/qc/prd-auth.json", prdOf([]))).toBe("qc-colombia");
  });

  it("falls back to the filename when project is blank, whitespace, or the PRD is unreadable", () => {
    const path = "/dev/qc/prd-auth.json";
    expect(prdName(path, prdOf([], { project: "" }))).toBe("prd-auth");
    expect(prdName(path, prdOf([], { project: "   " }))).toBe("prd-auth");
    expect(prdName(path, null)).toBe("prd-auth");
  });

  it("strips only the .json suffix, not a dotted name", () => {
    expect(prdName("/dev/qc/prd.v2.json", null)).toBe("prd.v2");
  });
});

describe("toPrdView", () => {
  it("summarises a valid backlog", () => {
    const prd = prdOf([t("a", [], "done"), t("b", ["a"]), t("c", ["a"], "blocked")]);
    loadPrdFile.mockReturnValue({ ok: true, prd, normalized: false, warnings: [] });

    const view = toPrdView("p1", "/dev/qc/prd.json", "run-1");
    expect(view).toMatchObject({
      name: "qc-colombia",
      projectId: "p1",
      taskCount: 3,
      doneCount: 1,
      blockedCount: 1,
      depsOk: true,
      runId: "run-1",
    });
  });

  it("still renders a parseable-but-invalid PRD, carrying the dep errors", () => {
    // ok:false WITH a prd is the studio's seed: the operator has to see the
    // broken backlog to fix it, so this must not collapse to null.
    const prd = prdOf([t("a", ["ghost"])]);
    loadPrdFile.mockReturnValue({ ok: false, errors: ["dep ausente"], prd });
    validatePrd.mockReturnValue({ ok: false, errors: ["dep ausente: ghost"] });

    const view = toPrdView("p1", "/dev/qc/prd.json", null);
    expect(view?.depsOk).toBe(false);
    expect(view?.depErrors).toEqual(["dep ausente: ghost"]);
  });

  it("returns null for a json file that is not a PRD", () => {
    loadPrdFile.mockReturnValue({ ok: false, errors: ["nao e um objeto"] });
    expect(toPrdView("p1", "/dev/qc/tsconfig.json", null)).toBeNull();
  });

  it("returns null when tasks is not an array, so a half-written file never reaches the board", () => {
    loadPrdFile.mockReturnValue({ ok: false, errors: ["tasks invalido"], prd: { tasks: null } as unknown as PRD });
    expect(toPrdView("p1", "/dev/qc/prd.json", null)).toBeNull();
  });
});
