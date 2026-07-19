// advisor.test.ts — unit tests for getAdvice + advisorReview
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("./adapters.js", () => ({ buildCmd: vi.fn(() => ["bin", "-p", "x"]) }));
vi.mock("./log.js", () => ({ log: vi.fn() }));
vi.mock("./git.js", () => ({ captureDiff: vi.fn() }));
vi.mock("./tui/events.js", () => ({ emit: vi.fn() }));
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

import { killTree, spawn } from "./spawn.js";
import { log } from "./log.js";
import { captureDiff } from "./git.js";
import { parseReview } from "./prompts.js";
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
});

describe("advisorReview", () => {
  it("approves immediately on empty diff without spawning", async () => {
    diffMock.mockReturnValue("   ");
    expect(await advisorReview(task, prd, advis, cfg, "ws", "prog", "std")).toEqual({
      approved: true,
      changes: "",
      diff: "   ",
    });
    expect(spawnMock).not.toHaveBeenCalled();
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

  it("approves and logs when review CLI throws synchronously", async () => {
    diffMock.mockReturnValue("some diff");
    spawnMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(await advisorReview(task, prd, advis, cfg, "ws", "prog", "std")).toEqual({
      approved: true,
      changes: "",
      diff: "some diff",
    });
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("review failed"));
  });

  it("approves and logs when review CLI fires error event", async () => {
    diffMock.mockReturnValue("some diff");
    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    errorSpawn();
    expect(await p).toEqual({
      approved: true,
      changes: "",
      diff: "some diff",
    });
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("review failed"));
  });
});
