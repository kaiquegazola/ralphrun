// run.test.ts — covers runTask: NATIVE + CROSS paths incl. BUG-3 approval gate.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./executor.js", () => ({ runExecutor: vi.fn() }));
vi.mock("./advisor.js", () => ({ getAdvice: vi.fn(), advisorReview: vi.fn() }));
vi.mock("./verify.js", () => ({ runVerify: vi.fn(), assembleFeedback: vi.fn() }));
vi.mock("./prompts.js", () => ({
  advisorPrompt: vi.fn(() => "ADVISOR_PROMPT"),
  buildPrompt: vi.fn(() => "PROMPT"),
  injectAdvice: vi.fn(() => "PROMPT+ADVICE"),
  readStandards: vi.fn(() => "STD"),
}));
vi.mock("./log.js", () => ({ log: vi.fn(), setReporter: vi.fn() }));
vi.mock("./tui/events.js", () => ({ emit: vi.fn() }));
vi.mock("./git.js", () => ({ captureReviewBase: vi.fn(() => "base-tree") }));

import { runTask } from "./run.js";
import { runExecutor } from "./executor.js";
import { getAdvice, advisorReview } from "./advisor.js";
import { runVerify, assembleFeedback } from "./verify.js";
import { injectAdvice } from "./prompts.js";
import { log } from "./log.js";
import { emit } from "./tui/events.js";
import { captureReviewBase } from "./git.js";
import { advisorPlanKey } from "./plan-cache.js";
import type { Config } from "./config.js";
import type { PRD, Task } from "./prd.js";

const mExec = vi.mocked(runExecutor);
const mAdvice = vi.mocked(getAdvice);
const mReview = vi.mocked(advisorReview);
const mVerify = vi.mocked(runVerify);
const mFeedback = vi.mocked(assembleFeedback);
const mInject = vi.mocked(injectAdvice);
const mLog = vi.mocked(log);
const mEmit = vi.mocked(emit);
const mCaptureReviewBase = vi.mocked(captureReviewBase);

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
    max_stalled_review_rounds: 2,
    heartbeat_secs: 30,
    commit_per_task: true,
    commit_message_template: "{id}: {title}",
    stop_on_blocked: false,
    extra_executor_args: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete task.plan;
  delete task.planKey;
  task.retries = 0;
  mExec.mockResolvedValue(true);
  mVerify.mockResolvedValue({ passed: true, output: "out" });
  mAdvice.mockResolvedValue("advice");
  mReview.mockResolvedValue({ approved: true, changes: "", diff: "" });
  mFeedback.mockReturnValue("FEEDBACK");
  mCaptureReviewBase.mockReturnValue("base-tree");
});

describe("runTask NATIVE", () => {
  it("passes when executor ok and verify passes, passing --advisor", async () => {
    const c = cfg();
    const result = await runTask(task, prd, c, "/ws", "/prog");
    expect(result.ok).toBe(true);
    expect(mExec).toHaveBeenCalledWith(c.executor, "PROMPT", c, "/ws", "/prog", task, ["--advisor", "fable"], undefined);
  });

  it("fails when verify fails even if executor ok", async () => {
    mVerify.mockResolvedValue({ passed: false, output: "x" });
    const result = await runTask(task, prd, cfg(), "/ws", "/prog");
    expect(result.ok).toBe(false);
  });
});

describe("runTask CROSS", () => {
  it("round 1 PASS with advice injected", async () => {
    // not native: advisor cli grok
    const result = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(result.ok).toBe(true);
    expect(mInject).toHaveBeenCalled();
  });

  it("reviews against the baseline captured by the loop", async () => {
    const c = cfg({ advisor: { cli: "grok", model: "g" } });
    await runTask(task, prd, c, "/ws", "/prog", undefined, undefined, "task-start");
    expect(mReview).toHaveBeenCalledWith(
      task, prd, c.advisor, c, "/ws", "/prog", "STD", "task-start",
    );
  });

  it("skips injectAdvice when getAdvice returns null", async () => {
    mAdvice.mockResolvedValue(null);
    const result = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(result.ok).toBe(true);
    expect(mInject).not.toHaveBeenCalled();
  });

  it("no advisor: review off, passes on tests only", async () => {
    const result = await runTask(task, prd, cfg({ advisor: null }), "/ws", "/prog");
    expect(result.ok).toBe(true);
    expect(mAdvice).not.toHaveBeenCalled();
    expect(mReview).not.toHaveBeenCalled();
  });

  it("no advisor never injects a leftover plan into a fix round", async () => {
    const t = { ...task, plan: "stale-plan", planKey: "stale-key" };
    mVerify.mockResolvedValue({ passed: false, output: "failed" });
    await runTask(t, prd, cfg({ advisor: null, max_review_rounds: 1 }), "/ws", "/prog");
    expect(mExec).toHaveBeenCalledTimes(2);
    expect(mInject).not.toHaveBeenCalled();
  });

  it("review_after off but advisor present → passes without review", async () => {
    const result = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" }, review_after: false }), "/ws", "/prog");
    expect(result.ok).toBe(true);
    expect(mAdvice).toHaveBeenCalled();
    expect(mReview).not.toHaveBeenCalled();
  });

  it("reviewer requests changes while tests pass → automatically runs one focused fix", async () => {
    mVerify.mockResolvedValue({ passed: true, output: "" }); // tests always pass
    mReview
      .mockResolvedValueOnce({ approved: false, changes: "do X", diff: "D" })
      .mockResolvedValueOnce({ approved: true, changes: "", diff: "D2" });
    const c = cfg({ advisor: { cli: "grok", model: "g" }, max_review_rounds: 3 });
    const result = await runTask(task, prd, c, "/ws", "/prog");
    expect(result).toEqual({ ok: true });
    expect(mLog).toHaveBeenCalledWith("/prog", expect.stringContaining("do X"));
    expect(mFeedback).toHaveBeenCalledWith(true, true, "", false, "do X");
    // The review feedback, not a user decision, drove the second executor run.
    // runVerify is async now, so each recorded result is a promise
    const verdicts = await Promise.all(mVerify.mock.results.map((r) => r.value as Promise<{ passed: boolean }>));
    expect(verdicts.every((v) => v.passed)).toBe(true);
    expect(mReview).toHaveBeenCalledTimes(2);
    expect(mExec).toHaveBeenCalledTimes(2);
  });

  it("injects reviewer feedback into a human-requested retry prompt", async () => {
    const result = await runTask(task, prd, cfg({ advisor: null }), "/ws", "/prog", undefined, "fix the missing gate");
    expect(result.ok).toBe(true);
    expect(mExec).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("fix the missing gate"), expect.anything(), "/ws", "/prog", expect.anything(), [], undefined);
  });

  it("reuses plan if task.plan is already set", async () => {
    const c = cfg({ advisor: { cli: "grok", model: "g" } });
    const t = { ...task, plan: "old-plan" };
    t.planKey = advisorPlanKey(t, prd, c.advisor!, "STD");
    const result = await runTask(t, prd, c, "/ws", "/prog");
    expect(result.ok).toBe(true);
    expect(mAdvice).not.toHaveBeenCalled();
    expect(mInject).toHaveBeenCalledWith(expect.any(String), "old-plan");
  });

  it("regenerates a cached plan whose provenance does not match", async () => {
    const t = { ...task, plan: "old-plan", planKey: "other-advisor:other-model:hash" };
    await runTask(t, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(mAdvice).toHaveBeenCalled();
    expect(mInject).toHaveBeenCalledWith(expect.any(String), "advice");
  });

  it("calls onPlanGenerated when a new plan is created", async () => {
    mAdvice.mockResolvedValue("brand-new-plan");
    const onPlan = vi.fn();
    await runTask(task, prd, cfg({ advisor: { cli: "c", model: "m" } }), "/ws", "/prog", undefined, undefined, undefined, onPlan);
    expect(onPlan).toHaveBeenCalledWith("brand-new-plan", expect.stringMatching(/^c:m:[0-9a-f]{64}$/));
    expect(task.planKey).toMatch(/^c:m:[0-9a-f]{64}$/);
  });

  it("stops the fix loop early when failing verify/review/diff repeats", async () => {
    mVerify.mockResolvedValue({ passed: false, output: "same failure" });
    mReview.mockResolvedValue({ approved: false, changes: "same issue", diff: "same diff" });
    const c = cfg({ advisor: { cli: "grok", model: "g" }, max_review_rounds: 8, max_stalled_review_rounds: 1 });
    const result = await runTask(task, prd, c, "/ws", "/prog");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("review_stalled");
    expect(result.reviewChanges).toBe("same issue");
    expect(result.verificationPassed).toBe(false);
    expect(mReview).toHaveBeenCalledTimes(2);
    expect(mExec).toHaveBeenCalledTimes(2); // initial exec + one fix, then stop before another identical fix
  });

  it("uses default stalled-rounds and compacts oversized review feedback", async () => {
    mVerify.mockResolvedValue({ passed: true, output: "" });
    mReview.mockResolvedValue({ approved: false, changes: "x".repeat(1_200), diff: "d" });
    const c = cfg({ advisor: { cli: "grok", model: "g" } });
    delete (c as Partial<Config>).max_stalled_review_rounds;
    const result = await runTask(task, prd, c, "/ws", "/prog");
    expect(result.reason).toBe("review_stalled");
    expect(mLog).toHaveBeenCalledWith("/prog", expect.stringMatching(/x{999}…/));
  });

  it("feedback empty → break, then not approved → false", async () => {
    mReview.mockResolvedValue({ approved: false, changes: "", diff: "" });
    mFeedback.mockReturnValue(""); // nothing actionable
    const result = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(result.ok).toBe(false);
    // broke on round 1: only the initial executor ran, no fix round
    expect(mExec).toHaveBeenCalledTimes(1);
  });

  it("exhaust with approved but tests fail: final ok=false short-circuits verify", async () => {
    mExec.mockResolvedValue(false); // exec keeps failing
    mReview.mockResolvedValue({ approved: true, changes: "", diff: "" });
    const result = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(result.ok).toBe(false);
  });

  it("exhaust with approved, final exec ok and final verify passes → true", async () => {
    mReview.mockResolvedValue({ approved: true, changes: "", diff: "" });
    // 3 in-loop verifies fail (never PASS), final verify passes
    mVerify
      .mockResolvedValueOnce({ passed: false, output: "f" })
      .mockResolvedValueOnce({ passed: false, output: "f" })
      .mockResolvedValueOnce({ passed: false, output: "f" })
      .mockResolvedValue({ passed: true, output: "" });
    const result = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(result.ok).toBe(true);
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
    mVerify.mockResolvedValue({ passed: false, output: "fail" });
    mReview.mockResolvedValue({ approved: false, changes: "do X", diff: "D" }); // never approves -> loops + fixes
    await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(mEmit).toHaveBeenCalledWith({ taskId: "T1", subphase: "fixing" });
  });
});
