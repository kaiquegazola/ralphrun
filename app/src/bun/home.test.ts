// home.test.ts — 5a's assembly rules. Everything the cockpit shows is derived
// from four other modules, so all four are mocked and only home()'s own
// decisions are under test: what gets answered first, what counts as activity,
// and how many agents are actually free.

import { describe, it, expect, vi, beforeEach } from "vitest";

const runs = {
  activeRuns: vi.fn(),
  getRunDetail: vi.fn(),
  listDecisions: vi.fn(),
  listRuns: vi.fn(),
  readHistory: vi.fn(),
};
const projects = { listProjectViews: vi.fn() };
const studio = { drafts: vi.fn() };
const wf = { workforce: vi.fn() };
const prds = { toPrdView: vi.fn() };

vi.mock("./runs.ts", () => runs);
vi.mock("./projects.ts", () => projects);
vi.mock("./studio.ts", () => studio);
vi.mock("./workforce.ts", () => wf);
vi.mock("./prds.ts", () => prds);

const { home } = await import("./home.ts");
const { T0, agent, decision, prd, project, run, workforce } = await import("../mainview/testing.tsx");

beforeEach(() => {
  vi.clearAllMocks();
  runs.activeRuns.mockReturnValue([]);
  runs.listRuns.mockReturnValue([]);
  runs.listDecisions.mockReturnValue([]);
  runs.readHistory.mockReturnValue([]);
  runs.getRunDetail.mockReturnValue({ ...run(), tasks: [], timeline: [], focusTaskId: null });
  projects.listProjectViews.mockReturnValue([]);
  studio.drafts.mockReturnValue([]);
  prds.toPrdView.mockImplementation(() => prd());
  wf.workforce.mockReturnValue(workforce({ agents: [] }));
});

describe("home", () => {
  it("puts the decision that has waited longest at the top", () => {
    runs.listDecisions.mockReturnValue([
      decision({ id: "b", since: T0 + 60_000 }),
      decision({ id: "c", since: T0 + 120_000 }),
      decision({ id: "a", since: T0 }),
    ]);
    expect(home().decisions.map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  it("merges live merges and run ends into one newest-first feed", () => {
    const ended = run({ id: "run-9", status: "done", endedAt: T0 + 5_000, prdName: "Launch V1" });
    runs.listRuns.mockReturnValue([ended]);
    runs.getRunDetail.mockReturnValue({
      ...ended,
      tasks: [],
      focusTaskId: null,
      timeline: [
        { at: T0 + 1_000, taskId: "t1", kind: "merge", label: "t1 merged" },
        // non-merge events are loop noise; the cockpit only reports landings
        { at: T0 + 2_000, taskId: "t2", kind: "fail", label: "t2 tests ✗" },
        { at: T0 + 3_000, taskId: "t2", kind: "merge", label: "t2 merged" },
      ],
    });

    const activity = home().activity;
    expect(activity.map((a) => a.at)).toEqual([T0 + 5_000, T0 + 3_000, T0 + 1_000]);
    expect(activity[0]).toMatchObject({ kind: "run-end", text: "run concluída · Launch V1" });
    expect(activity[1]).toMatchObject({ kind: "merge", text: "t2 → trunk", projectName: "qc-colombia" });
  });

  it("names a failed run by its status instead of pretending it concluded", () => {
    runs.listRuns.mockReturnValue([run({ status: "failed", endedAt: T0 + 1_000 })]);
    expect(home().activity[0].text).toBe("run failed · Launch V1");
  });

  it("reads finished runs back out of the per-project history", () => {
    // nothing is in memory here — this is what a restart looks like
    projects.listProjectViews.mockReturnValue([project({ dir: "/dev/qc", name: "qc-colombia" })]);
    runs.readHistory.mockReturnValue([
      run({ id: "old-1", status: "done", endedAt: T0 - 1_000, prdName: "Launch V0" }),
      // a record with no endedAt is a run that was killed mid-flight; it is not
      // an "activity" because nothing actually happened at a knowable moment
      run({ id: "old-2", endedAt: null }),
    ]);

    const activity = home().activity;
    expect(runs.readHistory).toHaveBeenCalledWith("/dev/qc");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ at: T0 - 1_000, text: "run concluída · Launch V0", projectName: "qc-colombia" });
  });

  it("keeps only the five most recent activity entries", () => {
    runs.listRuns.mockReturnValue(
      Array.from({ length: 8 }, (_, i) => run({ id: `r${i}`, status: "done", endedAt: T0 + i * 1_000 })),
    );
    const activity = home().activity;
    expect(activity).toHaveLength(5);
    expect(activity[0].at).toBe(T0 + 7_000);
    expect(activity[4].at).toBe(T0 + 3_000);
  });

  it("counts busy agents by their active tasks and the rest as free", () => {
    wf.workforce.mockReturnValue(
      workforce({
        agents: [
          agent({ cli: "claude", activeTasks: 2 }),
          agent({ cli: "codex", activeTasks: 1 }),
          agent({ cli: "cursor", activeTasks: 0 }),
          agent({ cli: "grok", installed: false, loggedIn: false, activeTasks: 0 }),
        ],
        checkedAt: T0 + 42,
      }),
    );
    const view = home();
    expect(view.busy).toBe(3);
    // free counts IDLE AGENTS: cursor is usable and doing nothing. Subtracting
    // tasks from agents would read claude's two tasks as two agents gone.
    expect(view.free).toBe(1);
    expect(view.checkedAt).toBe(T0 + 42);
  });

  it("does not count an agent that is not usable as spare capacity", () => {
    wf.workforce.mockReturnValue(
      workforce({ agents: [agent({ activeTasks: 5 }), agent({ cli: "grok", installed: false, activeTasks: 0 })] }),
    );
    expect(home().free).toBe(0);
  });

  it("shows at most five agents in the footer with the reason each one is not ok", () => {
    wf.workforce.mockReturnValue(
      workforce({
        agents: [
          agent({ cli: "a", installed: false, loggedIn: false }),
          agent({ cli: "b", installed: true, loggedIn: false }),
          agent({ cli: "c" }),
          agent({ cli: "d" }),
          agent({ cli: "e" }),
          agent({ cli: "f" }),
        ],
      }),
    );
    const footer = home().workforce;
    expect(footer).toHaveLength(5);
    expect(footer[0]).toMatchObject({ ok: false, note: "não instalado" });
    expect(footer[1]).toMatchObject({ ok: false, note: "não logado" });
    expect(footer[2]).toMatchObject({ ok: true, note: null });
  });

  it("offers a saved draft by its PRD filename and marks it runnable", () => {
    projects.listProjectViews.mockReturnValue([project({ id: "p1", name: "qc-colombia" })]);
    studio.drafts.mockReturnValue([
      { projectId: "p1", prdPath: "/dev/qc/prd-launch-v1.json", dirty: false, taskCount: 16 },
    ]);
    expect(home().resume[0]).toEqual({
      prdPath: "/dev/qc/prd-launch-v1.json",
      projectId: "p1",
      name: "prd-launch-v1",
      note: "qc-colombia · PRD com 16 tasks",
      runnable: true,
    });
  });

  it("does not offer to build a saved draft that would not validate", () => {
    // "exists on disk" is not "runnable": a skeleton or a broken dep graph
    // would start a run the child refuses on the spot
    projects.listProjectViews.mockReturnValue([project({ id: "p1", name: "qc-colombia" })]);
    studio.drafts.mockReturnValue([
      { projectId: "p1", prdPath: "/dev/qc/prd.json", dirty: false, taskCount: 16 },
    ]);
    prds.toPrdView.mockReturnValue(prd({ depsOk: false, depErrors: ["t2 depende de t9"] }));

    expect(home().resume[0]).toMatchObject({ runnable: false, note: "qc-colombia · precisa terminar no studio" });
  });

  it("refuses to run a draft with unsaved studio edits", () => {
    projects.listProjectViews.mockReturnValue([project({ id: "p1" })]);
    studio.drafts.mockReturnValue([{ projectId: "p1", prdPath: "/dev/qc/prd.json", dirty: true, taskCount: 3 }]);
    expect(home().resume[0]).toMatchObject({ note: "PRD em edição no studio", runnable: false });
  });

  it("falls back to the project name for a draft that was never saved", () => {
    projects.listProjectViews.mockReturnValue([project({ id: "p1", name: "qc-colombia" })]);
    studio.drafts.mockReturnValue([{ projectId: "p1", prdPath: null, dirty: false, taskCount: 0 }]);
    expect(home().resume[0]).toMatchObject({ prdPath: "", name: "qc-colombia", runnable: false });
  });

  it("still names an orphan draft when its project is gone from the registry", () => {
    studio.drafts.mockReturnValue([{ projectId: "ghost", prdPath: null, dirty: false, taskCount: 0 }]);
    expect(home().resume[0]).toMatchObject({ name: "rascunho", note: " · PRD com 0 tasks" });
  });

});
