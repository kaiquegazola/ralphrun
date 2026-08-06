// advisor.test.ts — unit tests for getAdvice + advisorReview
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("./adapters.js", () => ({ buildCmd: vi.fn(() => ["bin", "-p", "x"]), promptViaStdin: vi.fn(() => false) }));
vi.mock("./log.js", () => ({ log: vi.fn() }));
vi.mock("./git.js", () => ({ captureDiff: vi.fn() }));
vi.mock("./tui/events.js", () => ({ emit: vi.fn() }));
vi.mock("./cursor-sdk.js", () => ({ runCursorSdkText: vi.fn(async () => "ADVICE") }));
vi.mock("./prompts.js", () => ({
  advisorPrompt: vi.fn(() => "ap"),
  reviewPrompt: vi.fn(() => "rp"),
  parseReview: vi.fn(() => ({ approved: false, changes: "do x" })),
}));

// We must use actual streams so readline works
import { PassThrough } from "node:stream";
const mockChild = {
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  on: vi.fn(),
  kill: vi.fn(),
};
vi.mock("./spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spawn.js")>()),
  spawn: vi.fn(() => mockChild),
  killTree: vi.fn(),
}));

import { promptViaStdin } from "./adapters.js";
import { killTree, spawn } from "./spawn.js";
import { log } from "./log.js";
import { captureDiff } from "./git.js";
import { parseReview } from "./prompts.js";
import { runCursorSdkText } from "./cursor-sdk.js";
import { getAdvice, advisorReview } from "./advisor.js";
import { emit } from "./tui/events.js";
import type { AgentSpec, Config } from "./config.js";
import type { PRD, Task } from "./prd.js";

const spawnMock = spawn as unknown as Mock;
const killTreeMock = killTree as unknown as Mock;
const diffMock = captureDiff as unknown as Mock;
const emitMock = vi.mocked(emit);

const advis: AgentSpec = { cli: "claude", model: "fable" };
const cfg = { advisor_timeout: 300 } as unknown as Config;
const task = { id: "T1", title: "t", acceptance: [] } as unknown as Task;
const prd = { project: "p", stack: "s", architecture_notes: "" } as unknown as PRD;

beforeEach(() => {
  vi.clearAllMocks();
  mockChild.stdout = new PassThrough();
  mockChild.stderr = new PassThrough();
  mockChild.on.mockReset();
});

function finishSpawn(code = 0) {
  const calls = mockChild.on.mock.calls;
  for (const [event, cb] of calls) {
    if (event === "close") cb(code);
  }
}

function errorSpawn(err = new Error("nope")) {
  const calls = mockChild.on.mock.calls;
  for (const [event, cb] of calls) {
    if (event === "error") cb(err);
  }
}

describe("getAdvice", () => {
  it("returns trimmed advice on success and logs char count", async () => {
    const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("  advice text  \n");
    finishSpawn(0);
    const r = await p;
    expect(r).toBe("advice text");
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("→ 11 chars"));
    expect(emitMock).toHaveBeenCalledWith({ taskId: "T1", line: "  advice text  ", lineSource: "advisor" });
  });

  it("returns null when advice is empty (whitespace only)", async () => {
    const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("   \n");
    finishSpawn(0);
    expect(await p).toBeNull();
  });

  it("handles missing stdout (?? fallback)", async () => {
    const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("");
    finishSpawn(0);
    expect(await p).toBeNull();
  });

  it("returns null and logs failure when spawn throws", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("nope");
    });
    expect(await getAdvice(task, prd, advis, cfg, "ws", "prog", "std")).toBeNull();
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("advisor failed"));
  });

  it("returns null and logs failure when child error event fires", async () => {
    const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
    errorSpawn();
    expect(await p).toBeNull();
  });

  // an in-process advisor has no command line; its RunResult IS the string the
  // spawn path would have accumulated from stdout
  it("routes an sdk advisor to the SDK runner instead of spawning", async () => {
    const sdk: AgentSpec = { cli: "cursorsdk", model: "composer-2" };
    expect(await getAdvice(task, prd, sdk, cfg, "ws", "prog", "std")).toBe("ADVICE");
    expect(runCursorSdkText).toHaveBeenCalledWith(sdk, "ap", cfg, "ws", "T1", "advisor");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("advisorReview", () => {
  // an empty diff means the task produced no work — approving it is how a task
  // reached `done` with nothing having been written, let alone reviewed
  it("rejects an empty diff without spawning, with feedback the executor can act on", async () => {
    diffMock.mockReturnValue("   ");
    const r = await advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    expect(r.approved).toBe(false);
    expect(r.changes).toContain("NO changes");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("no changes"));
  });

  it("delegates to parseReview on success", async () => {
    diffMock.mockReturnValue("some diff");
    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("CHANGES: x\n");
    finishSpawn(0);
    const r = await p;
    expect(parseReview).toHaveBeenCalledWith("CHANGES: x");
    expect(r).toEqual({ approved: false, changes: "do x", diff: "some diff" });
    expect(emitMock).toHaveBeenCalledWith({ taskId: "T1", line: "CHANGES: x", lineSource: "review" });
  });

  it("emits an approval verdict and compacts oversized reviewer output", async () => {
    diffMock.mockReturnValue("some diff");
    vi.mocked(parseReview).mockReturnValueOnce({ approved: true, changes: "" });
    let p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("APPROVE\n");
    finishSpawn(0);
    await p;
    expect(emitMock).toHaveBeenCalledWith({ taskId: "T1", line: "APPROVE", lineSource: "review" });

    // Reset streams for next call
    mockChild.stdout = new PassThrough();
    mockChild.stderr = new PassThrough();
    mockChild.on.mockReset();

    vi.mocked(parseReview).mockReturnValueOnce({ approved: false, changes: "x".repeat(600) });
    p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("x".repeat(600) + "\n");
    finishSpawn(0);
    await p;
    expect(emitMock.mock.calls.at(-1)?.[0].line).toHaveLength(500);

    // Reset streams for next call
    mockChild.stdout = new PassThrough();
    mockChild.stderr = new PassThrough();
    mockChild.on.mockReset();
    mockChild.on.mockReset();

    vi.mocked(parseReview).mockReturnValueOnce({ approved: false, changes: "" });
    p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("review output without changes\n");
    finishSpawn(0);
    await p;
    expect(emitMock.mock.calls.at(-1)?.[0].line).toContain("review output");
  });

  // claude/codex read the prompt from stdin so it stays out of the argv, which
  // is what keeps a 25k review prompt under cmd.exe's ~8191 char limit
  it("pipes the review prompt into stdin when the cli reads it there", async () => {
    vi.mocked(promptViaStdin).mockReturnValueOnce(true);
    const stdin = new PassThrough();
    const written: string[] = [];
    stdin.on("data", (d: Buffer) => written.push(d.toString()));
    (mockChild as unknown as { stdin: PassThrough }).stdin = stdin;
    diffMock.mockReturnValue("some diff");

    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    expect(spawnMock.mock.calls[0][2].stdio[0]).toBe("pipe");
    await new Promise((r) => setImmediate(r));
    expect(written.join("")).toBe("rp"); // reviewPrompt is mocked to "rp"
    mockChild.stdout.end("APPROVE\n");
    finishSpawn(0);
    await p;
  });

  it("kills process on timeout", async () => {
    vi.useFakeTimers();
    const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
    vi.advanceTimersByTime(300_000);
    expect(killTreeMock).toHaveBeenCalledWith(mockChild);
    finishSpawn(1);
    await p;
    vi.useRealTimers();
  });

  // a grandchild that outlives the kill keeps the pipes open, so 'close' can
  // never arrive — the advisor must not wedge the whole loop waiting for it.
  it("settles after the kill grace when 'close' never fires", async () => {
    vi.useFakeTimers();
    try {
      const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
      vi.advanceTimersByTime(300_000); // timeout -> kill
      vi.advanceTimersByTime(5_000); // grace elapses, no close
      expect(await p).toBeNull();
      expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("advisor failed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a 'close' that arrives after the grace already settled is a no-op", async () => {
    vi.useFakeTimers();
    try {
      const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
      vi.advanceTimersByTime(305_000);
      expect(await p).toBeNull();
      mockChild.stdout.end("late advice\n");
      finishSpawn(0); // must not throw / re-resolve
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("passes the task baseline to the diff capture", async () => {
    diffMock.mockReturnValue("some diff");
    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std", "base-commit");
    mockChild.stdout.end("CHANGES: x\n");
    finishSpawn(0);
    await p;
    expect(diffMock).toHaveBeenCalledWith("ws", "base-commit");
  });

  // A reviewer that never answered has judged nothing, so it cannot approve.
  // `changes` stays empty: there is nothing for the executor to fix, which is
  // what makes run.ts break out of the fix loop instead of spinning on it.
  it("does NOT approve and logs when review CLI throws synchronously", async () => {
    diffMock.mockReturnValue("some diff");
    spawnMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(await advisorReview(task, prd, advis, cfg, "ws", "prog", "std")).toEqual({
      approved: false,
      changes: "",
      diff: "some diff",
    });
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("NOT approving"));
  });

  it("does NOT approve and logs when review CLI fires error event", async () => {
    diffMock.mockReturnValue("some diff");
    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    errorSpawn();
    expect(await p).toEqual({
      approved: false,
      changes: "",
      diff: "some diff",
    });
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("NOT approving"));
  });

  // neither APPROVE nor CHANGES: not an approval, and the raw text has to reach
  // progress.md or the human deciding on the blocked task has nothing to go on
  it("logs what an unparseable verdict actually said", async () => {
    diffMock.mockReturnValue("some diff");
    vi.mocked(parseReview).mockReturnValueOnce({ approved: false, changes: "" });
    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("I would rather not judge this\n");
    finishSpawn(0);
    expect(await p).toEqual({ approved: false, changes: "", diff: "some diff" });
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("I would rather not judge this"));
  });
});
