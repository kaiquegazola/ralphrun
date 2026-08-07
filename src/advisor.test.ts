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

import { buildCmd, promptViaStdin } from "./adapters.js";
import { killTree, spawn } from "./spawn.js";
import { log } from "./log.js";
import { captureDiff } from "./git.js";
import { parseReview, reviewPrompt } from "./prompts.js";
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
  // Whether a task can be satisfied with no change at all is a judgement about
  // that task, so it goes to the reviewer like any other verdict — the loop
  // neither approves it (done with nothing written) nor rejects it (blocking
  // every task that legitimately needs no change).
  it("still asks the reviewer when the diff is empty, and honours its verdict", async () => {
    diffMock.mockReturnValue("   ");
    vi.mocked(parseReview).mockReturnValueOnce({ approved: true, changes: "" });
    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("APPROVE\n");
    finishSpawn(0);
    expect(await p).toEqual({ approved: true, changes: "", diff: "   " });
    expect(spawnMock).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("changed nothing"));
  });

  // The verify verdict is evidence about the same attempt as the diff, so it has
  // to survive the trip from run.ts to the prompt — the reviewer used to judge a
  // diff without knowing whether anything ran on it.
  it("carries the verify verdict from the caller into the review prompt", async () => {
    diffMock.mockReturnValue("some diff");
    const verification = { passed: false, output: "1 failing" };
    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std", "base", verification);
    mockChild.stdout.end("CHANGES: x\n");
    finishSpawn(0);
    await p;
    expect(reviewPrompt).toHaveBeenCalledWith(task, prd, "std", "some diff", verification, false);
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
  // The review is the call with something to inspect: its diff is truncated and
  // can be empty. Guidance runs before any code exists, so it stays text-only —
  // and autoApprove is false on BOTH, or the advisor could write to the workspace.
  it("asks for read-only tools on the review call and not on the advice call", async () => {
    diffMock.mockReturnValue("some diff");
    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("APPROVE\n");
    finishSpawn(0);
    await p;
    expect(buildCmd).toHaveBeenCalledWith("claude", "rp", "fable", "ws", false, "read");

    mockChild.stdout = new PassThrough();
    mockChild.stderr = new PassThrough();
    mockChild.on.mockReset();

    const a = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("advice\n");
    finishSpawn(0);
    await a;
    expect(buildCmd).toHaveBeenLastCalledWith("claude", "ap", "fable", "ws", false, "none");
  });

  // Off by default is the whole safety of this mode: it is the largest per-round
  // cost multiplier there is, so a config that never mentions it must review
  // exactly the way it did before.
  it("does not grant execution unless the config asked for it", async () => {
    diffMock.mockReturnValue("some diff");
    const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("APPROVE\n");
    finishSpawn(0);
    await p;
    expect(buildCmd).toHaveBeenCalledWith("claude", "rp", "fable", "ws", false, "read");
    expect(vi.mocked(reviewPrompt).mock.calls[0][5]).toBe(false);
  });

  it("grants execution, its own timeout and the running prompt when review_runs_commands is on", async () => {
    vi.useFakeTimers();
    try {
      diffMock.mockReturnValue("some diff");
      const execCfg = { ...cfg, review_runs_commands: true, review_timeout: 900 } as unknown as Config;
      const p = advisorReview(task, prd, advis, execCfg, "ws", "prog", "std");
      expect(buildCmd).toHaveBeenCalledWith("claude", "rp", "fable", "ws", false, "exec");
      // the prompt has to match the grant, or the reviewer burns its round on
      // tools it was never given
      expect(vi.mocked(reviewPrompt).mock.calls[0][5]).toBe(true);
      // advisor_timeout (300s) would have killed a suite mid-run
      vi.advanceTimersByTime(300_000);
      expect(killTreeMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(600_000);
      expect(killTreeMock).toHaveBeenCalledWith(mockChild);
      finishSpawn(1);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  // The grant comes from the cli, not from us: telling a cli with no execution
  // flags that it may run things produces a reviewer that only fails at it.
  it("stays read-only when the cli has no execution grant, config or not", async () => {
    diffMock.mockReturnValue("some diff");
    const execCfg = { ...cfg, review_runs_commands: true } as unknown as Config;
    const p = advisorReview(task, prd, { cli: "opencode", model: "m" }, execCfg, "ws", "prog", "std");
    mockChild.stdout.end("APPROVE\n");
    finishSpawn(0);
    await p;
    expect(buildCmd).toHaveBeenCalledWith("opencode", "rp", "m", "ws", false, "read");
    expect(vi.mocked(reviewPrompt).mock.calls[0][5]).toBe(false);
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
