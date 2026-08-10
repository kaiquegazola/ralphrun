// run.test.ts — covers runTask: NATIVE + CROSS paths incl. BUG-3 approval gate.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./executor.js", () => ({ runExecutor: vi.fn() }));
vi.mock("./advisor.js", () => ({ getAdvice: vi.fn(), advisorReview: vi.fn() }));
vi.mock("./verify.js", () => ({ runVerify: vi.fn(), assembleFeedback: vi.fn() }));
vi.mock("./prompts.js", () => ({
  advisorPrompt: vi.fn(() => "ADVISOR_PROMPT"),
  buildPrompt: vi.fn(() => "PROMPT"),
  injectAdvice: vi.fn(() => "PROMPT+ADVICE"),
  injectHandoff: vi.fn((p: string) => p),
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
    expect(mExec).toHaveBeenCalledWith(
      c.executor, "PROMPT", c, "/ws", "/prog", task, ["--advisor", "fable"], undefined,
      expect.any(Function), expect.any(Function), undefined, expect.any(Function),
    );
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
      task, prd, c.advisor, c, "/ws", "/prog", "STD", "task-start", { passed: true, output: "out" },
    );
  });

  // The reviewer and the verify gate judge the SAME attempt. A reviewer that
  // cannot see the test output re-derives it by guessing, and asks for changes
  // the failing output already explains.
  it("hands the reviewer the verify verdict and output of this very round", async () => {
    mVerify.mockResolvedValue({ passed: false, output: "1 failing: expected 2 got 3" });
    mReview.mockResolvedValue({ approved: false, changes: "fix it", diff: "D" });
    const c = cfg({ advisor: { cli: "grok", model: "g" }, max_review_rounds: 1 });
    await runTask(task, prd, c, "/ws", "/prog");
    expect(mReview).toHaveBeenCalledWith(
      task, prd, c.advisor, c, "/ws", "/prog", "STD", "base-tree",
      { passed: false, output: "1 failing: expected 2 got 3" },
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
    // the advisor is unmetered, so a run that used one can only report a floor
    expect(result).toEqual({ ok: true, cost: { usd: 0, unknown: true } });
    expect(mLog).toHaveBeenCalledWith("/prog", expect.stringContaining("do X"));
    expect(mFeedback).toHaveBeenCalledWith(true, true, "", false, "do X");
    // The review feedback, not a user decision, drove the second executor run.
    // runVerify is async now, so each recorded result is a promise
    const verdicts = await Promise.all(mVerify.mock.results.map((r) => r.value as Promise<{ passed: boolean }>));
    expect(verdicts.every((v) => v.passed)).toBe(true);
    expect(mReview).toHaveBeenCalledTimes(2);
    expect(mExec).toHaveBeenCalledTimes(2);
  });

  // One tally for the whole attempt, fix rounds included: a per-round figure
  // would hide what a stubborn task really cost, which is the number the budget
  // ceiling is spending.
  it("adds up what every executor round reported", async () => {
    mExec.mockImplementation(async (...args) => {
      (args[8] as (usd: number | undefined) => void)(0.5);
      return true;
    });
    const result = await runTask(task, prd, cfg({ advisor: null }), "/ws", "/prog");
    expect(result.cost).toEqual({ usd: 0.5, unknown: false });
  });

  it("injects reviewer feedback into a human-requested retry prompt", async () => {
    const result = await runTask(task, prd, cfg({ advisor: null }), "/ws", "/prog", undefined, "fix the missing gate");
    expect(result.ok).toBe(true);
    expect(mExec).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("fix the missing gate"), expect.anything(), "/ws", "/prog", expect.anything(), [], undefined, expect.any(Function), expect.any(Function), undefined, expect.any(Function));
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

  // Routing on measured facts is what makes an advisor call optional at all —
  // this is the wiring, the decision itself is exhausted in plan-cache.test.ts.
  it("skips the advisor for a task the router rates trivial, and logs the facts", async () => {
    const trivial = { ...task, description: "Rename", acceptance: ["renamed"], verify: "npm test" };
    const result = await runTask(trivial, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(result.ok).toBe(true);
    expect(mAdvice).not.toHaveBeenCalled();
    expect(mInject).not.toHaveBeenCalled();
    expect(mLog).toHaveBeenCalledWith("/prog", expect.stringContaining("no advisor plan"));
    expect(mLog).toHaveBeenCalledWith("/prog", expect.stringContaining("acceptance:1 deps:0 scope:0 words:1"));
    // review still runs: the router buys fewer plans, it does not remove a gate
    expect(mReview).toHaveBeenCalled();
  });

  it("plans the same task once the project lowers the threshold", async () => {
    const trivial = { ...task, description: "Rename", acceptance: ["renamed"], verify: "npm test" };
    await runTask(trivial, prd, cfg({ advisor: { cli: "grok", model: "g" }, advisor_plan_threshold: 1 }), "/ws", "/prog");
    expect(mAdvice).toHaveBeenCalled();
  });

  // A cached plan costs nothing, so the router must never be what discards one.
  it("still reuses a valid cached plan for a task the router would not have planned", async () => {
    const c = cfg({ advisor: { cli: "grok", model: "g" } });
    const trivial = { ...task, description: "Rename", acceptance: ["renamed"], verify: "npm test", plan: "old-plan" };
    trivial.planKey = advisorPlanKey(trivial, prd, c.advisor!, "STD");
    await runTask(trivial, prd, c, "/ws", "/prog");
    expect(mInject).toHaveBeenCalledWith(expect.any(String), "old-plan");
    expect(mAdvice).not.toHaveBeenCalled();
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

  // verificationPassed is the ONLY thing that can override a refusing reviewer
  // (loop.ts's approve gate), so it has to mean "a gate ran and said yes".
  // runVerify answers passed:true for a task with no verify command — right
  // there, nothing is blocking — but read as verification it turns a MISSING
  // gate into a passing one, and a task nothing ever judged reaches done.
  it("does not report a missing verify command as verification that passed", async () => {
    mVerify.mockResolvedValue({ passed: true, output: "" });
    mReview.mockResolvedValue({ approved: false, changes: "needs work", diff: "d" });
    const c = cfg({ advisor: { cli: "grok", model: "g" }, max_review_rounds: 1 });

    expect((await runTask(task, prd, c, "/ws", "/prog")).verificationPassed).toBe(false);
    expect((await runTask({ ...task, verify: "npm test" }, prd, c, "/ws", "/prog")).verificationPassed).toBe(true);
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

  // A fix round re-sent the whole task prompt, so the agent re-read a codebase it
  // had just finished reading — the expensive half of a round, spent rediscovering
  // what it already knew.
  describe("resuming the executor's conversation", () => {
    const resumeCfg = () => cfg({ advisor: null, reuse_conversation: true });

    /** first call reports a session id, then fails so a fix round happens */
    function failFirstWithSession(): void {
      mExec.mockReset();
      mExec.mockImplementationOnce(async (...a: unknown[]) => {
        (a[9] as (id: string) => void)?.("sess-1");
        return false;
      });
      mExec.mockResolvedValue(true);
      mFeedback.mockReturnValue("FEEDBACK");
    }

    it("sends ONLY the feedback, with the session to resume", async () => {
      failFirstWithSession();
      await runTask(task, prd, resumeCfg(), "/ws", "/prog");
      const second = mExec.mock.calls[1];
      expect(second[1]).toBe("FEEDBACK"); // not the whole task prompt
      expect(second[10]).toBe("sess-1");
    });

    it("sends the whole prompt again when the knob is off", async () => {
      failFirstWithSession();
      await runTask(task, prd, cfg({ advisor: null }), "/ws", "/prog");
      const second = mExec.mock.calls[1];
      expect(second[1]).toContain("FEEDBACK");
      expect(second[1]).toContain("PROMPT"); // buildPrompt's mocked output
      expect(second[10]).toBeUndefined();
    });

    // a cli that never reported one cannot be resumed, and inventing a flag for
    // it would fail the round outright
    it("returns the executor's closing account, from the LAST round", async () => {
      mExec.mockReset();
      mExec.mockImplementationOnce(async (...a: unknown[]) => {
        (a[11] as (t: string) => void)?.("first round said this");
        return false;
      });
      mExec.mockImplementationOnce(async (...a: unknown[]) => {
        (a[11] as (t: string) => void)?.("second round said this");
        return true;
      });
      mFeedback.mockReturnValue("FEEDBACK");
      const r = await runTask(task, prd, cfg({ advisor: null }), "/ws", "/prog");
      // the next attempt wants the most recent account, not the first
      expect(r.handoff).toBe("second round said this");
    });

    it("sends the whole prompt again when the cli reported no session", async () => {
      mExec.mockReset();
      mExec.mockResolvedValueOnce(false).mockResolvedValue(true);
      mFeedback.mockReturnValue("FEEDBACK");
      await runTask(task, prd, resumeCfg(), "/ws", "/prog");
      const second = mExec.mock.calls[1];
      expect(second[1]).toContain("PROMPT");
      expect(second[10]).toBeUndefined();
    });
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

  // A reviewer that could not answer gives the executor nothing to fix, so the
  // fix loop must stop on the spot rather than re-running a dead reviewer for
  // every remaining round — and the task must NOT come back done.
  it("a not-approved review with no actionable changes fails fast, without more rounds", async () => {
    mReview.mockResolvedValue({ approved: false, changes: "", diff: "d" });
    mFeedback.mockReturnValue(""); // exec ok + tests ok + nothing to say about the review
    const result = await runTask(task, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(result).toMatchObject({ ok: false, reason: "review_exhausted" });
    expect(mExec).toHaveBeenCalledTimes(1); // no fix round was attempted
    expect(mReview).toHaveBeenCalledTimes(1);
  });
});

describe("runTask unverified warning", () => {
  // no verify command and no reviewer: "done" means only "the executor exited 0"
  it("warns when neither gate exists", async () => {
    await runTask({ ...task, verify: undefined }, prd, cfg({ advisor: null }), "/ws", "/prog");
    expect(mLog).toHaveBeenCalledWith("/prog", expect.stringContaining("no verify command and no reviewer"));
  });

  it("stays quiet when a verify command exists", async () => {
    await runTask({ ...task, verify: "npm test" }, prd, cfg({ advisor: null }), "/ws", "/prog");
    expect(mLog).not.toHaveBeenCalledWith("/prog", expect.stringContaining("no verify command"));
  });

  it("stays quiet when a reviewer exists", async () => {
    await runTask({ ...task, verify: undefined }, prd, cfg({ advisor: { cli: "grok", model: "g" } }), "/ws", "/prog");
    expect(mLog).not.toHaveBeenCalledWith("/prog", expect.stringContaining("no verify command"));
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
