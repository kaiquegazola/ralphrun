// executor.test.ts — unit tests for runExecutor (scripted fake child process)
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("./adapters.js", () => ({ buildCmd: vi.fn(() => ["mybin", "a1"]) }));
vi.mock("./log.js", () => ({ log: vi.fn() }));
vi.mock("./tui/events.js", () => ({ emit: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { log } from "./log.js";
import { emit } from "./tui/events.js";
import { runExecutor } from "./executor.js";
import type { AgentSpec, Config } from "./config.js";
import type { Task } from "./prd.js";

const spawnMock = spawn as unknown as Mock;
const emitMock = emit as unknown as Mock;

function makeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: Mock;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

const execu: AgentSpec = { cli: "claude", model: "sonnet" };
const task = { id: "T1" } as unknown as Task;
const tick = () => new Promise((r) => setImmediate(r));

function cfg(over: Partial<Config> = {}): Config {
  return {
    task_timeout: 1800,
    heartbeat_secs: 30,
    extra_executor_args: [],
    ...over,
  } as unknown as Config;
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("resolves true on exit 0 and echoes non-blank lines (heartbeat_secs undefined)", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  // heartbeat_secs omitted -> exercises the `?? 30` fallback
  const p = runExecutor(execu, "prompt", cfg({ heartbeat_secs: undefined }), "ws", "prog", task);
  proc.stdout.write("hello world\n");
  proc.stdout.write("   \n"); // blank after trim -> not logged (but STILL emitted to bus)
  await tick();
  proc.emit("close", 0);
  expect(await p).toBe(true);
  expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("hello world"), false);
  expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("exit=0"));
  // structured event: every output line goes to the bus (blank included, unlike log)
  expect(emitMock).toHaveBeenCalledWith({ taskId: "T1", line: "hello world", lineSource: "executor" });
  expect(emitMock).toHaveBeenCalledWith({ taskId: "T1", line: "   ", lineSource: "executor" });
});

it("emits a structured elapsed/timeout heartbeat event each interval tick", async () => {
  vi.useFakeTimers();
  try {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ heartbeat_secs: 2, task_timeout: 9999 }), "ws", "prog", task);
    vi.advanceTimersByTime(1000); // one interval tick, well below timeout
    expect(emitMock).toHaveBeenCalledWith({ taskId: "T1", elapsedMs: 1000, timeoutMs: 9999 * 1000 });
    proc.emit("close", 0);
    expect(await p).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("resolves false on nonzero exit and forwards extra args", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runExecutor(execu, "prompt", cfg({ extra_executor_args: ["--z"] }), "ws", "prog", task, ["--x"]);
  proc.emit("close", 3);
  expect(await p).toBe(false);
  // buildCmd -> ["mybin","a1"]; extra + extra_executor_args appended, then spawn gets bin + rest
  expect(spawnMock).toHaveBeenCalledWith("mybin", ["a1", "--x", "--z"], expect.objectContaining({ cwd: "ws" }));
});

it("resolves false when spawn errors", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task);
  proc.emit("error", new Error("boom"));
  expect(await p).toBe(false);
  expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("failed to spawn"));
});

it("kills the process on timeout and resolves false", async () => {
  vi.useFakeTimers();
  try {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ task_timeout: 1 }), "ws", "prog", task);
    vi.advanceTimersByTime(1000); // interval fires, elapsed >= timeout -> kill
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null);
    expect(await p).toBe(false);
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("TIMEOUT"));
  } finally {
    vi.useRealTimers();
  }
});

it("already-aborted signal kills immediately and resolves false", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const ac = new AbortController();
  ac.abort();
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task, [], ac.signal);
  expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  expect(await p).toBe(false);
});

it("abort mid-run kills, resolves false, and a later close is a no-op", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const ac = new AbortController();
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task, [], ac.signal);
  ac.abort(); // onAbort -> kill + finish(false)
  expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("skipped by user"));
  proc.emit("close", 0); // settled guard: no-op, stays false
  expect(await p).toBe(false);
});

it("emits a heartbeat once the idle window elapses", async () => {
  vi.useFakeTimers();
  try {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    // hb=2s, big timeout: interval fires at 1s (idle<hb, silent) then 2s (idle>=hb, heartbeat)
    const p = runExecutor(execu, "prompt", cfg({ heartbeat_secs: 2, task_timeout: 9999 }), "ws", "prog", task);
    vi.advanceTimersByTime(2000);
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("working"));
    proc.emit("close", 0);
    expect(await p).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
