// runs.test.ts — the supervisor's decisions, without a child process or a disk.
// Everything that touches the outside world is mocked: the frames arrive as
// bytes on a fake stdout, prd.json is a variable, and the only proof a decision
// was written is what writeFileSync was handed.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  spawn: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  loadConfig: vi.fn(),
  loadPrdFile: vi.fn(),
  gitOut: vi.fn(),
  captureReviewBase: vi.fn(() => "NOW"),
  getProject: vi.fn(),
  listProjects: vi.fn<() => { id: string; name: string; dir: string; addedAt: number }[]>(() => []),
  findPrdFiles: vi.fn<() => string[]>(() => []),
  runLockHolder: vi.fn<() => number | null>(() => null),
  lockedDirs: [] as string[],
}));

vi.mock("node:child_process", () => ({ spawn: m.spawn, default: { spawn: m.spawn } }));
vi.mock("node:fs", () => {
  const fs = {
    existsSync: m.existsSync,
    readFileSync: m.readFileSync,
    writeFileSync: m.writeFileSync,
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
  };
  // the core reaches node:fs through the default export too
  return { ...fs, default: fs };
});
// childScript() probes `join(import.meta.dir, …)`, and import.meta.dir is a Bun
// global that vitest does not define — an undefined segment would blow up in
// path.join before existsSync ever gets a say.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  const join = (...p: unknown[]) => actual.join(...p.filter((s): s is string => typeof s === "string"));
  return { ...actual, join, default: { ...actual, join } };
});
vi.mock("../../../src/config.js", () => ({ loadConfig: m.loadConfig }));
vi.mock("../../../src/prdload.js", () => ({
  loadPrdFile: m.loadPrdFile,
  validatePrd: () => ({ ok: true, errors: [] }),
}));
vi.mock("./prds.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prds.ts")>()),
  findPrdFiles: m.findPrdFiles,
}));
vi.mock("../../../src/git.js", () => ({ gitOut: m.gitOut, captureReviewBase: m.captureReviewBase }));
vi.mock("../../../src/worktree.js", () => ({
  runLockHolder: m.runLockHolder,
  // the real one CLAIMS the lock for the duration of the write; here the same
  // answer runLockHolder gives decides whether the body runs at all
  withRunLock: <T,>(ws: string, fn: () => T) => {
    m.lockedDirs.push(ws);
    const holder = m.runLockHolder();
    return holder ? { ok: false as const, holder } : { ok: true as const, value: fn() };
  },
}));
vi.mock("./registry.ts", () => ({ getProject: m.getProject, listProjects: m.listProjects }));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  // the answer channel for the review gate: a parked task is released by a
  // line written here, not by a write to prd.json. `on` because an EPIPE from a
  // dead reader arrives asynchronously and unhandled would kill the app.
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), destroyed: false, writableEnded: false });
  kill = vi.fn();
}

const PRD_PATH = "/repo/prd.json";
let child: FakeChild;
let onDisk: { project: string; tasks: Record<string, unknown>[] };

function task(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, title: `${id} title`, status, deps: [], retries: 0, scope: [], acceptance: [], description: "", ...extra };
}

/** Fresh module registry per test — `runs` is module-level state in runs.ts. */
async function load() {
  vi.resetModules();
  return await import("./runs.ts");
}

// Each test loads a FRESH module registry, and a module with a live child keeps
// process-exit hooks attached. Ending the child releases them, so the suite does
// not drift past node's listener ceiling.
afterEach(() => {
  child?.emit("close", 0);
});

/** The arguments of the last `diff --numstat` git was asked for. */
function numstatCall(): unknown[] {
  return m.gitOut.mock.calls.filter((c) => c[2] === "--numstat").at(-1) ?? [];
}

/** Only the writes that landed on prd.json — run history uses the same mock. */
function prdWrites(): { tasks: Record<string, unknown>[] }[] {
  return m.writeFileSync.mock.calls
    // `PRD_PATH.<pid>.<n>.tmp`: the backlog is written atomically, so the body
    // lands on a temp file in the same directory and is renamed into place
    .filter(([p]) => String(p).startsWith(PRD_PATH))
    .map(([, body]) => JSON.parse(String(body)));
}

function feed(...lines: string[]) {
  child.stdout.emit("data", Buffer.from(lines.join("\n") + "\n"));
}

beforeEach(() => {
  vi.clearAllMocks();
  onDisk = { project: "colombia", tasks: [task("t1", "todo"), task("t2", "todo", { deps: ["t1"] })] };
  m.getProject.mockReturnValue({ id: "p1", name: "qc-colombia", dir: "/repo", addedAt: 0 });
  // no BACKLOG decisions by default: these tests are about live runs, and the
  // registry scan is exercised in its own case below
  m.listProjects.mockReturnValue([]);
  m.findPrdFiles.mockReturnValue([]);
  m.runLockHolder.mockReturnValue(null); // no CLI run owns the workspace
  m.lockedDirs.length = 0;
  m.loadConfig.mockReturnValue({
    executor: { cli: "claude", model: "sonnet" },
    advisor: null,
    max_parallel_tasks: 3,
    worktree_per_task: true,
  });
  // a clone per read: the supervisor mutates what it loads before writing it back
  m.loadPrdFile.mockImplementation(() => ({ ok: true, prd: structuredClone(onDisk) }));
  // the core's requeue reads the file directly (it is the same write the child
  // performs in-process), so the fake disk has to serve it too
  m.readFileSync.mockImplementation((p: string) =>
    String(p) === PRD_PATH ? JSON.stringify(onDisk) : JSON.stringify([]),
  );
  // only the bundled child exists; everything else absent keeps app settings and
  // run history on their defaults.
  m.existsSync.mockImplementation((p: string) => String(p).endsWith("run-child.js"));
  m.gitOut.mockReturnValue(null);
  m.captureReviewBase.mockReturnValue("NOW");
  m.spawn.mockImplementation(() => {
    child = new FakeChild();
    return child;
  });
});

describe("startRun", () => {
  it("spawns the child once and hands back the same run for a PRD already running", async () => {
    const { startRun, listRuns } = await load();
    const id = startRun("p1", PRD_PATH);

    expect(m.spawn).toHaveBeenCalledTimes(1);
    expect(m.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["--prd", PRD_PATH, "--workspace", "/repo"]));
    // a second Start on the same backlog must not fork a rival loop over one repo
    expect(startRun("p1", PRD_PATH)).toBe(id);
    expect(m.spawn).toHaveBeenCalledTimes(1);
    expect(listRuns()).toHaveLength(1);
  });

  it("refuses a project the registry does not know", async () => {
    const { startRun } = await load();
    m.getProject.mockReturnValue(null);
    expect(() => startRun("ghost", PRD_PATH)).toThrow(/ghost/);
    expect(m.spawn).not.toHaveBeenCalled();
  });
});

describe("frame folding", () => {
  it("puts an ev line in its task's stream and follows focus", async () => {
    const { startRun, getStream, getRunDetail } = await load();
    const id = startRun("p1", PRD_PATH);

    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", line: "escrevendo testes", lineSource: "executor" } }));

    expect(getStream(id, "t1").map((l) => l.text)).toEqual(["escrevendo testes"]);
    expect(getRunDetail(id).focusTaskId).toBeNull();

    onDisk.tasks[0].status = "doing";
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "doing", subphase: "exec" } }));
    expect(getRunDetail(id).focusTaskId).toBe("t1");
  });

  it("keeps a task in flight visible — reading the backlog is not crash recovery", async () => {
    const { startRun, getRunDetail } = await load();
    const id = startRun("p1", PRD_PATH);

    onDisk.tasks[0].status = "doing";
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "doing" } }));

    // the core's default normalization rewrites `doing` to `todo` (recovery
    // after a crash). Applied to a LIVE run it would empty the board and stop
    // stall detection from ever firing.
    expect(m.loadPrdFile).toHaveBeenCalledWith(PRD_PATH, { keepDoing: true });
    expect(getRunDetail(id).tasks.find((t) => t.id === "t1")?.status).toBe("doing");
  });

  it("re-reads the counters off prd.json when a status frame lands", async () => {
    const { startRun, listRuns } = await load();
    const id = startRun("p1", PRD_PATH);
    expect(listRuns()[0].done).toBe(0);

    // the child rewrites prd.json BEFORE announcing the transition — the frame
    // is only the nudge, the file is the truth.
    onDisk.tasks[0].status = "done";
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "done" } }));

    const s = listRuns().find((r) => r.id === id)!;
    expect(s.done).toBe(1);
    expect(s.wave).toBe(2);
    expect(s.waveCount).toBe(2);
  });

  it("keeps log frames and unparseable output as system lines instead of throwing", async () => {
    const { startRun, getStream } = await load();
    const id = startRun("p1", PRD_PATH);

    expect(() => feed(JSON.stringify({ t: "log", line: "wave 1 iniciada" }), "{nao é json", "")).not.toThrow();

    // "" is the run's own stream: a named key like "run" could be a task id,
    // since ids are free text
    expect(getStream(id, "").map((l) => [l.source, l.text])).toEqual([
      ["system", "wave 1 iniciada"],
      ["system", "{nao é json"],
    ]);
  });
});

describe("decisions", () => {
  it("surfaces a blocked task with the reviewer's words, and drops it on skip", async () => {
    const { startRun, listDecisions, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);

    onDisk.tasks[0].status = "blocked";
    feed(
      JSON.stringify({
        t: "ev",
        e: { taskId: "t1", status: "blocked", reason: "review reprovou", line: "faltou teste", lineSource: "review" },
      }),
    );

    const [d] = listDecisions();
    expect(d).toMatchObject({ id: `${id}:t1`, taskId: "t1", kind: "review-blocked", feedback: "faltou teste" });
    expect(d.projectName).toBe("qc-colombia");

    expect(resolveDecision(id, "t1", "skip")).toEqual({ ok: true, message: "t1 pulada" });
    // skip leaves the task blocked on disk; it only leaves the inbox
    expect(listDecisions()).toEqual([]);
    expect(m.writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses to accept a task the run already gave up on — its work is gone", async () => {
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[1].status = "blocked";

    // no gate is holding this one: the loop blocked it and discarded the cell,
    // so writing status:done would file work that does not exist as delivered
    const res = resolveDecision(id, "t2", "accept");

    expect(res.ok).toBe(false);
    expect(res.message).toContain("corrigir de novo");
    expect(m.writeFileSync).not.toHaveBeenCalled();
  });

  it("asks the RUN to requeue a blocked task instead of writing the file itself", async () => {
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[1] = task("t2", "blocked", { deps: ["t1"], retries: 3 });

    expect(resolveDecision(id, "t2", "retry").ok).toBe(true);

    // the child owns prd.json while it runs; a write from here would race the
    // loop's own read-modify-write and its stale snapshot could land last
    expect(child.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ t: "decide", taskId: "t2", action: "retry" }) + "\n",
    );
    expect(m.writeFileSync).not.toHaveBeenCalled();
  });

  it("asks again when a retried task blocks a second time", async () => {
    const { startRun, resolveDecision, listDecisions } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[0].status = "blocked";
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "blocked", reason: "review reprovou" } }));

    resolveDecision(id, "t1", "retry");
    expect(listDecisions()).toEqual([]);

    // the loop picked it up, and it failed again — that is a NEW decision, and
    // a dismissal that outlived its own state would retire the task silently
    onDisk.tasks[0].status = "doing";
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "doing" } }));
    onDisk.tasks[0].status = "blocked";
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "blocked", reason: "reprovou de novo" } }));

    expect(listDecisions().map((d) => d.taskId)).toEqual(["t1"]);
  });

  it("applies a decision the child died before reading", async () => {
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[1] = task("t2", "blocked", { deps: ["t1"], retries: 3 });

    resolveDecision(id, "t2", "retry");
    expect(prdWrites()).toHaveLength(0);

    // the run was finishing anyway (stop_on_blocked, say) and never read the
    // line — an unacknowledged answer is not a lost one
    child.emit("close", 0);

    expect(prdWrites().at(-1)!.tasks[1]).toMatchObject({ id: "t2", status: "todo", retries: 0 });
  });

  it("puts a decision the child REFUSED back in the inbox", async () => {
    const { startRun, resolveDecision, listDecisions } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[1] = task("t2", "blocked", { deps: ["t1"], retries: 3 });

    resolveDecision(id, "t2", "retry");
    expect(listDecisions()).toEqual([]);

    // the PRD changed under it, or stopped parsing — telling the human it was
    // handled when it was not is the one outcome worth avoiding here
    feed(JSON.stringify({ t: "decided", taskId: "t2", ok: false }));

    expect(listDecisions().map((d) => d.taskId)).toEqual(["t2"]);
  });

  it("does not re-apply a decision the child acknowledged", async () => {
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[1] = task("t2", "blocked", { deps: ["t1"], retries: 3 });

    resolveDecision(id, "t2", "retry");
    feed(JSON.stringify({ t: "decided", taskId: "t2", ok: true }));
    child.emit("close", 0);

    // the child already wrote it; writing again from here would clobber
    // whatever the loop did with the task afterwards
    expect(prdWrites()).toHaveLength(0);
  });

  it("refuses an ended-run decision while a CLI run has taken the workspace", async () => {
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[1] = task("t2", "blocked", { deps: ["t1"], retries: 3 });
    child.emit("close", 0);
    m.writeFileSync.mockClear();

    // no child of OURS is not the same as nobody running here
    m.runLockHolder.mockReturnValue(4242);
    const res = resolveDecision(id, "t2", "retry");

    expect(res.ok).toBe(false);
    expect(res.message).toContain("4242");
    expect(m.writeFileSync).not.toHaveBeenCalled();
  });

  it("locks the PROJECT workspace, not the folder the PRD happens to sit in", async () => {
    // the loop takes its lock on the project directory, so a backlog in a
    // subfolder that locked its own directory would exclude nobody
    m.getProject.mockReturnValue({ id: "p1", name: "qc", dir: "/repo", addedAt: 0 });
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", "/repo/sub/prd.json");
    onDisk.tasks[1] = task("t2", "blocked", { deps: ["t1"], retries: 3 });
    child.emit("close", 0);
    m.lockedDirs.length = 0;

    resolveDecision(id, "t2", "retry");

    expect(m.lockedDirs).toEqual(["/repo"]);
  });

  it("writes todo with the retry budget reset once the run has ended", async () => {
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[1] = task("t2", "blocked", { deps: ["t1"], retries: 3 });
    child.emit("close", 0);
    m.writeFileSync.mockClear();

    resolveDecision(id, "t2", "retry");

    const written = JSON.parse(m.writeFileSync.mock.calls[0][1] as string);
    // retries: 0 is what buys the task a full budget again instead of an
    // instant re-block on its first stumble.
    expect(written.tasks[1]).toMatchObject({ id: "t2", status: "todo", retries: 0 });
  });

  it("reports an unknown run instead of writing anything", async () => {
    const { resolveDecision } = await load();
    expect(resolveDecision("run-nope", "t1", "accept")).toEqual({ ok: false, message: "run run-nope desconhecida" });
    expect(m.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("the review gate", () => {
  const gateFrame = (taskId: string, canApprove = true) =>
    JSON.stringify({ t: "gate", id: "g1", taskId, reason: "reviewer recusou 3×", canApprove });

  it("turns a parked task into a decision and puts the run on attention", async () => {
    const { startRun, listDecisions, listRuns } = await load();
    startRun("p1", PRD_PATH);
    feed(gateFrame("t1"));

    const [d] = listDecisions();
    expect(d).toMatchObject({ taskId: "t1", kind: "review-blocked", reason: "reviewer recusou 3×" });
    expect(listRuns()[0].status).toBe("attention");
  });

  it("answers down stdin instead of writing prd.json — the loop still owns the task", async () => {
    const { startRun, resolveDecision, listDecisions } = await load();
    const id = startRun("p1", PRD_PATH);
    feed(gateFrame("t1"));

    const res = resolveDecision(id, "t1", "accept");
    expect(res.ok).toBe(true);
    expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify({ t: "gate-answer", id: "g1", answer: "approve" }) + "\n");
    // writing the file here would race the process that owns the cell
    expect(m.writeFileSync).not.toHaveBeenCalled();
    expect(listDecisions()).toEqual([]);
  });

  it("keeps the gate answerable when the pipe is already gone", async () => {
    const { startRun, resolveDecision, listDecisions } = await load();
    const id = startRun("p1", PRD_PATH);
    feed(gateFrame("t1"));
    // the child exited while the human was deciding: the answer is not
    // delivered, so nothing may be marked answered or dismissed — the decision
    // has to still be in the inbox, not dropped by a board that forgot it
    child.stdin.destroyed = true;

    const res = resolveDecision(id, "t1", "skip");

    expect(res.ok).toBe(false);
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(listDecisions().map((d) => d.taskId)).toEqual(["t1"]);
  });

  it("maps corrigir to retry and pular to block", async () => {
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);

    feed(gateFrame("t1"));
    resolveDecision(id, "t1", "retry");
    expect(child.stdin.write).toHaveBeenLastCalledWith(expect.stringContaining('"answer":"retry"'));

    feed(gateFrame("t2"));
    resolveDecision(id, "t2", "skip");
    expect(child.stdin.write).toHaveBeenLastCalledWith(expect.stringContaining('"answer":"block"'));
  });

  it("re-snapshots the tree after a retry — the next decision shows the NEW work", async () => {
    const { startRun, resolveDecision, listDecisions } = await load();
    const id = startRun("p1", PRD_PATH);
    m.existsSync.mockReturnValue(true);
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", baseline: "tree123", baselineDir: "/repo" } }));

    m.captureReviewBase.mockReturnValue("FIRST-TRY");
    feed(gateFrame("t1"));
    resolveDecision(id, "t1", "retry");

    // the executor had another go; approving against the first snapshot would
    // mean approving work the reviewer never saw
    m.captureReviewBase.mockReturnValue("SECOND-TRY");
    feed(gateFrame("t1"));
    m.gitOut.mockReturnValue("3\t1\tsrc/a.ts");
    listDecisions();

    expect(numstatCall()).toEqual(expect.arrayContaining(["/repo", "tree123", "SECOND-TRY"]));
  });

  it("refuses to approve a task whose verify never passed", async () => {
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);
    feed(gateFrame("t1", false));

    const res = resolveDecision(id, "t1", "accept");
    expect(res.ok).toBe(false);
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it("keeps a skipped gate out of the inbox after the child records the block", async () => {
    const { startRun, resolveDecision, listDecisions } = await load();
    const id = startRun("p1", PRD_PATH);
    feed(gateFrame("t1"));

    resolveDecision(id, "t1", "skip");
    // the child answers the gate by writing status:blocked, which would rebuild
    // the very decision the user just dismissed
    onDisk.tasks[0].status = "blocked";
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "blocked", reason: "bloqueada" } }));

    expect(listDecisions()).toEqual([]);
  });

  it("says so when the run dies before acting on an answered gate", async () => {
    const { startRun, resolveDecision, getStream } = await load();
    const id = startRun("p1", PRD_PATH);
    feed(gateFrame("t1")); // the loop is holding t1; on disk it is still doing

    resolveDecision(id, "t1", "accept");
    // an approve needs the loop's own verify, commit and cherry-pick. With the
    // run gone none of that happened — the work is not lost (the next run
    // redoes a task left in flight), but the human has to know their answer
    // did not land.
    child.emit("close", 1);

    expect(getStream(id, "t1").map((l) => l.text)).toContainEqual(
      expect.stringContaining("terminou antes de aplicar sua decisão"),
    );
  });

  it("drops parked gates when the child dies — nobody can answer them now", async () => {
    const { startRun, listDecisions } = await load();
    startRun("p1", PRD_PATH);
    feed(gateFrame("t1"));
    expect(listDecisions()).toHaveLength(1);

    child.emit("close", 1);
    expect(listDecisions()).toEqual([]);
  });
});

describe("decisions that outlive their run", () => {
  beforeEach(() => {
    m.listProjects.mockReturnValue([{ id: "p1", name: "qc-colombia", dir: "/repo", addedAt: 0 }]);
    m.findPrdFiles.mockReturnValue([PRD_PATH]);
  });

  it("rebuilds a blocked task from prd.json when no run owns it any more", async () => {
    // after an app restart the run is gone but the backlog is not; without
    // this the task is unreachable short of hand-editing JSON
    onDisk.tasks[0].status = "blocked";
    const { listDecisions } = await load();

    const [d] = listDecisions();
    expect(d).toMatchObject({ runId: null, taskId: "t1", kind: "blocked", prdPath: PRD_PATH, canAccept: false });
  });

  it("does not duplicate a task a live run is already reporting", async () => {
    const { startRun, listDecisions } = await load();
    startRun("p1", PRD_PATH);
    onDisk.tasks[0].status = "blocked";
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "blocked", reason: "review reprovou" } }));

    const ids = listDecisions().map((d) => d.taskId);
    expect(ids).toEqual(["t1"]);
    expect(listDecisions()[0].runId).not.toBeNull();
  });

  it("answers a backlog retry by resetting the task and starting a run", async () => {
    onDisk.tasks[0].status = "blocked";
    const { listDecisions, resolveDecision } = await load();

    const res = resolveDecision(null, "t1", "retry", { projectId: "p1", prdPath: PRD_PATH });

    expect(res.ok).toBe(true);
    expect(JSON.parse(m.writeFileSync.mock.calls[0][1] as string).tasks[0]).toMatchObject({
      id: "t1",
      status: "todo",
      retries: 0,
    });
    expect(m.spawn).toHaveBeenCalledTimes(1);
    // the write went to the mock, so mirror it onto the fake disk the new run
    // reads from — then the decision is gone from both sources
    onDisk.tasks[0].status = "todo";
    expect(listDecisions()).toEqual([]);
  });

  it("refuses to touch the backlog while a ralphrun in another terminal owns it", async () => {
    // THE prd.json rule: only the process running the loop may rewrite it.
    // A CLI run is invisible to the app's own bookkeeping, so the core's
    // workspace lock is the only thing that can say the file is taken.
    onDisk.tasks[0].status = "blocked";
    m.runLockHolder.mockReturnValue(4242);
    const { resolveDecision } = await load();

    const res = resolveDecision(null, "t1", "retry", { projectId: "p1", prdPath: PRD_PATH });

    expect(res.ok).toBe(false);
    expect(res.message).toContain("4242");
    expect(m.writeFileSync).not.toHaveBeenCalled();
    expect(m.spawn).not.toHaveBeenCalled();
  });

  it("puts the task back when the replacement run refuses to start", async () => {
    const { startRun, resolveDecision, listDecisions } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[1] = task("t2", "blocked", { deps: ["t1"], retries: 3 });
    child.emit("close", 0);
    // a ralph.config.json edited since: the reset already landed and nothing is
    // going to run it, so the decision has to come back rather than look answered
    m.loadConfig.mockImplementation(() => {
      throw new Error("ralph.config.json: unexpected token");
    });

    const res = resolveDecision(id, "t2", "retry");

    expect(res.ok).toBe(false);
    expect(res.message).toContain("unexpected token");
    // the file was rolled back to blocked, so the inbox rebuilds the decision
    expect(prdWrites().at(-1)!.tasks[1]).toMatchObject({ id: "t2", status: "blocked" });
    onDisk.tasks[1].status = "blocked";
    expect(listDecisions().map((d) => d.taskId)).toEqual(["t2"]);
  });

  it("refuses a frozen decision the file has since moved past", async () => {
    const { startRun, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[1] = task("t2", "blocked", { deps: ["t1"], retries: 3 });
    child.emit("close", 0); // the board freezes with t2 blocked

    // a LATER run finished it; answering the old inbox item now would reset
    // delivered work back to todo
    onDisk.tasks[1].status = "done";
    m.writeFileSync.mockClear();

    const res = resolveDecision(id, "t2", "retry");

    expect(res.ok).toBe(false);
    expect(res.message).toContain("não vale mais");
    expect(prdWrites()).toHaveLength(0);
  });

  it("refuses to accept one — the work of that attempt is long gone", async () => {
    onDisk.tasks[0].status = "blocked";
    const { resolveDecision } = await load();

    expect(resolveDecision(null, "t1", "accept", { projectId: "p1", prdPath: PRD_PATH }).ok).toBe(false);
    expect(m.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("task diffs", () => {
  it("diffs the baseline tree against a snapshot of the same directory", async () => {
    const { startRun, listDecisions } = await load();
    startRun("p1", PRD_PATH);

    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", baseline: "tree123", baselineDir: "/repo/.ralphrun/worktrees/t1" } }));
    onDisk.tasks[0].status = "blocked";
    m.existsSync.mockReturnValue(true);
    m.gitOut.mockReturnValue("12\t4\tsrc/a.ts");
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "blocked", reason: "review reprovou" } }));

    expect(listDecisions()[0].diffstat).toEqual({ files: 1, added: 12, removed: 4 });
    // TREE vs TREE: a diff against the working copy reports tracked paths only,
    // and a task whose whole contribution is new files would look idle
    expect(numstatCall()).toEqual(
      // prd.json moves on every decision and progress.md grows the whole time;
      // neither is work the executor did, and both would head every diff
      expect.arrayContaining([
        "/repo/.ralphrun/worktrees/t1",
        "diff",
        "--numstat",
        "tree123",
        "NOW",
        "--",
        ":(exclude)prd.json",
        ":(exclude)progress.md",
      ]),
    );
  });

  it("shows no diff for a discarded cell instead of the trunk's changes", async () => {
    const { startRun, listDecisions } = await load();
    startRun("p1", PRD_PATH);

    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", baseline: "tree123", baselineDir: "/repo/.ralphrun/worktrees/t1" } }));
    onDisk.tasks[0].status = "blocked";
    // the loop removed the cell when it gave up; diffing the project checkout
    // instead would present the USER's uncommitted changes as this task's work
    m.existsSync.mockImplementation((p: string) => String(p).endsWith("run-child.js"));
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "blocked", reason: "max retries" } }));

    expect(listDecisions()[0].diffstat).toBeNull();
  });

  it("pins the tree the task ended on, not whatever the checkout holds later", async () => {
    const { startRun, listDecisions } = await load();
    startRun("p1", PRD_PATH);
    m.existsSync.mockReturnValue(true);

    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", baseline: "tree123", baselineDir: "/repo" } }));
    onDisk.tasks[0].status = "blocked";
    m.captureReviewBase.mockReturnValue("AT-BLOCK");
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "blocked", reason: "max retries" } }));

    // the user edits the checkout, or a later run touches it — none of that is
    // this task's work, and the human is judging this task
    m.captureReviewBase.mockReturnValue("MUCH-LATER");
    m.gitOut.mockReturnValue("1\t0\tsrc/a.ts");
    listDecisions();

    expect(numstatCall()).toEqual(expect.arrayContaining(["/repo", "tree123", "AT-BLOCK"]));
  });

  it("shows no diff for a task that never published a baseline", async () => {
    const { startRun, listDecisions } = await load();
    startRun("p1", PRD_PATH);
    onDisk.tasks[0].status = "blocked";
    feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "blocked", reason: "max retries" } }));

    expect(listDecisions()[0].diffstat).toBeNull();
  });
});

describe("stalls", () => {
  it("escalates a task that started and then said nothing at all", async () => {
    vi.useFakeTimers();
    try {
      const { startRun, listDecisions } = await load();
      const id = startRun("p1", PRD_PATH);

      onDisk.tasks[0].status = "doing";
      feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "doing" } }));
      expect(listDecisions()).toEqual([]);

      // silence IS the signal — keying the clock off output lines alone would
      // leave an executor that never printed anything invisible forever
      // the core heartbeats a system line while an executor is silent; if that
      // counted as life a task that never speaks could never look stalled
      feed(JSON.stringify({ t: "log", line: "exec.working" }));

      vi.advanceTimersByTime(11 * 60_000);
      const [d] = listDecisions();
      expect(d).toMatchObject({ runId: id, taskId: "t1", kind: "stall" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("restarting a stalled task", () => {
  it("waits for the child to actually die before resetting the task", async () => {
    vi.useFakeTimers();
    try {
      const { startRun, resolveDecision } = await load();
      const id = startRun("p1", PRD_PATH);
      onDisk.tasks[0].status = "doing";
      feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "doing" } }));
      vi.advanceTimersByTime(11 * 60_000);

      expect(resolveDecision(id, "t1", "retry").ok).toBe(true);
      // SIGTERM is a REQUEST: the child may still be writing its final status,
      // and resetting now would let that write land on top of the retry
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(m.writeFileSync).not.toHaveBeenCalled();
      expect(m.spawn).toHaveBeenCalledTimes(1);

      child.emit("close", null);

      // prdWrites, not the last write of all: the run's own history lands after
      // the reset now, so the backlog write is not the final one
      expect(prdWrites().at(-1)!.tasks[0]).toMatchObject({
        id: "t1",
        status: "todo",
        retries: 0,
      });
      expect(m.spawn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("lifecycle", () => {
  it("keeps a run queued while a terminal ralphrun owns the workspace", async () => {
    const { startRun, listRuns } = await load();
    // no child of OURS is in that repo, so the queue's own bookkeeping sees a
    // free project — only the core's lock knows a CLI run is already there
    m.runLockHolder.mockReturnValue(4242);

    const id = startRun("p1", PRD_PATH);

    // spawning anyway means the core kills the child on startup and the app
    // files a FAILED run for a workspace that was merely busy
    expect(m.spawn).not.toHaveBeenCalled();
    expect(listRuns().find((r) => r.id === id)).toMatchObject({ status: "queued" });
  });

  it("starts the queued run once the outside ralphrun releases the workspace", async () => {
    vi.useFakeTimers();
    try {
      const { startRun } = await load();
      m.runLockHolder.mockReturnValue(4242);
      startRun("p1", PRD_PATH);
      expect(m.spawn).not.toHaveBeenCalled();

      // that process is not ours: nothing will ever notify us it exited, so
      // without a retry the run stays queued until the app restarts
      m.runLockHolder.mockReturnValue(null);
      vi.advanceTimersByTime(10_000);

      expect(m.spawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a replacement run that refuses to start", async () => {
    vi.useFakeTimers();
    try {
      const { startRun, resolveDecision, listDecisions } = await load();
      const id = startRun("p1", PRD_PATH);
      onDisk.tasks[0].status = "doing";
      feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "doing" } }));
      vi.advanceTimersByTime(11 * 60_000);
      resolveDecision(id, "t1", "retry"); // stall restart: waits for the exit

      // a ralph.config.json edited while the run was going. Thrown from the
      // close handler this would end the whole desktop process.
      m.loadConfig.mockImplementation(() => {
        throw new Error("ralph.config.json: unexpected token");
      });
      onDisk.tasks[0].status = "blocked";

      expect(() => child.emit("close", null)).not.toThrow();
      // the task was reset with nothing running it, so it has to be visible
      expect(listDecisions().map((d) => d.taskId)).toEqual(["t1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts a gate the run never applied back where the inbox can see it", async () => {
    const { startRun, resolveDecision, listDecisions } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[0].status = "doing";
    feed(JSON.stringify({ t: "gate", id: "g1", taskId: "t1", reason: "reviewer recusou 3×", canApprove: true }));
    resolveDecision(id, "t1", "accept"); // answered, and the child dies holding it

    child.emit("close", 1);

    // the task is still `doing` on disk and an ended run raises no stall, so
    // un-dismissing alone would leave it invisible everywhere
    expect(prdWrites().at(-1)!.tasks[0]).toMatchObject({ id: "t1", status: "blocked" });
    onDisk.tasks[0].status = "blocked";
    expect(listDecisions().map((d) => d.taskId)).toContain("t1");
  });

  it("does not redo a stalled task that landed while the child was dying", async () => {
    vi.useFakeTimers();
    try {
      const { startRun, resolveDecision } = await load();
      const id = startRun("p1", PRD_PATH);
      onDisk.tasks[0].status = "doing";
      feed(JSON.stringify({ t: "ev", e: { taskId: "t1", status: "doing" } }));
      vi.advanceTimersByTime(11 * 60_000);
      resolveDecision(id, "t1", "restart"); // SIGTERM, then wait for the exit

      // it finished in the meantime: resetting now would throw away work the
      // run already delivered and hand it to a replacement run
      onDisk.tasks[0].status = "done";
      m.writeFileSync.mockClear();
      child.emit("close", null);

      expect(prdWrites()).toHaveLength(0);
      expect(m.spawn).toHaveBeenCalledTimes(1); // no replacement run either
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the frozen board it actually ends with", async () => {
    const { startRun, listRuns, resolveDecision } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks[0].status = "doing";
    feed(JSON.stringify({ t: "gate", id: "g1", taskId: "t1", reason: "reviewer recusou 3×", canApprove: true }));
    resolveDecision(id, "t1", "accept"); // answered, and the child dies holding it

    child.emit("close", 1);

    // the recovery moved t1 to blocked, so a board reporting doing:1 blocked:0
    // would contradict the very decision the inbox is showing
    expect(listRuns()[0]).toMatchObject({ doing: 0, blocked: 1 });
  });

  it("records a user-requested pause as paused, not as a failed run", async () => {
    const { startRun, stopRun, listRuns } = await load();
    const id = startRun("p1", PRD_PATH);

    stopRun(id);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    // SIGTERM makes the child exit with code null, which the exit code alone
    // cannot tell apart from a crash — the intent has to survive the kill, or
    // every pause the user asked for is filed (and persisted) as a failure.
    child.emit("close", null);

    expect(listRuns()[0]).toMatchObject({ status: "paused", endedAt: expect.any(Number) });
  });

  it("still reports a crash as failed", async () => {
    const { startRun, listRuns } = await load();
    startRun("p1", PRD_PATH);
    child.emit("close", 1);
    expect(listRuns()[0].status).toBe("failed");
  });

  it("ends a clean run as done", async () => {
    const { startRun, listRuns } = await load();
    startRun("p1", PRD_PATH);
    onDisk.tasks = [task("t1", "done"), task("t2", "done", { deps: ["t1"] })];
    child.emit("close", 0);
    expect(listRuns()[0].status).toBe("done");
  });

  it("does not call a run done while tasks are still todo", async () => {
    const { startRun, listRuns } = await load();
    startRun("p1", PRD_PATH);
    // the loop exits cleanly after a failed wave-integration verify too, with
    // later tasks untouched — reporting that as success would be a lie
    onDisk.tasks = [task("t1", "done"), task("t2", "todo", { deps: ["t1"] })];
    child.emit("close", 0);
    expect(listRuns()[0].status).toBe("attention");
  });

  it("ends a run that left a task blocked as attention, not done", async () => {
    const { startRun, listRuns } = await load();
    startRun("p1", PRD_PATH);
    onDisk.tasks = [task("t1", "done"), task("t2", "blocked", { deps: ["t1"] })];
    child.emit("close", 0);
    expect(listRuns()[0].status).toBe("attention");
  });

  it("freezes the board a finished run ended with", async () => {
    const { startRun, getRunDetail } = await load();
    const id = startRun("p1", PRD_PATH);
    onDisk.tasks = [task("t1", "done"), task("t2", "blocked", { deps: ["t1"] })];
    child.emit("close", 0);

    // a LATER run rewrites the same prd.json; the finished one is history and
    // must keep reporting what it actually did
    onDisk.tasks = [task("t1", "done"), task("t2", "done", { deps: ["t1"] })];
    expect(getRunDetail(id).tasks.map((t) => t.status)).toEqual(["done", "blocked"]);
    expect(getRunDetail(id).blocked).toBe(1);
  });

  it("dedupes on the RESOLVED path — two spellings are one backlog", async () => {
    const { startRun } = await load();
    const first = startRun("p1", PRD_PATH);
    // the same file as a caller coming through a relative path would spell it;
    // two rival loops over one repo is the failure this prevents
    const again = startRun("p1", "/repo/./prd.json");
    expect(again).toBe(first);
    expect(m.spawn).toHaveBeenCalledTimes(1);
  });
});
