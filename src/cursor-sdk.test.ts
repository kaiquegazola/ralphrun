// cursor-sdk.test.ts — unit tests for the in-process Cursor backend (injected fake Agent.create)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock, MockInstance } from "vitest";

const logHarness = vi.hoisted(() => ({ log: vi.fn(), rawFinish: vi.fn() }));
vi.mock("./log.js", () => ({
  log: logHarness.log,
  createRawLog: vi.fn((progress: string, tag: string) => ({
    write: (line: string) => {
      if (line.trim()) logHarness.log(progress, "  " + tag + "› " + line, false);
    },
    finish: logHarness.rawFinish,
  })),
}));
vi.mock("./tui/events.js", () => ({ emit: vi.fn() }));

import { createRawLog, log } from "./log.js";
import { emit } from "./tui/events.js";
import {
  cursorSdkEvent,
  cursorSdkInstalled,
  parseCursorModelSpec,
  resetCursorSdkCacheForTest,
  runCursorSdk,
  runCursorSdkExecutor,
  runCursorSdkText,
  type CursorAgent,
  type CursorAgentOptions,
  type CursorMessage,
  type CursorRun,
  type CursorRunResult,
} from "./cursor-sdk.js";
import type { AgentSpec, Config } from "./config.js";
import type { Task } from "./prd.js";
import { MAX_RESPONSE_CHARS } from "./stream.js";

const logMock = log as unknown as Mock;
const emitMock = emit as unknown as Mock;
const rawLogMock = vi.mocked(createRawLog);

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const never = <T>(): Promise<T> => new Promise<T>(() => {});

const FINISHED: CursorRunResult = { status: "finished", result: "" };

function makeRun(
  msgs: CursorMessage[],
  result: CursorRunResult = FINISHED,
  opts: {
    supports?: (op: string) => boolean;
    wait?: () => Promise<CursorRunResult>;
    cancel?: () => Promise<void>;
    stream?: () => AsyncIterable<CursorMessage>;
  } = {},
) {
  return {
    supports: vi.fn(opts.supports ?? (() => true)),
    stream:
      opts.stream ??
      async function* () {
        for (const m of msgs) yield m;
      },
    wait: vi.fn(opts.wait ?? (async () => result)),
    cancel: vi.fn(opts.cancel ?? (async () => {})),
  };
}

function makeAgent(run: ReturnType<typeof makeRun>) {
  return { send: vi.fn(async () => run as unknown as CursorRun), close: vi.fn() };
}

function makeCreate(agent: { send: Mock; close: Mock }) {
  return vi.fn(async (_o: CursorAgentOptions) => agent as unknown as CursorAgent);
}

function makeCfg(over: Partial<Config> = {}): Config {
  return {
    task_timeout: 1800,
    advisor_timeout: 300,
    heartbeat_secs: 30,
    extra_executor_args: [],
    ...over,
  } as unknown as Config;
}

const EXECU: AgentSpec = { cli: "cursorsdk", model: "composer-2" };
const TASK = { id: "T1" } as unknown as Task;

const ORIGINAL_KEY = process.env.CURSOR_API_KEY;
let warn: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  resetCursorSdkCacheForTest();
  process.env.CURSOR_API_KEY = "k";
  // the cost warning is real process output; silenced so a passing run is quiet
  warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  if (ORIGINAL_KEY === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = ORIGINAL_KEY;
});

/** every line the executor pushed into the live pane, in order */
function lines(): string[] {
  return emitMock.mock.calls.map((c) => c[0]).filter((e) => e.line !== undefined).map((e) => e.line);
}

/** every message logged to progress.md */
function logged(): string[] {
  return logMock.mock.calls.map((c) => String(c[1]));
}

describe("parseCursorModelSpec", () => {
  it.each([
    ["composer-2", { id: "composer-2" }],
    ["  grok-4.5  ", { id: "grok-4.5" }],
    [
      "grok-4.5[fast=false,effort=high]",
      { id: "grok-4.5", params: [{ id: "fast", value: "false" }, { id: "effort", value: "high" }] },
    ],
    ["grok-4.5[ fast = false ]", { id: "grok-4.5", params: [{ id: "fast", value: "false" }] }],
    ["grok-4.5[]", { id: "grok-4.5" }],
  ])("parses %j", (spec, expected) => {
    expect(parseCursorModelSpec(spec)).toEqual(expected);
  });

  it.each([
    ["", "no model id"],
    ["[fast=false]", "no model id"],
    ["grok-4.5[fast=false", "unterminated"],
    ["grok-4.5[fast]", "key=value"],
    ["grok-4.5[=false]", "key=value"],
    ["grok-4.5[fast=]", "key=value"],
  ])("rejects %j", (spec, msg) => {
    expect(() => parseCursorModelSpec(spec)).toThrow(msg);
  });
});

describe("cursorSdkInstalled", () => {
  // @cursor/sdk is an OPTIONAL PEER: nothing in this repo installs it, which is
  // exactly the state preflight has to detect
  it("is false for the absent optional package and true for a resolvable one", () => {
    expect(cursorSdkInstalled()).toBe(false);
    expect(cursorSdkInstalled("vitest")).toBe(true);
  });
});

describe("cursorSdkEvent", () => {
  it.each([
    [
      "assistant text + tool call",
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Write", input: { file_path: "src/a.ts" } }] },
      },
      // proseText splits the agent's own words out, so the handoff tail can
      // leave the tool summary behind — see stream.ts
      { text: "hi\n→ Write(src/a.ts)", prose: true, activity: true, proseText: "hi" },
    ],
    ["assistant with non-array content", { type: "assistant", message: {} }, { text: "", activity: true }],
    // typeof null === "object": the guard has to survive it
    ["assistant with a null envelope", { type: "assistant", message: null }, { text: "", activity: true }],
    ["assistant with no envelope at all", { type: "assistant", message: "odd" }, { text: "", activity: true }],
    [
      "assistant with only a tool call",
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
      { text: "→ Bash(ls)", prose: false, activity: true },
    ],
    [
      "assistant with a null content block",
      { type: "assistant", message: { content: [null, { type: "text", text: "hi" }] } },
      { text: "hi", prose: true, activity: true },
    ],
    [
      "a running tool call",
      { type: "tool_call", name: "Read", args: { path: "a.ts" }, status: "running" },
      { text: "→ Read(a.ts)", activity: true },
    ],
    [
      "a completed tool call",
      { type: "tool_call", name: "Read", args: { path: "a.ts" }, status: "completed" },
      { text: "", activity: true },
    ],
    ["a nameless tool call", { type: "tool_call", status: "running" }, { text: "→ tool", activity: true }],
    ["user", { type: "user", message: { content: [{ type: "text", text: "x" }] } }, { text: "", activity: true }],
    ["thinking", { type: "thinking", text: "long private reasoning" }, { text: "", activity: true }],
    ["status FINISHED", { type: "status", status: "FINISHED" }, { text: "" }],
    ["status ERROR with a message", { type: "status", status: "ERROR", message: "boom" }, { text: "boom" }],
    ["status ERROR with no message", { type: "status", status: "ERROR" }, { text: "" }],
    ["system", { type: "system" }, { text: "" }],
    // a usage tally with no cost field leaves the spend UNKNOWN, and stays
    // classified as noise: it legitimately trails the agent's final answer
    ["usage", { type: "usage" }, { text: "" }],
    ["usage carrying a cost", { type: "usage", totalCostUsd: 0.5 }, { text: "", costUsd: 0.5 }],
    ["request", { type: "request" }, { text: "" }],
    ["task", { type: "task", text: "x" }, { text: "" }],
    ["an unrecognised type", { type: "nonsense" }, { text: "" }],
  ])("maps %s", (_name, msg, expected) => {
    expect(cursorSdkEvent(msg as CursorMessage)).toEqual(expected);
  });

});

describe("runCursorSdkExecutor — happy path", () => {
  it("echoes assistant text and resolves true", async () => {
    const run = makeRun([{ type: "assistant", message: { content: [{ type: "text", text: "one\ntwo" }] } }]);
    const agent = makeAgent(run);
    const create = makeCreate(agent);
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(true);
    expect(emitMock).toHaveBeenCalledWith({ taskId: "T1", line: "one", lineSource: "executor" });
    expect(emitMock).toHaveBeenCalledWith({ taskId: "T1", line: "two", lineSource: "executor" });
    expect(logMock).toHaveBeenCalledWith("prog", "  T1› one", false);
    expect(rawLogMock).toHaveBeenCalledWith("prog", "T1");
    expect(logHarness.rawFinish).toHaveBeenCalledTimes(1);
    expect(logged()).toContain("  T1: cursorsdk finished (0s)");
    expect(agent.close).toHaveBeenCalled();
  });

  // the SDK reports usage per turn, so a task that took three turns arrives as
  // three figures — keeping only the last would under-report every long task,
  // which is exactly the shape max_cost_usd exists to stop
  it("sums the per-turn usage tallies and reports the total once", async () => {
    const run = makeRun([
      { type: "usage", totalCostUsd: 0.25 },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      { type: "usage", totalCostUsd: 0.5 },
    ] as CursorMessage[]);
    const create = makeCreate(makeAgent(run));
    const seen: (number | undefined)[] = [];
    const ok = await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create }, (usd) =>
      seen.push(usd),
    );
    expect(ok).toBe(true);
    expect(seen).toEqual([0.75]);
  });

  // The handoff has to work on EVERY backend or a retry on this one starts
  // blind — the in-process path had the final answer and was dropping it.
  it("hands over the whole final answer, not just its last line", async () => {
    const run = makeRun([], { status: "finished", result: "changed a.ts\nthe SDK rejects an empty model id" });
    const create = makeCreate(makeAgent(run));
    const seen: string[] = [];
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create }, undefined, (text) =>
      seen.push(text),
    );
    expect(seen).toEqual(["changed a.ts\nthe SDK rejects an empty model id"]);
  });

  // `result` is hardcoded empty on every path that did not reach wait(), so the
  // streamed prose is the only account those exits have — and a timed-out
  // attempt is the expensive one whose dead ends must not be re-derived.
  it("hands over the streamed prose when a timeout leaves no result", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun(
        [
          { type: "tool_call", status: "running", name: "Edit", args: { file_path: "auth.ts" } },
          { type: "assistant", message: { content: [{ type: "text", text: "the auth handler was the wrong layer" }] } },
        ],
        FINISHED,
        { wait: never },
      );
      const create = makeCreate(makeAgent(run));
      const seen: string[] = [];
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create }, undefined, (text) =>
        seen.push(text),
      );
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
      // prose only: the tool summary is the harness narrating, and the next
      // attempt can read the diff for what was edited
      expect(seen).toEqual(["the auth handler was the wrong layer"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands over the streamed prose when the user skips the task", async () => {
    const ac = new AbortController();
    const run = makeRun([], FINISHED, {
      wait: never,
      stream: async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "the migration needs a down step" }] } };
        ac.abort();
        yield { type: "assistant", message: { content: [{ type: "text", text: "never reached" }] } };
      },
    });
    const create = makeCreate(makeAgent(run));
    const seen: string[] = [];
    const ok = await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, ac.signal, { create }, undefined, (text) =>
      seen.push(text),
    );
    expect(ok).toBe(false);
    expect(seen).toEqual(["the migration needs a down step"]);
  });

  it("keeps only the last 20 prose lines of the fallback tail", async () => {
    const text = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
    const run = makeRun([{ type: "assistant", message: { content: [{ type: "text", text }] } }], {
      status: "finished",
      result: "",
    });
    const create = makeCreate(makeAgent(run));
    const seen: string[] = [];
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create }, undefined, (t) => seen.push(t));
    expect(seen[0].split("\n")).toHaveLength(20);
    expect(seen[0].split("\n")[0]).toBe("line 6");
  });

  // the spawn path bounds this and this one did not: an agent that ends by
  // pasting a file must not hand the retry a prompt-sized wall of it
  it("bounds the handoff at 2000 chars, keeping the end", async () => {
    const run = makeRun([], { status: "finished", result: "x".repeat(1990) + "THE ACTUAL POINT" });
    const create = makeCreate(makeAgent(run));
    const seen: string[] = [];
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create }, undefined, (text) =>
      seen.push(text),
    );
    expect(seen[0]).toHaveLength(2000);
    expect(seen[0].endsWith("THE ACTUAL POINT")).toBe(true);
  });

  // the one non-finished shape that still carries a `result` — an SDK-reported
  // run error. The exits that carry none are covered above.
  it("hands it over even when the run did not finish", async () => {
    const run = makeRun([], { status: "error", result: "got as far as the auth handler", error: { message: "boom" } });
    const create = makeCreate(makeAgent(run));
    const seen: string[] = [];
    const ok = await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create }, undefined, (text) =>
      seen.push(text),
    );
    expect(ok).toBe(false);
    expect(seen).toEqual(["got as far as the auth handler"]);
  });

  it("hands over nothing when the run said nothing", async () => {
    const run = makeRun([], { status: "finished", result: "   " });
    const create = makeCreate(makeAgent(run));
    const seen: string[] = [];
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create }, undefined, (text) =>
      seen.push(text),
    );
    expect(seen).toEqual([]);
  });

  it("emits blank lines to the pane but does not log them", async () => {
    const run = makeRun([{ type: "assistant", message: { content: [{ type: "text", text: "a\n\nb" }] } }]);
    const create = makeCreate(makeAgent(run));
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create });
    expect(lines()).toEqual(["a", "", "b"]);
    expect(logged()).not.toContain("  T1› ");
  });

  it("survives a close() that throws", async () => {
    const run = makeRun([]);
    const agent = makeAgent(run);
    agent.close.mockImplementation(() => {
      throw new Error("already gone");
    });
    const create = makeCreate(agent);
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(true);
  });
});

describe("runCursorSdkExecutor — blocked-marker classification", () => {
  it("fails when the agent's last prose line is the marker", async () => {
    const run = makeRun([{ type: "assistant", message: { content: [{ type: "text", text: "RALPHRUN_BLOCKED: no creds" }] } }]);
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(false);
    expect(logged().join("\n")).toContain("no creds");
  });

  it("clears the marker when the agent kept working invisibly", async () => {
    const run = makeRun([
      { type: "assistant", message: { content: [{ type: "text", text: "RALPHRUN_BLOCKED: no creds" }] } },
      { type: "thinking", text: "actually…" },
    ]);
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(true);
  });

  it("hears a marker that appears only in the run result", async () => {
    const run = makeRun([], { status: "finished", result: "RALPHRUN_BLOCKED: gate closed" });
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(false);
    expect(logged().join("\n")).toContain("gate closed");
  });

  it("ignores a marker inside a tool call's arguments", async () => {
    const run = makeRun([
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "RALPHRUN_BLOCKED: x" } }] } },
    ]);
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(true);
  });

  it("ignores a marker printed by the harness's own status message", async () => {
    const run = makeRun([{ type: "status", status: "ERROR", message: "RALPHRUN_BLOCKED: x" }]);
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(true);
  });

  it("never prints the run result on success", async () => {
    const run = makeRun([{ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }], {
      status: "finished",
      result: "SECRET RESULT",
    });
    const create = makeCreate(makeAgent(run));
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create });
    expect(lines()).not.toContain("SECRET RESULT");
  });
});

describe("runCursorSdkExecutor — failures", () => {
  it("fails on a run that finished with status error", async () => {
    const run = makeRun([], { status: "error", error: { message: "boom" } });
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(false);
    expect(logged().join("\n")).toContain("cursorsdk run error: boom");
  });

  it("says 'no detail' when a failed run carries neither an error nor a result", async () => {
    const run = makeRun([], { status: "error" });
    const create = makeCreate(makeAgent(run));
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create });
    expect(logged().join("\n")).toContain("no detail");
  });

  it("fails on a cancelled run and falls back to its partial result for detail", async () => {
    const run = makeRun([], { status: "cancelled", result: "half done" });
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(false);
    expect(logged().join("\n")).toContain("cursorsdk run cancelled: half done");
  });

  it("fails when create() throws, surfacing the message", async () => {
    const create = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(
      await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create }),
    ).toBe(false);
    expect(logged().join("\n")).toContain("network down");
  });

  it("survives a non-Error rejection from the SDK", async () => {
    const create = vi.fn(async () => {
      throw "plain string";
    });
    expect(
      await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create }),
    ).toBe(false);
    expect(logged().join("\n")).toContain("plain string");
  });

  it("explains that SDK model ids are not the CLI ids", async () => {
    const create = vi.fn(async () => {
      throw new Error("Cannot use this model: cursor-grok-4.5-high");
    });
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create });
    expect(logged().join("\n")).toContain("cursorsdk model ids are NOT the 'cursor:' CLI ids");
  });

  it("fails on a malformed model spec before touching the SDK", async () => {
    const create = makeCreate(makeAgent(makeRun([])));
    const spec: AgentSpec = { cli: "cursorsdk", model: "grok-4.5[fast]" };
    expect(await runCursorSdkExecutor(spec, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(false);
    expect(logged().join("\n")).toContain("key=value");
    expect(create).not.toHaveBeenCalled();
  });

  it("fails without an API key, before create() is ever consulted", async () => {
    delete process.env.CURSOR_API_KEY;
    const create = makeCreate(makeAgent(makeRun([])));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(false);
    expect(logged().join("\n")).toContain("CURSOR_API_KEY");
    expect(create).not.toHaveBeenCalled();
  });

  it("memoizes a failed @cursor/sdk import until the cache is reset", async () => {
    const importSdk = vi.fn(async () => {
      throw new Error("ERR_MODULE_NOT_FOUND");
    });
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { importSdk })).toBe(false);
    expect(logged().join("\n")).toContain("@cursor/sdk");
    expect(logged().join("\n")).toContain("Node >= 22.13");
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { importSdk });
    expect(importSdk).toHaveBeenCalledTimes(1);
    resetCursorSdkCacheForTest();
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { importSdk });
    expect(importSdk).toHaveBeenCalledTimes(2);
  });

  // The ONE case that exercises the real `import(SDK_SPECIFIER)`. It is
  // deterministic because @cursor/sdk is an OPTIONAL PEER: nothing in this repo
  // installs it, so the import always rejects — which is the branch being
  // pinned. Hand-install it here and this fails (and would make a real API
  // call), which is the loud signal you want.
  it("reports the missing optional package when nothing is injected", async () => {
    const out = await runCursorSdk({
      model: "composer-2",
      prompt: "p",
      cwd: "ws",
      timeoutSecs: 60,
      mode: "agent",
      onEvent: () => {},
    });
    expect(out.status).toBe("error");
    expect(out.error).toContain("@cursor/sdk");
    expect(out.error).toContain(process.version);
  });

  it("runs through a resolved dynamic import of Agent.create", async () => {
    const create = makeCreate(makeAgent(makeRun([{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }])));
    const importSdk = vi.fn(async () => ({ Agent: { create } }));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { importSdk })).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(lines()).toContain("ok");
  });
});

describe("runCursorSdkExecutor — deadline, cancel and abort", () => {
  it("times out, cancels the run and closes the agent", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, { wait: never });
      const agent = makeAgent(run);
      const create = makeCreate(agent);
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
      expect(logged().join("\n")).toContain("TIMEOUT");
      expect(logHarness.rawFinish).toHaveBeenCalledTimes(1);
      expect(run.cancel).toHaveBeenCalled();
      expect(agent.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not held hostage by a cancel() that never resolves", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, { wait: never, cancel: never });
      const create = makeCreate(makeAgent(run));
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a cancel() that rejects", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, {
        wait: never,
        cancel: async () => {
          throw new Error("wedged");
        },
      });
      const agent = makeAgent(run);
      const create = makeCreate(agent);
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
      expect(agent.close).toHaveBeenCalled(); // the rejection was swallowed, not propagated
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips cancel() for a run that does not support it, but still closes", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, { wait: never, supports: (op) => op !== "cancel" });
      const agent = makeAgent(run);
      const create = makeCreate(agent);
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
      expect(run.cancel).not.toHaveBeenCalled();
      expect(agent.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // the deadline almost always fires while create()/send() is still in flight,
  // when stop() has no handle yet: the agent MUST still be stopped when one
  // arrives, not left running in the user's repo until it finishes on its own
  it("closes an agent whose create() only resolved after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, { wait: never });
      const agent = makeAgent(run);
      const create = vi.fn(async () => {
        await new Promise<void>((r) => setTimeout(r, 3000));
        return agent as unknown as CursorAgent;
      });
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
      expect(agent.close).not.toHaveBeenCalled(); // nothing existed to close yet
      await vi.advanceTimersByTimeAsync(2000);
      expect(agent.send).not.toHaveBeenCalled(); // and the prompt is never sent
      expect(agent.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a run whose send() only resolved after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, { wait: never });
      const agent = {
        send: vi.fn(async () => {
          await new Promise<void>((r) => setTimeout(r, 3000));
          return run as unknown as CursorRun;
        }),
        close: vi.fn(),
      };
      const create = makeCreate(agent);
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
      expect(run.cancel).not.toHaveBeenCalled(); // no run handle at the deadline
      await vi.advanceTimersByTimeAsync(2000);
      expect(run.cancel).toHaveBeenCalled(); // …so the late one is cancelled instead
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops feeding the pane once the deadline has passed", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, {
        wait: never,
        // a run that cannot be cancelled: only leaving the loop stops the flow
        supports: (op) => op !== "cancel",
        stream: async function* () {
          for (let i = 0; ; i++) {
            await new Promise<void>((r) => setTimeout(r, 400));
            yield { type: "assistant", message: { content: [{ type: "text", text: `l${i}` }] } };
          }
        },
      });
      const create = makeCreate(makeAgent(run));
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
      const seen = lines().length;
      expect(seen).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(lines()).toHaveLength(seen);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a create() that never resolves, with no handle to close", async () => {
    vi.useFakeTimers();
    try {
      const create = vi.fn(never<CursorAgent>);
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
      expect(logged().join("\n")).toContain("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a close() that throws while stopping a timed-out run", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, { wait: never });
      const agent = makeAgent(run);
      agent.close.mockImplementation(() => {
        throw new Error("already gone");
      });
      const create = makeCreate(agent);
      const p = runCursorSdkExecutor(EXECU, "p", makeCfg({ task_timeout: 1 }), "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns immediately for an already-aborted signal, never calling create()", async () => {
    const ac = new AbortController();
    ac.abort();
    const create = makeCreate(makeAgent(makeRun([])));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, ac.signal, { create })).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(logged().join("\n")).toContain("skipped by user");
  });

  it("aborts mid-stream, cancels, closes and leaves no listener behind", async () => {
    const ac = new AbortController();
    const removed = vi.spyOn(ac.signal, "removeEventListener");
    const run = makeRun([], FINISHED, {
      wait: never,
      stream: async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "working" }] } };
        await never<void>();
      },
    });
    const agent = makeAgent(run);
    const create = makeCreate(agent);
    const p = runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, ac.signal, { create });
    await tick();
    expect(lines()).toContain("working");
    ac.abort();
    expect(await p).toBe(false);
    expect(logged().join("\n")).toContain("skipped by user");
    expect(run.cancel).toHaveBeenCalled();
    expect(agent.close).toHaveBeenCalled();
    expect(removed).toHaveBeenCalled();
    expect(logHarness.rawFinish).toHaveBeenCalledTimes(1);
  });
});

describe("runCursorSdkExecutor — heartbeat", () => {
  it("emits progress every second regardless of heartbeat_secs", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, { wait: never });
      const create = makeCreate(makeAgent(run));
      // heartbeat_secs omitted -> exercises the `?? 30` fallback
      const cfg = makeCfg({ task_timeout: 5, heartbeat_secs: undefined });
      const p = runCursorSdkExecutor(EXECU, "p", cfg, "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(3000);
      const beats = emitMock.mock.calls.map((c) => c[0]).filter((e) => e.elapsedMs !== undefined);
      expect(beats).toHaveLength(3);
      expect(beats[0]).toEqual({ taskId: "T1", elapsedMs: 1000, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs one …working line after a silent stretch", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, { wait: never });
      const create = makeCreate(makeAgent(run));
      const cfg = makeCfg({ task_timeout: 10, heartbeat_secs: 2 });
      const p = runCursorSdkExecutor(EXECU, "p", cfg, "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(3000);
      expect(logged().filter((l) => l.includes("working"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an invisible thinking message reset the silence clock", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, {
        wait: never,
        stream: async function* () {
          await new Promise<void>((r) => setTimeout(r, 1500));
          yield { type: "thinking", text: "…" };
          await never<void>();
        },
      });
      const create = makeCreate(makeAgent(run));
      const cfg = makeCfg({ task_timeout: 10, heartbeat_secs: 2 });
      const p = runCursorSdkExecutor(EXECU, "p", cfg, "ws", "prog", TASK, undefined, { create });
      await vi.advanceTimersByTimeAsync(3000);
      expect(logged().filter((l) => l.includes("working"))).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runCursorSdk — SDK options", () => {
  it("pins the sandbox off, the setting sources empty and the model variant", async () => {
    const create = makeCreate(makeAgent(makeRun([])));
    const spec: AgentSpec = { cli: "cursorsdk", model: "grok-4.5[fast=false,effort=high]" };
    await runCursorSdkExecutor(spec, "p", makeCfg(), "ws", "prog", TASK, undefined, { create });
    expect(create).toHaveBeenCalledWith({
      apiKey: "k",
      model: { id: "grok-4.5", params: [{ id: "fast", value: "false" }, { id: "effort", value: "high" }] },
      mode: "agent",
      local: { cwd: "ws", settingSources: [], sandboxOptions: { enabled: false } },
    });
  });

  it("skips the stream for a run that cannot stream, and still classifies it", async () => {
    const run = makeRun(
      [{ type: "assistant", message: { content: [{ type: "text", text: "unseen" }] } }],
      { status: "finished" }, // no `result` either: the `?? ""` fallback
      { supports: (op) => op !== "stream" },
    );
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create })).toBe(true);
    expect(lines()).toEqual([]);
  });

  it("says so once when extra_executor_args cannot be honoured", async () => {
    const create = makeCreate(makeAgent(makeRun([])));
    await runCursorSdkExecutor(EXECU, "p", makeCfg({ extra_executor_args: ["--x"] }), "ws", "prog", TASK, undefined, { create });
    expect(logged().filter((l) => l.includes("extra_executor_args ignored"))).toHaveLength(1);
    logMock.mockClear();
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { create });
    expect(logged().filter((l) => l.includes("extra_executor_args ignored"))).toHaveLength(0);
  });

  it("warns once about the default (billed) model variant, and not when one is pinned", async () => {
    const create = makeCreate(makeAgent(makeRun([])));
    const importSdk = vi.fn(async () => ({ Agent: { create } }));
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { importSdk });
    await runCursorSdkExecutor(EXECU, "p", makeCfg(), "ws", "prog", TASK, undefined, { importSdk });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("FAST tier");

    resetCursorSdkCacheForTest();
    warn.mockClear();
    const pinned: AgentSpec = { cli: "cursorsdk", model: "grok-4.5[fast=false]" };
    await runCursorSdkExecutor(pinned, "p", makeCfg(), "ws", "prog", TASK, undefined, { importSdk });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("runCursorSdkText", () => {
  const ADVIS: AgentSpec = { cli: "cursorsdk", model: "composer-2" };

  it("returns the trimmed run result", async () => {
    const run = makeRun([], { status: "finished", result: "  APPROVE\n" });
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkText(ADVIS, "p", makeCfg(), "ws", "T1", "advisor", { create })).toBe("APPROVE");
  });

  it("rejects an oversized run result", async () => {
    const run = makeRun([], { status: "finished", result: "x".repeat(MAX_RESPONSE_CHARS + 1) });
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkText(ADVIS, "p", makeCfg(), "ws", "T1", "review", { create })).toBeNull();
  });

  it("streams to the pane without letting the stream into the answer", async () => {
    const run = makeRun(
      [
        { type: "thinking", text: "…" }, // renders nothing, so nothing reaches the pane
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: "a.ts" } }] } },
      ],
      { status: "finished", result: "CHANGES: none" },
    );
    const create = makeCreate(makeAgent(run));
    const out = await runCursorSdkText(ADVIS, "p", makeCfg(), "ws", "T1", "review", { create });
    expect(emitMock).toHaveBeenCalledWith({ taskId: "T1", line: "→ Read(a.ts)", lineSource: "review" });
    expect(out).toBe("CHANGES: none");
  });

  it("aborts an oversized streamed advisor response before the run finishes", async () => {
    const run = makeRun([], FINISHED, {
      wait: never,
      stream: async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "x".repeat(MAX_RESPONSE_CHARS + 1) }] } };
      },
    });
    const agent = makeAgent(run);
    const create = makeCreate(agent);
    expect(await runCursorSdkText(ADVIS, "p", makeCfg(), "ws", "T1", "review", { create })).toBeNull();
    expect(run.cancel).toHaveBeenCalled();
    expect(agent.close).toHaveBeenCalled();
    expect(emitMock.mock.calls.every((call) => String(call[0]?.line ?? "").length <= MAX_RESPONSE_CHARS)).toBe(true);
  });

  it("allows a streamed advisor response exactly at the limit", async () => {
    const text = "x".repeat(MAX_RESPONSE_CHARS);
    const run = makeRun([{ type: "assistant", message: { content: [{ type: "text", text }] } }], {
      status: "finished",
      result: "APPROVE",
    });
    const create = makeCreate(makeAgent(run));
    expect(await runCursorSdkText(ADVIS, "p", makeCfg(), "ws", "T1", "review", { create })).toBe("APPROVE");
    expect(run.cancel).not.toHaveBeenCalled();
  });

  it("returns null for an empty answer and for a failed run", async () => {
    const empty = makeCreate(makeAgent(makeRun([], { status: "finished", result: "   " })));
    expect(await runCursorSdkText(ADVIS, "p", makeCfg(), "ws", "T1", "advisor", { create: empty })).toBeNull();
    const failed = makeCreate(makeAgent(makeRun([], { status: "error", error: { message: "x" } })));
    expect(await runCursorSdkText(ADVIS, "p", makeCfg(), "ws", "T1", "advisor", { create: failed })).toBeNull();
  });

  it("asks for plan mode and honours advisor_timeout", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRun([], FINISHED, { wait: never });
      const create = makeCreate(makeAgent(run));
      const p = runCursorSdkText(ADVIS, "p", makeCfg({ advisor_timeout: 2 }), "ws", "T1", "advisor", { create });
      await vi.advanceTimersByTimeAsync(2500);
      expect(await p).toBeNull();
      expect(create.mock.calls[0][0]).toMatchObject({ mode: "plan", local: { cwd: "ws" } });
    } finally {
      vi.useRealTimers();
    }
  });
});
