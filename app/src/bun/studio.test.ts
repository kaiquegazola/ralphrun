// studio.test.ts — the planner session. The planner turn itself is the core's
// (and is mocked here); what belongs to the app is WHERE a backlog lands, what
// "+ Novo PRD" resets, and that a turn's history is captured before the turn.

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  runPlannerTurn: vi.fn(),
  getProject: vi.fn(),
  checkAgent: vi.fn(),
  loadUserConfig: vi.fn(),
  renameSync: vi.fn(),
  runLockHolder: vi.fn<() => number | null>(() => null),
}));

vi.mock("node:fs", () => {
  const fs = {
    existsSync: m.existsSync,
    writeFileSync: m.writeFileSync,
    readFileSync: vi.fn(),
    renameSync: m.renameSync,
    rmSync: vi.fn(),
  };
  return { ...fs, default: fs };
});
vi.mock("../../../src/agents.js", () => ({
  agentClis: ["claude", "codex"],
  agentDef: (cli: string) => ({ recommended: { planner: `${cli}-best` } }),
  defaultModelOf: (cli: string) => `${cli}-default`,
}));
vi.mock("../../../src/diagnostics.js", () => ({ checkAgent: m.checkAgent }));
vi.mock("../../../src/picker.js", () => ({ readAttachment: (path: string) => ({ path, content: "", truncated: false, ok: true }) }));
vi.mock("../../../src/userconfig.js", () => ({ loadUserConfig: m.loadUserConfig }));
vi.mock("../../../src/worktree.js", () => ({
  runLockHolder: m.runLockHolder,
  // the real one CLAIMS the lock for the duration of the write; here the same
  // answer runLockHolder gives decides whether the body runs at all
  withRunLock: <T,>(_ws: string, fn: () => T) => {
    const holder = m.runLockHolder();
    return holder ? { ok: false as const, holder } : { ok: true as const, value: fn() };
  },
}));
vi.mock("../../../src/tui/prd/prdChat.js", () => ({ runPlannerTurn: m.runPlannerTurn }));
vi.mock("./registry.ts", () => ({ getProject: m.getProject }));
vi.mock("./prds.ts", () => ({ readPrd: () => null, toTaskViews: () => [] }));

/** Fresh module registry per test — sessions are module-level state. */
async function load() {
  vi.resetModules();
  return await import("./studio.ts");
}

const PRD = { project: "Launch V1", stack: "ts", architecture_notes: "", tasks: [] };

beforeEach(() => {
  vi.clearAllMocks();
  m.existsSync.mockReturnValue(false);
  m.getProject.mockReturnValue({ id: "p1", name: "qc", dir: "/repo", addedAt: 0 });
  m.checkAgent.mockImplementation((cli: string) => ({ cli, installed: true, loggedIn: true }));
  m.loadUserConfig.mockReturnValue({});
  m.runLockHolder.mockReturnValue(null); // no run owns the workspace
  m.runPlannerTurn.mockResolvedValue({ summary: "ok", prd: PRD, errors: [] });
});

describe("plannerSpec", () => {
  it("uses the saved preference when there is one", async () => {
    m.loadUserConfig.mockReturnValue({ default_planner: { cli: "codex", model: "gpt" } });
    const { studioOpen } = await load();
    expect(studioOpen("p1").planner).toEqual({ cli: "codex", model: "gpt" });
  });

  it("falls back to an agent that is actually installed and logged in", async () => {
    // hard-coding claude would make every turn fail on a machine that has
    // codex and nothing else
    m.checkAgent.mockImplementation((cli: string) => ({ cli, installed: cli === "codex", loggedIn: true }));
    const { studioOpen } = await load();
    expect(studioOpen("p1").planner).toEqual({ cli: "codex", model: "codex-best" });
  });
});

describe("studioOpen", () => {
  it("starts blank for + Novo PRD, keeping nothing from the previous session", async () => {
    const { studioOpen, studioSend } = await load();
    await studioSend("p1", "monta o plano");
    expect(studioOpen("p1").messages).toHaveLength(2);

    const fresh = studioOpen("p1", undefined, true);
    expect(fresh.messages).toEqual([]);
    expect(fresh.prdPath).toBeNull();
  });

  it("keeps an unsaved draft when reopened WITHOUT the fresh flag", async () => {
    // resuming a draft looks exactly like "+ Novo PRD" from the path alone,
    // and wiping the draft is the worse of the two mistakes
    const { studioOpen, studioSend } = await load();
    await studioSend("p1", "monta o plano");
    expect(studioOpen("p1").messages).toHaveLength(2);
  });
});

describe("studioSend", () => {
  it("hands the planner the history from BEFORE this turn", async () => {
    const { studioSend } = await load();
    await studioSend("p1", "primeira");
    await studioSend("p1", "segunda");

    const second = m.runPlannerTurn.mock.calls[1][0];
    expect(second.instruction).toBe("segunda");
    // the new message must not also appear in the history, or the planner
    // reads it twice
    expect(second.history.map((h: { text: string }) => h.text)).not.toContain("segunda");
    expect(second.history.map((h: { text: string }) => h.text)).toContain("primeira");
  });

  it("turns a planner that could not even run into a readable error", async () => {
    // a saved planner cli that is gone: without this the session stays in
    // `drafting` forever, with nothing to read and nothing left to save
    m.runPlannerTurn.mockRejectedValue(new Error("spawn codex ENOENT"));
    const { studioSend } = await load();

    const view = await studioSend("p1", "monta o plano");

    expect(view.status).not.toBe("drafting");
    expect(view.errors.join(" ")).toContain("ENOENT");
  });
});

describe("studioSave", () => {
  it("writes prd.json at the project root, where the CLI's config lookup finds it", async () => {
    const { studioSend, studioSave } = await load();
    await studioSend("p1", "monta o plano");

    const view = studioSave("p1");
    expect(view.prdPath).toBe("/repo/prd.json");
    // tmp + rename: a half-written backlog is one the loop reads as empty
    expect(m.writeFileSync.mock.calls[0][0]).toMatch(/^\/repo\/prd\.json\..*\.tmp$/);
    expect(m.renameSync).toHaveBeenCalledWith(m.writeFileSync.mock.calls[0][0], "/repo/prd.json");
  });

  it("refuses to overwrite a backlog while a run owns the workspace", async () => {
    // THE prd.json rule: this snapshot would restore the status of every task
    // that run has advanced since the draft was loaded
    m.existsSync.mockReturnValue(true);
    m.runLockHolder.mockReturnValue(4242);
    const { studioSend, studioSave } = await load();
    await studioSend("p1", "monta o plano");

    const view = studioSave("p1", "/repo/prd.json");

    expect(view.messages.at(-1)).toMatchObject({ role: "error", text: expect.stringContaining("4242") });
    expect(m.writeFileSync).not.toHaveBeenCalled();
  });

  it("never overwrites a backlog that is already there", async () => {
    // prd.json and prd-launch-v1.json both taken: a second draft of the same
    // project must land beside them, not on top of one
    m.existsSync.mockImplementation((p: string) => p === "/repo/prd.json" || p === "/repo/prd-launch-v1.json");
    const { studioSend, studioSave } = await load();
    await studioSend("p1", "monta o plano");

    expect(studioSave("p1").prdPath).toBe("/repo/prd-launch-v1-1.json");
  });

  it("reports a write it could not do instead of claiming it saved", async () => {
    m.writeFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const { studioSend, studioSave } = await load();
    await studioSend("p1", "monta o plano");

    const view = studioSave("p1");
    // the reducer surfaces a failed write as an error MESSAGE in the chat, so
    // the drafted PRD survives and the user sees why it did not land
    expect(view.messages.at(-1)).toMatchObject({ role: "error", text: expect.stringContaining("EACCES") });
    expect(view.prdPath).toBeNull();
  });
});
