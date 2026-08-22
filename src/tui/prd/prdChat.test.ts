// prdChat.test.ts — runPlannerTurn with a scripted fake child process.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("../../adapters.js", () => ({ buildCmd: vi.fn(() => ["mybin", "a1"]), promptViaStdin: vi.fn(() => false) }));
vi.mock("../../cursor-sdk.js", () => ({ runCursorSdk: vi.fn() }));
// releasePipes stays REAL: it operates on the fake child's actual streams
vi.mock("../../spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../spawn.js")>()),
  spawn: vi.fn(),
  killTree: vi.fn(),
}));

import { promptViaStdin } from "../../adapters.js";
import { killTree, spawn } from "../../spawn.js";
import { buildCmd } from "../../adapters.js";
import { runCursorSdk } from "../../cursor-sdk.js";
import { runPlannerTurn, type PlannerTurnArgs } from "./prdChat.js";
import type { PRD } from "../../prd.js";

const spawnMock = spawn as unknown as Mock;
const killTreeMock = killTree as unknown as Mock;
const buildCmdMock = buildCmd as unknown as Mock;

function makeProc() {
  const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: Mock };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}
const tick = () => new Promise((r) => setImmediate(r));

const VALID: PRD = {
  project: "p",
  stack: "s",
  architecture_notes: "a",
  tasks: [
    { id: "A", title: "A", status: "todo", deps: [], retries: 0, description: "d", acceptance: [], scope: [], verify: "v" },
    { id: "B", title: "B", status: "todo", deps: ["A"], retries: 0, description: "d", acceptance: [], scope: [], verify: "v" },
  ],
};
const VALID_JSON = JSON.stringify(VALID);

async function run(lines: string[], over: Partial<PlannerTurnArgs> = {}) {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const onChunk = vi.fn();
  const p = runPlannerTurn({
    cli: "claude",
    model: "m",
    cwd: "/w",
    currentPrd: null,
    history: [],
    instruction: "do it",
    attachments: [],
    onChunk,
    ...over,
  });
  for (const l of lines) proc.stdout.write(l + "\n");
  await tick();
  proc.emit("close", 0);
  const res = await p;
  return { res, onChunk, proc };
}

beforeEach(() => vi.clearAllMocks());

it("parses a valid reply: summary before fence + fenced json, streams every line", async () => {
  const { res, onChunk } = await run(["Drafted the plan", "", "```json", VALID_JSON, "```"]);
  expect(res).toEqual({ summary: "Drafted the plan", prd: VALID, errors: [] });
  expect(onChunk).toHaveBeenCalledWith("Drafted the plan");
  expect(onChunk).toHaveBeenCalledWith("```json");
  // currentPrd null -> prompt says "none yet"
  expect(buildCmdMock.mock.calls[0][1]).toContain("none yet");
  expect(spawnMock).toHaveBeenCalledWith("mybin", ["a1"], expect.objectContaining({ cwd: "/w" }));
  // planner is chat-only: never spawned with auto-approve (skip-permissions) flags
  expect(buildCmdMock.mock.calls[0][4]).toBe(false);
});

// NOT spawn's own `signal` option: that only SIGTERMs the direct child, which
// leaves the agent's descendants alive.
it("aborting mid-turn kills the whole tree instead of handing the signal to spawn", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const ac = new AbortController();
  const p = runPlannerTurn({ cli: "claude", model: "m", cwd: "/w", currentPrd: null, history: [], instruction: "i", attachments: [], onChunk: vi.fn(), signal: ac.signal });
  expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("signal");
  proc.stdout.write(["s", "```json", VALID_JSON, "```"].join("\n") + "\n");
  await tick();
  ac.abort();
  expect(killTreeMock).toHaveBeenCalledWith(proc);
  // settles on the abort itself — NOT on a later 'close' that may never come,
  // and the streamed reply is discarded so a torn-down wizard gets nothing.
  expect(await p).toEqual({ summary: "", prd: null, errors: [] });
  proc.emit("close", 0); // late close: no-op
  expect(await p).toEqual({ summary: "", prd: null, errors: [] });
});

it("an already-aborted signal kills before any output and still settles", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runPlannerTurn({
    cli: "claude",
    model: "m",
    cwd: "/w",
    currentPrd: null,
    history: [],
    instruction: "i",
    attachments: [],
    onChunk: vi.fn(),
    signal: AbortSignal.abort(),
  });
  expect(killTreeMock).toHaveBeenCalledWith(proc);
  expect(await p).toEqual({ summary: "", prd: null, errors: [] });
});

it("pipes the prompt into stdin when the planner cli reads it there", async () => {
  vi.mocked(promptViaStdin).mockReturnValueOnce(true);
  const proc = makeProc() as ReturnType<typeof makeProc> & { stdin: PassThrough };
  proc.stdin = new PassThrough();
  const written: string[] = [];
  proc.stdin.on("data", (d: Buffer) => written.push(d.toString()));
  spawnMock.mockReturnValue(proc);
  const p = runPlannerTurn({
    cli: "claude",
    model: "m",
    cwd: "/w",
    currentPrd: null,
    history: [],
    instruction: "do it",
    attachments: [],
    onChunk: vi.fn(),
  });
  expect(spawnMock.mock.calls[0][2].stdio[0]).toBe("pipe");
  await tick();
  expect(written.join("")).toContain("You are the planner");
  proc.emit("close", 0);
  await p;
});

it("injects current PRD json, chat history, and attachment contents into the prompt", async () => {
  await run(["sum", "", "```json", VALID_JSON, "```"], {
    currentPrd: VALID,
    history: [{ role: "you", text: "make it faster" }],
    attachments: [{ path: "notes.md", content: "SECRET-CONTENT", truncated: false, ok: true }],
  });
  const prompt = buildCmdMock.mock.calls[0][1] as string;
  expect(prompt).toContain('"project": "p"'); // current PRD stringified
  expect(prompt).toContain("Task numbers (1-based, as shown to the user): 1=A 2=B"); // "task 15" -> id mapping
  expect(prompt).toContain("you: make it faster"); // history mapped
  expect(prompt).toContain("## Attached reference: notes.md");
  expect(prompt).toContain("SECRET-CONTENT");
});

it("instructs the planner to use context-aware verify quality gates", async () => {
  await run(["sum", "", "```json", VALID_JSON, "```"]);
  const prompt = buildCmdMock.mock.calls[0][1] as string;
  expect(prompt).toContain("Choose verify commands as context-aware quality gates");
  expect(prompt).toContain("npm run typecheck && npm run test -- tests/foo.test.ts");
  expect(prompt).toContain("Do not mark a task done if typecheck/lint/build is known to fail");
});

// planners chain everything sequentially because that is how work is described
// in natural language, and a narrow graph makes the rest of the pipeline
// pointless — the fake-edge test is the instruction that widens it.
it("instructs the planner to declare deps only for consumed artifacts, and to scope tasks", async () => {
  await run(["sum", "", "```json", VALID_JSON, "```"]);
  const prompt = buildCmdMock.mock.calls[0][1] as string;
  expect(prompt).toContain("declare an edge ONLY when the task CONSUMES an artifact");
  expect(prompt).toContain("would this task FAIL if it ran first?");
  expect(prompt).toContain("do not manufacture parallelism");
  expect(prompt).toContain("must not declare overlapping scope");
  expect(prompt).toContain("acceptance item as a CHECKABLE statement");
  expect(prompt).toContain("add an integration task whose verify");
  expect(prompt).toContain("scope[]"); // the field is in the announced json shape
});

it("notes truncated attachments and flags unreadable ones in the prompt", async () => {
  await run(["sum", "", "```json", VALID_JSON, "```"], {
    attachments: [
      { path: "big.md", content: "chunk", truncated: true, ok: true },
      { path: "gone.md", content: "", truncated: false, ok: false },
    ],
  });
  const prompt = buildCmdMock.mock.calls[0][1] as string;
  expect(prompt).toContain("…(truncated at 12000 chars)");
  expect(prompt).toContain("## Attached reference: gone.md\n(error: could not read the file)");
});

it("coerces invented statuses/missing defaults instead of rejecting the draft", async () => {
  const messy = JSON.stringify({
    project: "p",
    stack: "s",
    architecture_notes: "a",
    tasks: [
      { id: "A", title: "A", status: "PENDING", description: "d", verify: "v" }, // invented status + missing fields
      { id: "B", title: "B", status: "Done", deps: ["A"], retries: 1, description: "d", acceptance: ["x"], verify: "v" }, // case
      { id: "C", title: "C", status: 5, deps: [], retries: 0, description: "d", acceptance: [], verify: "v" }, // non-string status
    ],
  });
  const { res } = await run(["sum", "", "```json", messy, "```"]);
  expect(res.errors).toEqual([]);
  expect(res.prd!.tasks[0]).toMatchObject({ status: "todo", retries: 0, deps: [], acceptance: [] });
  expect(res.prd!.tasks[1].status).toBe("done");
  expect(res.prd!.tasks[2].status).toBe("todo");
});

it("keeps an in-flight 'doing' status (planner path matches the old normalizeDraft)", async () => {
  const doing = JSON.stringify({
    project: "p",
    stack: "s",
    architecture_notes: "a",
    tasks: [
      { id: "A", title: "A", status: "doing", deps: [], retries: 0, description: "d", acceptance: [], verify: "v" },
    ],
  });
  const { res } = await run(["s", "", "```json", doing, "```"]);
  expect(res.errors).toEqual([]);
  expect(res.prd!.tasks[0].status).toBe("doing");
});

it("normalize tolerates junk shapes (non-object task, non-array tasks) and validation still rejects", async () => {
  const { res: r1 } = await run(["s", "", "```json", '{"project":"p","stack":"s","architecture_notes":"a","tasks":[42]}', "```"]);
  expect(r1.prd).toBeNull(); // task[0] must be an object
  const { res: r2 } = await run(["s", "", "```json", '{"project":"p","stack":"s","architecture_notes":"a","tasks":{}}', "```"]);
  expect(r2.prd).toBeNull(); // tasks must be an array
});

it("tells the planner the allowed status enum in the prompt", async () => {
  await run(["s", "", "```json", VALID_JSON, "```"]);
  const prompt = buildCmdMock.mock.calls[0][1] as string;
  expect(prompt).toContain('"todo" | "doing" | "done" | "blocked"');
});

it("no fence -> prd null with the no-json error and empty summary", async () => {
  const { res } = await run(["just chatting", "no code here"]);
  expect(res.errors[0]).toBe("no valid PRD json found in planner output");
  // the raw reply is dumped to temp so the failure stays investigable
  expect(res.errors).toHaveLength(2);
  expect(res.errors[1]).toMatch(/ralphrun-planner-\d+\.log$/);
});

it("the dumped raw output is the planner's full stdout+stderr", async () => {
  const { readFileSync, unlinkSync } = await import("node:fs");
  const lines = ["line one", "tool activity", "never a ```json fence"];
  const { res } = await run(lines);
  expect(res.prd).toBeNull();
  const path = /saved to (\S+)/.exec(res.errors[1])?.[1] ?? "";
  expect(readFileSync(path, "utf8")).toBe(lines.join("\n"));
  unlinkSync(path);
});

it("bad json inside the fence -> prd null, summary preserved", async () => {
  const { res } = await run(["mysummary", "", "```json", "{not valid}", "```"]);
  expect(res.prd).toBeNull();
  expect(res.summary).toBe("mysummary");
  expect(res.errors[0]).toBe("no valid PRD json found in planner output");
  expect(res.errors).toHaveLength(2); // + raw-saved hint
});

it("valid json but failing validatePrd -> prd null with validator errors", async () => {
  const { res } = await run(["s", "", "```json", "{}", "```"]);
  expect(res.prd).toBeNull();
  expect(res.errors.length).toBeGreaterThan(0);
  expect(res.errors).not.toContain("no valid PRD json found in planner output");
});

it("fence with no '{' -> prd null; empty pre-fence summary via ?? fallback", async () => {
  const { res } = await run(["```json", "no braces here", "```"]);
  expect(res.summary).toBe("");
  expect(res.prd).toBeNull();
  expect(res.errors[0]).toBe("no valid PRD json found in planner output");
});

it("open brace with no closing brace -> end<=start branch, prd null", async () => {
  const { res } = await run(["s", "", "```json", "{ oops", "```"]);
  expect(res.prd).toBeNull();
});

it("missing closing fence still parses (close === -1 branch)", async () => {
  const { res } = await run(["s", "", "```json", VALID_JSON]);
  expect(res.prd).toEqual(VALID);
});

it("kills the process on timeout", async () => {
  vi.useFakeTimers();
  try {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const onChunk = vi.fn();
    const p = runPlannerTurn({
      cli: "claude",
      model: "m",
      cwd: "/w",
      currentPrd: null,
      history: [],
      instruction: "x",
      attachments: [],
      onChunk,
    });
    vi.advanceTimersByTime(600_000);
    expect(killTreeMock).toHaveBeenCalledWith(proc);
    proc.emit("close", null);
    const res = await p;
    expect(res.prd).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// a grandchild outliving the kill holds the pipes open -> no 'close' ever
it("settles on whatever it parsed when 'close' never follows the timeout kill", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); // setImmediate stays real for readline
  try {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runPlannerTurn({
      cli: "claude",
      model: "m",
      cwd: "/w",
      currentPrd: null,
      history: [],
      instruction: "x",
      attachments: [],
      onChunk: vi.fn(),
    });
    proc.stdout.write("half a plan\n");
    await tick(); // let readline emit the line before the clock jumps
    await vi.advanceTimersByTimeAsync(600_000); // timeout -> kill
    await vi.advanceTimersByTimeAsync(5_000); // grace elapses, no close
    // settles instead of hanging: the partial output is parsed, PRD is rejected
    const res = await p;
    expect(res.prd).toBeNull();
    expect(res.errors.length).toBeGreaterThan(0);
  } finally {
    vi.useRealTimers();
  }
});

it("spawn error -> prd null; a later close is a no-op (single-settle)", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const onChunk = vi.fn();
  const p = runPlannerTurn({
    cli: "claude",
    model: "m",
    cwd: "/w",
    currentPrd: null,
    history: [],
    instruction: "x",
    attachments: [],
    onChunk,
  });
  proc.emit("error", new Error("boom"));
  proc.emit("close", 0); // settled guard: no-op
  const res = await p;
  expect(res).toEqual({ summary: "", prd: null, errors: ["failed to spawn planner"] });
});

// An in-process planner has no argv: buildCmd would throw, and a throw here
// rejects the turn promise, which mount.ts turns into a DEAD wizard — taking
// the unsaved PRD with it.
describe("in-process planner", () => {
  const sdkRun = runCursorSdk as unknown as Mock;
  const turn = (onChunk = vi.fn()) =>
    runPlannerTurn({
      cli: "cursorsdk",
      model: "composer-2",
      cwd: "/w",
      currentPrd: null,
      history: [],
      instruction: "x",
      attachments: [],
      onChunk,
    });

  it("parses the run result and never spawns", async () => {
    sdkRun.mockImplementation(async (a: { onEvent: (e: { text: string }) => void }) => {
      a.onEvent({ text: "" }); // renders nothing: not a chat chunk
      a.onEvent({ text: "thinking out loud" });
      return { status: "finished", result: "sum\n\n```json\n" + VALID_JSON + "\n```", error: "" };
    });
    const onChunk = vi.fn();
    const res = await turn(onChunk);
    expect(res.prd).toEqual(VALID);
    expect(res.summary).toBe("sum");
    expect(onChunk).toHaveBeenCalledExactlyOnceWith("thinking out loud");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(buildCmdMock).not.toHaveBeenCalled();
    expect(sdkRun.mock.calls[0][0]).toMatchObject({ model: "composer-2", cwd: "/w", mode: "plan" });
  });

  it("turns a failed run into a failed TURN, not a rejection", async () => {
    sdkRun.mockResolvedValue({ status: "error", result: "", error: "boom" });
    expect(await turn()).toEqual({ summary: "", prd: null, errors: ["boom"] });
  });

  it("reports a timeout (which carries no message) like unparseable output", async () => {
    sdkRun.mockResolvedValue({ status: "timeout", result: "", error: "" });
    const res = await turn();
    expect(res.prd).toBeNull();
    expect(res.errors).toHaveLength(1);
  });

  it("settles an aborted turn empty, same as a killed child", async () => {
    sdkRun.mockResolvedValue({ status: "aborted", result: "", error: "" });
    expect(await turn()).toEqual({ summary: "", prd: null, errors: [] });
  });
});
