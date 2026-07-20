// executor.test.ts — unit tests for runExecutor (scripted fake child process)
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("./adapters.js", () => ({ buildCmd: vi.fn(() => ["mybin", "a1"]) }));
vi.mock("./log.js", () => ({ log: vi.fn() }));
vi.mock("./tui/events.js", () => ({ emit: vi.fn() }));
// releasePipes keeps its REAL implementation (it operates on the fake child's
// actual streams) but is wrapped in a spy: "did we release?" cannot be probed
// via stream.destroyed, because ending a PassThrough destroys it on its own.
vi.mock("./spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spawn.js")>();
  return { ...actual, spawn: vi.fn(), killTree: vi.fn(), releasePipes: vi.fn(actual.releasePipes) };
});

import { killTree, releasePipes, spawn } from "./spawn.js";
import { log } from "./log.js";
import { emit } from "./tui/events.js";
import { runExecutor } from "./executor.js";
import type { AgentSpec, Config } from "./config.js";
import type { Task } from "./prd.js";

const spawnMock = spawn as unknown as Mock;
const killTreeMock = killTree as unknown as Mock;
const releasePipesMock = releasePipes as unknown as Mock;
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

// node emits 'close' only AFTER the stdio streams have closed, so a fake child
// that emits it with its pipes still open is not modelling a real exit — and
// runExecutor waits for the output to drain before classifying the run.
function closeProc(proc: ReturnType<typeof makeProc>, code: number | null = 0): void {
  if (!proc.stdout.writableEnded) proc.stdout.end();
  if (!proc.stderr.writableEnded) proc.stderr.end();
  proc.emit("close", code);
}

function cfg(over: Partial<Config> = {}): Config {
  return {
    task_timeout: 1800,
    heartbeat_secs: 30,
    extra_executor_args: [],
    // these cases cover the PLAIN (buffered) path; the streaming path has its
    // own describe below, because it changes both the argv and the line handling
    stream_output: false,
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
  closeProc(proc, 0);
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
    closeProc(proc, 0);
    expect(await p).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("resolves false on nonzero exit and forwards extra args", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runExecutor(execu, "prompt", cfg({ extra_executor_args: ["--z"] }), "ws", "prog", task, ["--x"]);
  closeProc(proc, 3);
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

// a settled run must not arm a drain timer for a promise nobody is waiting on
it("does not schedule any further work when 'close' lands after a spawn error", async () => {
  vi.useFakeTimers();
  try {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task);
    proc.emit("error", new Error("boom"));
    expect(await p).toBe(false);
    closeProc(proc, 0); // the late close node still delivers
    expect(vi.getTimerCount()).toBe(0);
    expect(await p).toBe(false); // and the verdict is unchanged
  } finally {
    vi.useRealTimers();
  }
});

it("kills the process on timeout and resolves false", async () => {
  vi.useFakeTimers();
  try {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ task_timeout: 1 }), "ws", "prog", task);
    vi.advanceTimersByTime(1000); // interval fires, elapsed >= timeout -> kill
    expect(killTreeMock).toHaveBeenCalledWith(proc);
    closeProc(proc, null);
    expect(await p).toBe(false);
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("TIMEOUT"));
  } finally {
    vi.useRealTimers();
  }
});

it("settles after the kill grace even if 'close' never fires (orphan holding the pipes)", async () => {
  vi.useFakeTimers();
  try {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ task_timeout: 1 }), "ws", "prog", task);
    vi.advanceTimersByTime(1000); // timeout -> kill
    vi.advanceTimersByTime(5000); // grace elapses, no 'close' ever arrives
    expect(await p).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

// releasePipes destroys the child's stdio, so it must NOT run when the child
// closed on its own — a final line readline had not emitted yet would be lost.
it("a clean exit keeps the streams intact (no output dropped on the happy path)", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task);
  // a newline-less tail is only flushed by readline when the stream ENDS, which
  // can land after 'close' — so the streams must still be alive once we settle
  proc.stdout.end("no trailing newline");
  closeProc(proc, 0);
  expect(await p).toBe(true);
  expect(releasePipesMock).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("no trailing newline"), false);
});

it("a killed child gets its pipes released so a survivor cannot keep writing", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const ac = new AbortController();
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task, [], ac.signal);
  ac.abort();
  expect(await p).toBe(false);
  expect(releasePipesMock).toHaveBeenCalled();
  expect(proc.stdout.destroyed).toBe(true); // the real implementation ran
  expect(proc.stderr.destroyed).toBe(true);
});

// exit 0 alone would read as success and let the verify gate mark the task done
it("fails the attempt when the executor reports BLOCKED, even on exit 0", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task);
  proc.stdout.write("RALPHRUN_BLOCKED: needs a prod credential I must not touch\n");
  await tick();
  closeProc(proc, 0);
  expect(await p).toBe(false);
  expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("needs a prod credential"));
});

it("only honours the marker at the start of a line, so quoting the rules is not a false hit", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task);
  proc.stdout.write("the rules say to print RALPHRUN_BLOCKED: <reason> when stuck\n");
  proc.stdout.end("all done\n");
  closeProc(proc, 0);
  expect(await p).toBe(true);
});

// the marker text lives in the prompt, so an agent recapping the rules can
// legitimately start a line with it — only its LAST word decides the verdict
it("ignores a marker the agent echoed at line start before carrying on working", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task);
  proc.stdout.write("RALPHRUN_BLOCKED: <one line saying what is blocked and why>\n");
  proc.stdout.write("(that was me restating the rule; proceeding)\n");
  proc.stdout.end("implemented and tests pass\n");
  closeProc(proc, 0);
  expect(await p).toBe(true);
});

// readline hands over a newline-less tail only when the stream ENDS, which can
// land after 'close' — classifying at 'close' would miss the block entirely
it("catches a blocked marker printed as a final line with no trailing newline", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task);
  proc.stdout.write("tried the migration path\n");
  proc.stdout.end("RALPHRUN_BLOCKED: the reset would drop a shared database"); // no \n
  closeProc(proc, 0);
  expect(await p).toBe(false);
  expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("would drop a shared database"));
});

it("still settles when the output stream never ends (survivor holding the pipe)", async () => {
  vi.useFakeTimers();
  try {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task);
    proc.emit("close", 0); // stdout deliberately left open
    await vi.advanceTimersByTimeAsync(2000); // drain grace elapses
    expect(await p).toBe(true);
    // the stream draining later must not re-settle the promise
    proc.stdout.end("late tail");
    proc.stderr.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("reads the marker from stderr too (both streams are merged)", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task);
  proc.stdout.end("");
  proc.stderr.end("RALPHRUN_BLOCKED: missing a credential I must not fabricate\n");
  closeProc(proc, 0);
  expect(await p).toBe(false);
});

it("already-aborted signal kills immediately and resolves false", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const ac = new AbortController();
  ac.abort();
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task, [], ac.signal);
  expect(killTreeMock).toHaveBeenCalledWith(proc);
  expect(await p).toBe(false);
});

it("abort mid-run kills, resolves false, and a later close is a no-op", async () => {
  const proc = makeProc();
  spawnMock.mockReturnValue(proc);
  const ac = new AbortController();
  const p = runExecutor(execu, "prompt", cfg(), "ws", "prog", task, [], ac.signal);
  ac.abort(); // onAbort -> kill + finish(false)
  expect(killTreeMock).toHaveBeenCalledWith(proc);
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
    closeProc(proc, 0);
    expect(await p).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

describe("streaming mode", () => {
  const ev = (o: unknown): string => JSON.stringify(o) + "\n";
  const text = (s: string): string => ev({ type: "assistant", message: { content: [{ type: "text", text: s }] } });
  const noise = ev({ type: "system", subtype: "thinking_tokens", estimated_tokens: 114 });

  it("turns the cli's event stream on and renders events instead of raw json", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    expect(spawnMock.mock.calls[0][1]).toEqual(["a1", "--output-format", "stream-json", "--verbose"]);

    proc.stdout.write(noise); // liveness only — must not reach the pane
    proc.stdout.write(ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }));
    proc.stdout.write(text("all green"));
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(true);

    const lines = emitMock.mock.calls.map((c) => c[0].line).filter((l) => l !== undefined);
    expect(lines).toContain("→ Bash(npm test)");
    expect(lines).toContain("all green");
    expect(lines.some((l: string) => l.includes("thinking_tokens"))).toBe(false);
  });

  it("reads the blocked marker out of the model's prose", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write(text("RALPHRUN_BLOCKED: the reset would drop a shared database"));
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(false);
  });

  // "last non-empty line of the run" means the LAST one, whatever kind it was:
  // tracking only prose would leave a marker line standing after the agent
  // shrugged it off and carried on working
  it("does not fail a run whose marker prose was followed by more work", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write(text("RALPHRUN_BLOCKED: I thought I was stuck"));
    proc.stdout.write(
      ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
    );
    proc.stdout.write(ev({ type: "result", subtype: "success", result: "actually it worked" }));
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(true);
  });

  // the agent said something marker-shaped, then kept working INVISIBLY (a
  // thinking-only turn, a tool result). Its last word is no longer the marker.
  it("does not fail a run whose marker prose was followed by invisible work", async () => {
    for (const later of [
      ev({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm, actually…" }] } }),
      ev({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    ]) {
      emitMock.mockClear();
      const proc = makeProc();
      spawnMock.mockReturnValue(proc);
      const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
      proc.stdout.write(text("RALPHRUN_BLOCKED: temporary concern"));
      proc.stdout.write(later);
      await tick();
      closeProc(proc, 0);
      expect(await p).toBe(true);
    }
  });

  // the exact repro from review, with the CAPTURED tool_progress shape: a long
  // command heartbeating between the marker prose and the final result
  it("does not fail a run whose marker prose was followed by a still-running tool", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write(text("RALPHRUN_BLOCKED: temporary concern"));
    proc.stdout.write(ev({ type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: 30, heartbeat: true }));
    proc.stdout.write(ev({ type: "system", subtype: "task_notification", task_id: "b80", status: "completed" }));
    proc.stdout.write(ev({ type: "result", subtype: "success", result: "finished after all" }));
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(true);
    // and the long command was visible while it ran, not a blind timer
    expect(emitMock.mock.calls.map((c) => c[0].line)).toContain("⋯ Bash still running 30s");
  });

  // ...but harness noise is NOT the agent working, and can legitimately trail
  // the final answer — treating it as work would silence a real block
  it("still fails when only infrastructure noise follows the marker", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write(text("RALPHRUN_BLOCKED: no safe path"));
    proc.stdout.write(ev({ type: "system", subtype: "thinking_tokens", estimated_tokens: 9 }));
    proc.stdout.write(ev({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }));
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(false);
  });

  // documented precedence: the cli's own final answer wins over earlier prose
  it("lets the final result event override earlier prose, in both directions", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write(text("RALPHRUN_BLOCKED: spoke too soon"));
    proc.stdout.write(ev({ type: "result", subtype: "success", result: "actually finished" }));
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(true);

    const proc2 = makeProc();
    spawnMock.mockReturnValue(proc2);
    const p2 = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc2.stdout.write(text("carrying on"));
    proc2.stdout.write(ev({ type: "result", subtype: "success", result: "RALPHRUN_BLOCKED: gave up" }));
    await tick();
    closeProc(proc2, 0);
    expect(await p2).toBe(false);
  });

  it("keeps the run alive on an oversized line instead of parsing megabytes", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write("x".repeat(300_000) + "\n");
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(true);
    const shown = emitMock.mock.calls.map((c) => c[0].line).filter((l) => typeof l === "string");
    expect(shown.length).toBe(1);
    expect(shown[0].length).toBeLessThan(600); // truncated, not echoed whole
  });

  // if the cli ever reports its last word ONLY in the result event, a genuine
  // block would otherwise sail through as a success
  it("hears a blocked marker that arrives only in the final result event", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write(ev({ type: "result", subtype: "success", result: "RALPHRUN_BLOCKED: no safe path" }));
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(false);
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("no safe path"));
  });

  it("shows a failed result, which is the only place its reason lives", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write(ev({ type: "result", subtype: "error_max_turns", is_error: true, result: "hit the turn limit" }));
    await tick();
    closeProc(proc, 1);
    expect(await p).toBe(false);
    const lines = emitMock.mock.calls.map((c) => c[0].line);
    expect(lines).toContain("hit the turn limit");
  });

  it("skips blank stream lines without touching the pane", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write("\n   \n");
    proc.stdout.write(text("only line"));
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(true);
    expect(emitMock.mock.calls.filter((c) => c[0].line !== undefined).map((c) => c[0].line)).toEqual(["only line"]);
  });

  // stream_output defaults to true, so a cli with no parser must be untouched
  it("leaves a cli without a stream parser on the plain path", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor({ cli: "opencode", model: "m" }, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    expect(spawnMock.mock.calls[0][1]).toEqual(["a1"]); // no stream flags added
    proc.stdout.write("plain text line\n");
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(true);
    expect(emitMock.mock.calls.map((c) => c[0].line)).toContain("plain text line");
  });

  it("puts the user's extra args AFTER the stream flags so they can still win", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true, extra_executor_args: ["--output-format", "text"] }), "ws", "prog", task);
    expect(spawnMock.mock.calls[0][1]).toEqual([
      "a1", "--output-format", "stream-json", "--verbose", "--output-format", "text",
    ]);
    closeProc(proc, 0);
    await p;
  });

  // a tool call is not the agent speaking — grepping for the marker in one would
  // let a task fail itself just by reading the prompt file back
  it("does NOT read the marker out of a tool call's arguments", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = runExecutor(execu, "prompt", cfg({ stream_output: true }), "ws", "prog", task);
    proc.stdout.write(
      ev({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "RALPHRUN_BLOCKED: grep me" } }] },
      }),
    );
    await tick();
    closeProc(proc, 0);
    expect(await p).toBe(true);
  });



});
