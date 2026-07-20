// verify.test.ts — runVerify gate + assembleFeedback
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Mock } from "vitest";

vi.mock("./log.js", () => ({ log: vi.fn() }));
// killTree stays mocked (asserting the CALL is the point); spawn is scripted
vi.mock("./spawn.js", () => ({ spawn: vi.fn(), killTree: vi.fn() }));

import { killTree, spawn } from "./spawn.js";
import { log } from "./log.js";
import { runVerify, assembleFeedback } from "./verify.js";
import type { Task } from "./prd.js";

const spawnMock = spawn as unknown as Mock;
const killTreeMock = killTree as unknown as Mock;
const mockLog = vi.mocked(log);

function makeProc() {
  const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  return proc;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "T1",
    title: "t",
    status: "todo",
    deps: [],
    retries: 0,
    description: "",
    acceptance: [],
    verify: "npm test",
    ...over,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => vi.clearAllMocks());

describe("runVerify", () => {
  it("passes with no verify command, without spawning anything", async () => {
    expect(await runVerify(task({ verify: undefined }), "/w", "prog")).toEqual({ passed: true, output: "" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("runs the command through a shell in the workspace", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runVerify(task(), "/w", "prog");
    expect(spawnMock).toHaveBeenCalledWith("npm test", [], expect.objectContaining({ cwd: "/w", shell: true }));
    proc.emit("close", 0);
    expect(await p).toEqual({ passed: true, output: "" });
  });

  it("merges stdout and stderr into the feedback output", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runVerify(task(), "/w", "prog");
    proc.stdout.write("out line\n");
    proc.stderr.write("err line\n");
    await tick();
    proc.emit("close", 0);
    const r = await p;
    expect(r.output).toContain("out line");
    expect(r.output).toContain("err line");
  });

  it("fails on a non-zero exit and logs the tail", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runVerify(task(), "/w", "prog");
    proc.stdout.write("boom\n");
    await tick();
    proc.emit("close", 2);
    expect(await p).toMatchObject({ passed: false });
    expect(mockLog).toHaveBeenCalledWith("prog", expect.stringContaining("boom"));
  });

  it("keeps only the tail of the output, so a runaway command cannot eat the heap", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runVerify(task(), "/w", "prog");
    for (let i = 0; i < 60; i++) proc.stdout.write("x".repeat(10_000));
    proc.stdout.write("THE END");
    await tick();
    proc.emit("close", 0);
    const r = await p;
    expect(r.output.length).toBeLessThanOrEqual(4000);
    expect(r.output).toContain("THE END");
  });

  // spawnSync's `timeout` signalled the shell only: a hung `npm test` left its
  // children running, and on POSIX those children also hold the pipes open
  it("kills the whole tree on timeout, not just the shell", async () => {
    vi.useFakeTimers();
    try {
      const proc = makeProc();
      spawnMock.mockReturnValue(proc);
      const p = runVerify(task(), "/w", "prog");
      await vi.advanceTimersByTimeAsync(600_000);
      expect(killTreeMock).toHaveBeenCalledWith(proc);
      proc.emit("close", null);
      expect(await p).toEqual({ passed: false, output: "" });
      expect(mockLog).toHaveBeenCalledWith("prog", expect.stringContaining("TIMEOUT"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles after the kill grace even if 'close' never arrives", async () => {
    vi.useFakeTimers();
    try {
      const proc = makeProc();
      spawnMock.mockReturnValue(proc);
      const p = runVerify(task(), "/w", "prog");
      await vi.advanceTimersByTimeAsync(600_000); // timeout -> kill
      await vi.advanceTimersByTimeAsync(5_000); // grace, no close
      expect(await p).toMatchObject({ passed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timed-out command that exits 0 during the grace still fails", async () => {
    vi.useFakeTimers();
    try {
      const proc = makeProc();
      spawnMock.mockReturnValue(proc);
      const p = runVerify(task(), "/w", "prog");
      await vi.advanceTimersByTimeAsync(600_000);
      proc.emit("close", 0); // raced in after the kill
      expect(await p).toMatchObject({ passed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails and logs when the command cannot be spawned", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runVerify(task(), "/w", "prog");
    proc.emit("error", new Error("ENOENT"));
    expect(await p).toMatchObject({ passed: false });
    expect(mockLog).toHaveBeenCalledWith("prog", expect.stringContaining("ENOENT"));
  });

  it("fails when spawn throws synchronously", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("nope");
    });
    expect(await runVerify(task(), "/w", "prog")).toMatchObject({ passed: false });
    expect(mockLog).toHaveBeenCalledWith("prog", expect.stringContaining("nope"));
  });

  it("survives a spawn that throws a non-Error", async () => {
    spawnMock.mockImplementation(() => {
      throw "just a string"; // eslint-disable-line no-throw-literal
    });
    expect(await runVerify(task(), "/w", "prog")).toMatchObject({ passed: false });
    expect(mockLog).toHaveBeenCalledWith("prog", expect.stringContaining("just a string"));
  });

  it("ignores a second close after the first already settled", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runVerify(task(), "/w", "prog");
    proc.emit("close", 0);
    proc.emit("close", 1); // must not flip the verdict
    expect(await p).toMatchObject({ passed: true });
  });

  it("ignores a late error after the command already closed", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runVerify(task(), "/w", "prog");
    proc.emit("close", 0);
    expect(await p).toMatchObject({ passed: true });
    proc.emit("error", new Error("late"));
    expect(await p).toMatchObject({ passed: true });
    // and says nothing: logging "crashed" would contradict the verdict already
    // shipped to the loop, which reads the log to explain what happened
    expect(mockLog).not.toHaveBeenCalledWith("prog", expect.stringContaining("late"));
  });
});

describe("assembleFeedback", () => {
  it("is empty when everything passed", () => {
    expect(assembleFeedback(true, true, "", true, "")).toBe("");
  });
  it("reports a non-zero executor exit", () => {
    expect(assembleFeedback(false, true, "", true, "")).toContain("exited non-zero");
  });
  it("includes failing test output", () => {
    expect(assembleFeedback(true, false, "TEST FAIL", true, "")).toContain("TEST FAIL");
  });
  it("includes reviewer changes only when there are any", () => {
    expect(assembleFeedback(true, true, "", false, "do x")).toContain("do x");
    expect(assembleFeedback(true, true, "", false, "")).toBe("");
  });
  it("joins every part that applies", () => {
    const out = assembleFeedback(false, false, "TEST FAIL", false, "do x");
    expect(out).toContain("exited non-zero");
    expect(out).toContain("TEST FAIL");
    expect(out).toContain("do x");
  });
});
