// prdChat.test.ts — runPlannerTurn with a scripted fake child process.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("../../adapters.js", () => ({ buildCmd: vi.fn(() => ["mybin", "a1"]) }));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { buildCmd } from "../../adapters.js";
import { runPlannerTurn, type PlannerTurnArgs } from "./prdChat.js";
import type { PRD } from "../../prd.js";

const spawnMock = spawn as unknown as Mock;
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
    { id: "A", title: "A", status: "todo", deps: [], retries: 0, description: "d", acceptance: [] },
    { id: "B", title: "B", status: "todo", deps: ["A"], retries: 0, description: "d", acceptance: [] },
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

it("passes the abort signal through to spawn so teardown kills the child", async () => {
  const ac = new AbortController();
  await run(["s", "", "```json", VALID_JSON, "```"], { signal: ac.signal });
  expect(spawnMock).toHaveBeenCalledWith("mybin", ["a1"], expect.objectContaining({ signal: ac.signal }));
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
      { id: "A", title: "A", status: "PENDING", description: "d" }, // invented status + missing fields
      { id: "B", title: "B", status: "Done", deps: ["A"], retries: 1, description: "d", acceptance: ["x"] }, // case fix
      { id: "C", title: "C", status: 5, deps: [], retries: 0, description: "d", acceptance: [] }, // non-string status
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
    tasks: [{ id: "A", title: "A", status: "doing", deps: [], retries: 0, description: "d", acceptance: [] }],
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
  expect(res).toEqual({ summary: "", prd: null, errors: ["no valid PRD json found in planner output"] });
});

it("bad json inside the fence -> prd null, summary preserved", async () => {
  const { res } = await run(["mysummary", "", "```json", "{not valid}", "```"]);
  expect(res.prd).toBeNull();
  expect(res.summary).toBe("mysummary");
  expect(res.errors).toEqual(["no valid PRD json found in planner output"]);
});

it("valid json but failing validatePrd -> prd null with validator errors", async () => {
  const { res } = await run(["s", "", "```json", "{}", "```"]);
  expect(res.prd).toBeNull();
  expect(res.errors.length).toBeGreaterThan(0);
  expect(res.errors).not.toContain("no valid PRD json found in planner output");
});

it("fence with no '{' -> prd null; empty pre-fence summary via ?? fallback", async () => {
  const { res } = await run(["```json", "no braces here", "```"]);
  expect(res).toEqual({ summary: "", prd: null, errors: ["no valid PRD json found in planner output"] });
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
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null);
    const res = await p;
    expect(res.prd).toBeNull();
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
