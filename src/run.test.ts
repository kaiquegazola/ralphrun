// run.test.ts — covers runTask: NATIVE + CROSS paths incl. BUG-3 approval gate.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./executor.js", () => ({ runExecutor: vi.fn() }));
vi.mock("./advisor.js", () => ({ getAdvice: vi.fn(), advisorReview: vi.fn() }));
vi.mock("./verify.js", () => ({ runVerify: vi.fn(), assembleFeedback: vi.fn() }));
vi.mock("./prompts.js", () => ({
  buildPrompt: vi.fn(() => "PROMPT"),
  injectAdvice: vi.fn(() => "PROMPT+ADVICE"),
  readStandards: vi.fn(() => "STD"),
}));
vi.mock("./log.js", () => ({ log: vi.fn(), setReporter: vi.fn() }));
vi.mock("./tui/events.js", () => ({ emit: vi.fn() }));

import { runTask } from "./run.js";
import { runExecutor } from "./executor.js";
import { getAdvice, advisorReview } from "./advisor.js";
import { runVerify, assembleFeedback } from "./verify.js";
import { injectAdvice } from "./prompts.js";
import { emit } from "./tui/events.js";
import type { Config } from "./config.js";
import type { PRD, Task } from "./prd.js";

const mExec = vi.mocked(runExecutor);
const mAdvice = vi.mocked(getAdvice);
const mReview = vi.mocked(advisorReview);
const mVerify = vi.mocked(runVerify);
const mFeedback = vi.mocked(assembleFeedback);
const mInject = vi.mocked(injectAdvice);
const mEmit = vi.mocked(emit);

const task: Task = { id: "T1", title: "t", status: "todo", deps: [], retries: 0, description: "d", acceptance: ["a"] };
const prd: PRD = { project: "P", stack: "S", architecture_notes: "A", tasks: [task] };

function cfg(over: Partial<Config> = {}): Config {
  return {
    executor: { cli: "claude", model: "sonnet" },
    advisor: { cli: "claude", model: "fable" },
    task_timeout: 1800,
    advisor_timeout: 300,
    max_retries_per_task: 3,
    review_after: true,
    max_review_rounds: 3,
    heartbeat_secs: 30,
    commit_per_task: true,
    stop_on_blocked: false,
    extra_executor_args: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mExec.mockResolvedValue(true);
  mVerify.mockReturnValue({ passed: true, output: "out" });
  mAdvice.mockReturnValue("advice");
  mReview.mockReturnValue({ approved: true, changes: "" });
  mFeedback.mockReturnValue("FEEDBACK");
});

describe("runTask NATIVE", () => {
  it("passes when executor ok and verify passes, passing --advisor", async () => {
    const c = cfg();
    const ok = await runTask(task, prd, c, "/ws", "/prog");
    expect(ok).toBe(true);
    expect(mExec).toHaveBeenCalledWith(c.executor, "PROMPT", c, "/ws", "/prog", task, ["--advisor", "fable"], undefined);
  });

  it("fails when verify fails even if executor ok", async () => {
    mVerify.mockReturnValue({ passed: false, output: "x" });
    const ok = await runTask(task, prd, cfg(), "/ws", "/prog");
    expect(ok).toBe(false);
  });
});

describe("runTask CROSS", () => {
  it("round 1 PASS with advice injected", async () => {
    // not native: advisor cli grok
    const ok = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(ok).toBe(true);
    expect(mInject).toHaveBeenCalled();
  });

  it("skips injectAdvice when getAdvice returns null", async () => {
    mAdvice.mockReturnValue(null);
    const ok = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(ok).toBe(true);
    expect(mInject).not.toHaveBeenCalled();
  });

  it("no advisor: review off, passes on tests only", async () => {
    const ok = await runTask(task, prd, cfg({ advisor: null }), "/ws", "/prog");
    expect(ok).toBe(true);
    expect(mAdvice).not.toHaveBeenCalled();
    expect(mReview).not.toHaveBeenCalled();
  });

  it("review_after off but advisor present → passes without review", async () => {
    const ok = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" }, review_after: false }), "/ws", "/prog");
    expect(ok).toBe(true);
    expect(mAdvice).toHaveBeenCalled();
    expect(mReview).not.toHaveBeenCalled();
  });

  it("BUG-3: reviewer never approves → returns false even though tests pass", async () => {
    mVerify.mockReturnValue({ passed: true, output: "" }); // tests always pass
    mReview.mockReturnValue({ approved: false, changes: "do X" }); // never approves
    const c = cfg({ advisor: { cli: "grok", model: "g" }, max_review_rounds: 3 });
    const ok = await runTask(task, prd, c, "/ws", "/prog");
    expect(ok).toBe(false);
    // sanity: tests DID pass, so the false is purely the approval gate
    expect(mVerify.mock.results.every((r) => (r.value as { passed: boolean }).passed)).toBe(true);
    // exhausted all rounds (initial exec + one fix per round)
    expect(mReview).toHaveBeenCalledTimes(3);
  });

  it("feedback empty → break, then not approved → false", async () => {
    mReview.mockReturnValue({ approved: false, changes: "" });
    mFeedback.mockReturnValue(""); // nothing actionable
    const ok = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(ok).toBe(false);
    // broke on round 1: only the initial executor ran, no fix round
    expect(mExec).toHaveBeenCalledTimes(1);
  });

  it("exhaust with approved but tests fail: final ok=false short-circuits verify", async () => {
    mExec.mockResolvedValue(false); // exec keeps failing
    mReview.mockReturnValue({ approved: true, changes: "" });
    const ok = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(ok).toBe(false);
  });

  it("exhaust with approved, final exec ok and final verify passes → true", async () => {
    mReview.mockReturnValue({ approved: true, changes: "" });
    // 3 in-loop verifies fail (never PASS), final verify passes
    mVerify
      .mockReturnValueOnce({ passed: false, output: "f" })
      .mockReturnValueOnce({ passed: false, output: "f" })
      .mockReturnValueOnce({ passed: false, output: "f" })
      .mockReturnValue({ passed: true, output: "" });
    const ok = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(ok).toBe(true);
  });
});

describe("runTask RunEvents (spy the bus)", () => {
  const attempt = { n: 1, max: 3 }; // task.retries=0 -> n=1, cfg.max_retries_per_task=3

  it("NATIVE emits executing(attempt) then verifying(gates.exec)", async () => {
    await runTask(task, prd, cfg(), "/ws", "/prog");
    expect(mEmit).toHaveBeenCalledWith({ taskId: "T1", subphase: "executing", attempt });
    expect(mEmit).toHaveBeenCalledWith({ taskId: "T1", subphase: "verifying", gates: { exec: true } });
  });

  it("CROSS round-1 PASS emits advising→executing→verifying→reviewing→gates in order", async () => {
    await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    const seq = mEmit.mock.calls.map((c) => c[0]);
    expect(seq).toEqual([
      { taskId: "T1", subphase: "advising" },
      { taskId: "T1", subphase: "executing", attempt },
      { taskId: "T1", subphase: "verifying", round: { n: 1, max: 3 } },
      { taskId: "T1", subphase: "reviewing" },
      { taskId: "T1", gates: { exec: true, tests: true, review: true } },
    ]);
  });

  it("CROSS emits fixing before the fix executor re-runs", async () => {
    mReview.mockReturnValue({ approved: false, changes: "do X" }); // never approves -> loops + fixes
    await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(mEmit).toHaveBeenCalledWith({ taskId: "T1", subphase: "fixing" });
  });
});
