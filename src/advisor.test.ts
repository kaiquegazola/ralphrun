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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
// the opencode grant creates a temp dir per call — mocked so a test can force
// the creation failure without unmounting the real file reads around it
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: vi.fn((...args: Parameters<typeof actual.mkdtempSync>) => actual.mkdtempSync(...args)),
  };
});

import { buildCmd, promptViaStdin } from "./adapters.js";
import { killTree, spawn } from "./spawn.js";
import { log } from "./log.js";
import { captureDiff } from "./git.js";
import { parseReview, reviewPrompt } from "./prompts.js";
import { runCursorSdkText } from "./cursor-sdk.js";
import { getAdvice, advisorReview, NETWORK_RETRY_DELAYS_MS } from "./advisor.js";
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
    expect(runCursorSdkText).toHaveBeenCalledWith(sdk, "ap", cfg, "ws", "T1", "advisor", undefined, undefined);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // Same control, same wiring, both backends — the handoff already shipped once
  // wired on a single backend, and a skip that only interrupts the spawn advisor
  // is that bug again.
  it("hands the abort signal to the sdk advisor too", async () => {
    const sdk: AgentSpec = { cli: "cursorsdk", model: "composer-2" };
    const ac = new AbortController();
    await getAdvice(task, prd, sdk, cfg, "ws", "prog", "std", ac.signal);
    expect(runCursorSdkText).toHaveBeenCalledWith(sdk, "ap", cfg, "ws", "T1", "advisor", undefined, ac.signal);
  });

  // The advisor and review calls own the longest budgets in the product
  // (advisor_timeout, and review_timeout with an executing reviewer). A skip
  // that only kills the executor leaves the user waiting them out.
  it("kills the advisor child and answers null when the run is aborted", async () => {
    const ac = new AbortController();
    const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std", ac.signal);
    ac.abort();
    expect(killTreeMock).toHaveBeenCalled();
    expect(await p).toBeNull();
  });

  it("never spawns an advisor once the run is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await getAdvice(task, prd, advis, cfg, "ws", "prog", "std", ac.signal)).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // one signal serves every call of a task, so a listener left behind piles up
  // one per fix round
  it("drops its abort listener once the advisor settles", async () => {
    const ac = new AbortController();
    const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std", ac.signal);
    mockChild.stdout.end("advice\n");
    finishSpawn(0);
    expect(await p).toBe("advice");
    ac.abort();
    expect(killTreeMock).not.toHaveBeenCalled();
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
    expect(reviewPrompt).toHaveBeenCalledWith(task, prd, "std", "some diff", verification, false, undefined);
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

  // review_timeout is optional on Config — a config object assembled anywhere
  // but load_config (which fills it from DEFAULTS) simply has no value for it.
  // `undefined` seconds is a timer that never fires, so the executing reviewer
  // would hang until the process died instead of until its budget ran out.
  it("falls back to advisor_timeout when no review_timeout was resolved", async () => {
    vi.useFakeTimers();
    try {
      diffMock.mockReturnValue("some diff");
      const execCfg = { ...cfg, review_runs_commands: true, review_timeout: undefined } as unknown as Config;
      const p = advisorReview(task, prd, advis, execCfg, "ws", "prog", "std");
      vi.advanceTimersByTime(300_000);
      expect(killTreeMock).toHaveBeenCalledWith(mockChild);
      finishSpawn(1);
      await p;
      expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("300"));
    } finally {
      vi.useRealTimers();
    }
  });

  // The grant comes from the cli, not from us: telling a cli with no execution
  // grant (no argv flags, no config env — grok) that it may run things produces
  // a reviewer that only fails at it.
  it("stays read-only when the cli has no execution grant, config or not", async () => {
    diffMock.mockReturnValue("some diff");
    const execCfg = { ...cfg, review_runs_commands: true } as unknown as Config;
    const p = advisorReview(task, prd, { cli: "grok", model: "m" }, execCfg, "ws", "prog", "std");
    mockChild.stdout.end("APPROVE\n");
    finishSpawn(0);
    await p;
    expect(buildCmd).toHaveBeenCalledWith("grok", "rp", "m", "ws", false, "read");
    expect(vi.mocked(reviewPrompt).mock.calls[0][5]).toBe(false);
  });

  // opencode's grant is config-borne (reviewEnv), so with review_runs_commands
  // on it joins claude as an executing reviewer — and earns review_timeout, the
  // budget of a test run. The 300s kill that shipped this test is exactly what
  // a suite-running reviewer used to die of.
  it("hands opencode an exec config and review_timeout when review_runs_commands is on", async () => {
    vi.useFakeTimers();
    try {
      diffMock.mockReturnValue("some diff");
      const execCfg = { ...cfg, review_runs_commands: true, review_timeout: 900 } as unknown as Config;
      const p = advisorReview(task, prd, { cli: "opencode", model: "m" }, execCfg, "ws", "prog", "std");
      expect(buildCmd).toHaveBeenCalledWith("opencode", "rp", "m", "ws", false, "exec");
      expect(vi.mocked(reviewPrompt).mock.calls[0][5]).toBe(true);
      const env = spawnMock.mock.calls[0][2].env as Record<string, string>;
      const granted = JSON.parse(readFileSync(env.OPENCODE_CONFIG, "utf8"));
      expect(granted.permission.bash).toBeTypeOf("object"); // allow/deny shapes, not a flat deny
      // merged over process.env, never replacing it — auth and PATH survive
      expect(env.PATH).toBe(process.env.PATH);
      // advisor_timeout (300s) would have killed a suite mid-run
      vi.advanceTimersByTime(300_000);
      expect(killTreeMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(600_000);
      expect(killTreeMock).toHaveBeenCalledWith(mockChild);
      finishSpawn(1);
      await p;
      // cleanup runs on the settle path: the temp config does not outlive the call
      expect(existsSync(env.OPENCODE_CONFIG)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // and with the config off, the grant rides INLINE as the read posture: bash
  // flat out denied, only the file tools allowed — never a permission ask that
  // nobody headless could answer.
  it("hands opencode a read-only config when review_runs_commands is off", async () => {
    diffMock.mockReturnValue("some diff");
    const p = advisorReview(task, prd, { cli: "opencode", model: "m" }, cfg, "ws", "prog", "std");
    const env = spawnMock.mock.calls[0][2].env as Record<string, string>;
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    mockChild.stdout.end("APPROVE\n");
    finishSpawn(0);
    await p;
    expect(buildCmd).toHaveBeenCalledWith("opencode", "rp", "m", "ws", false, "read");
    expect(config.permission.bash).toBe("deny");
  });

  // a skip before the spawn must still remove the temp config it wrote
  it("cleans the opencode grant up when the review is aborted before spawning", async () => {
    diffMock.mockReturnValue("some diff");
    const ac = new AbortController();
    ac.abort();
    const p = advisorReview(task, prd, { cli: "opencode", model: "m" }, cfg, "ws", "prog", "std", undefined, undefined, ac.signal);
    expect(await p).toEqual({ approved: false, changes: "", diff: "some diff" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // ...and so must a spawn that throws synchronously
  it("cleans the opencode grant up when the spawn throws", async () => {
    diffMock.mockReturnValue("some diff");
    spawnMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(await advisorReview(task, prd, { cli: "opencode", model: "m" }, cfg, "ws", "prog", "std")).toEqual({
      approved: false,
      changes: "",
      diff: "some diff",
    });
  });

  // A grant that cannot even be created must fail the review — never hand the
  // reviewer the cli's unscoped defaults and let it run anyway. (Only an EXEC
  // grant writes a file, so only it can fail this way.)
  it("fails the review safely when the grant config cannot be created", async () => {
    diffMock.mockReturnValue("some diff");
    vi.mocked(mkdtempSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    const execCfg = { ...cfg, review_runs_commands: true } as unknown as Config;
    expect(await advisorReview(task, prd, { cli: "opencode", model: "m" }, execCfg, "ws", "prog", "std")).toEqual({
      approved: false,
      changes: "",
      diff: "some diff",
    });
    expect(spawnMock).not.toHaveBeenCalled();
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

// A provider blip (finish_reason: network_error and friends) used to settle the
// call as a silent null — which advisorReview reads as NOT approved, burning a
// review round on infrastructure no executor fix could address. These pin the
// retry ladder: marker-matched only, abort-aware, finite.
describe("network-blip retry", () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const resetStreams = (): void => {
    mockChild.stdout = new PassThrough();
    mockChild.stderr = new PassThrough();
    mockChild.on.mockReset();
  };

  it("retries once on a provider network error and returns the second answer", async () => {
    vi.useFakeTimers();
    try {
      const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
      mockChild.stderr.end("Error: Provider finish_reason: network_error\n");
      finishSpawn(0); // attempt 1 settles null with blip evidence
      await flush(); // let the wrapper reach its backoff wait
      expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("retrying in 5s"));
      vi.advanceTimersByTime(5_000);
      resetStreams();
      await flush(); // attempt 2 spawns
      expect(spawnMock).toHaveBeenCalledTimes(2);
      mockChild.stdout.end("advice two\n");
      finishSpawn(0);
      expect(await p).toBe("advice two");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an empty answer that carries no network marker", async () => {
    const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
    mockChild.stdout.end("   \n");
    finishSpawn(0);
    expect(await p).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("a skip during the backoff stops the retry ladder", async () => {
    const ac = new AbortController();
    vi.useFakeTimers();
    try {
      const p = getAdvice(task, prd, advis, cfg, "ws", "prog", "std", ac.signal);
      mockChild.stderr.end("fetch failed\n");
      finishSpawn(0);
      await flush();
      ac.abort();
      expect(await p).toBeNull();
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the ladder — every retry dead, then the old NOT-approved path", async () => {
    vi.useFakeTimers();
    try {
      diffMock.mockReturnValue("some diff");
      const p = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
      for (let i = 0; i < NETWORK_RETRY_DELAYS_MS.length + 1; i++) {
        mockChild.stderr.end("Error: Provider finish_reason: network_error\n");
        finishSpawn(0);
        await flush();
        if (i < NETWORK_RETRY_DELAYS_MS.length) {
          vi.advanceTimersByTime(NETWORK_RETRY_DELAYS_MS[i]);
          resetStreams();
          await flush();
        }
      }
      expect(await p).toEqual({ approved: false, changes: "", diff: "some diff" });
      expect(spawnMock).toHaveBeenCalledTimes(NETWORK_RETRY_DELAYS_MS.length + 1);
      expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("review failed to answer"));
    } finally {
      vi.useRealTimers();
    }
  });
});
