// run.ts — run a single task: NATIVE (one claude call with --advisor) or
// CROSS (planner-before → executor → unified fix loop with verify + review).

import { nativeAdvisorArgs, supportsNativeAdvisor } from "./agents.js";
import type { Config } from "./config.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { PRD, Task } from "./prd.js";
import {
  buildPrompt,
  formatReviewFindings,
  injectAdvice,
  injectHandoff,
  injectReviewContext,
  readStandards,
  type ReviewFinding,
} from "./prompts.js";
import { runExecutor } from "./executor.js";
import { getAdvice, advisorReview } from "./advisor.js";
import { runVerify, assembleFeedback } from "./verify.js";
import { emit } from "./tui/events.js";
import { captureReviewBase } from "./git.js";
import { advisorPlanKey, routeAdvisorPlan } from "./plan-cache.js";
import { addCost, type CostTally } from "./stream.js";

export type RunTaskFailureReason = "failed" | "review_exhausted" | "review_stalled";
export const MAX_REVIEW_CYCLES = 20;

export interface RunTaskResult {
  ok: boolean;
  reason?: RunTaskFailureReason;
  reviewChanges?: string;
  reviewFindings?: ReviewFinding[];
  verificationPassed?: boolean;
  /** every executor call this attempt made, including the fix rounds */
  cost: CostTally;
  /**
   * The executor's own closing account of this attempt. Carried to the NEXT
   * attempt so it does not re-derive what this one already found — a retry gets
   * a brand-new session and, in worktree mode, a workspace where this attempt
   * was rolled back.
   */
  handoff?: string;
  /**
   * The reviewer's durable fact for the architecture notes, if it wrote one.
   * Only set on a task that PASSED — a note attached to work that was redone
   * describes an attempt, not the project.
   */
  note?: string;
}

export async function runTask(
  task: Task,
  prd: PRD,
  cfg: Config,
  workspace: string,
  progress: string,
  signal?: AbortSignal,
  reviewRetryFeedback?: string,
  reviewBase?: string | null,
  onPlanGenerated?: (plan: string, planKey: string) => void,
  /** the previous attempt's closing account, if there was one */
  handoff?: string,
): Promise<RunTaskResult> {
  const execu = cfg.executor;
  const advis = cfg.advisor;
  const native = supportsNativeAdvisor(execu.cli, advis?.cli);
  const standards = readStandards(workspace);
  const prompt = injectHandoff(injectReviewRetryFeedback(buildPrompt(task, prd, standards), reviewRetryFeedback), handoff);
  // one tally for the whole attempt: the fix rounds below are the same task's
  // money, and a per-round figure would hide what a stubborn task really cost
  const cost: CostTally = { usd: 0, unknown: false };
  const onCost = (usd: number | undefined): void => addCost(cost, usd);
  // The LAST thing the executor said this attempt. Reported by every call, so a
  // fix round overwrites the round before it — what the next attempt wants is
  // the most recent account, not the first.
  let lastHandoff: string | undefined;
  const onFinal = (text: string): void => {
    lastHandoff = text;
  };

  // No verify command and no reviewer: "done" here means nothing more than "the
  // executor exited 0". That is a legitimate setup, but it is silent, and a PRD
  // full of such tasks reads as verified when nothing verified it.
  if (!task.verify && !(advis && cfg.review_after)) log(progress, t("run.log.unverified", { id: task.id }));

  // NATIVE: claude does executor + advisor (incl. its own pre-done review) in
  // one call. Objective test gate still applies; failures fall to task retry.
  const attempt = { n: task.retries + 1, max: cfg.max_retries_per_task };
  if (native && advis) {
    log(progress, t("run.log.native", { id: task.id, cli: execu.cli, model: execu.model, advisorModel: advis.model }));
    emit({ taskId: task.id, subphase: "executing", attempt });
    const advisorArgs = nativeAdvisorArgs(execu.cli, advis.model);
    const ok = await runExecutor(execu, prompt, cfg, workspace, progress, task, advisorArgs, signal, onCost, onFinal);
    emit({ taskId: task.id, subphase: "verifying", gates: { exec: ok } });
    const passed = ok && (await runVerify(task, workspace, progress, signal)).passed;
    return { ok: passed, reason: passed ? undefined : "failed", cost, handoff: lastHandoff };
  }

  // CROSS: planner up front, then a unified fix loop — tests + review feed the
  // SAME feedback into the executor, within this task's budget.
  let execPrompt = prompt;
  let activeAdvice: string | undefined;
  if (advis) {
    const currentPlanKey = advisorPlanKey(task, prd, advis, standards);
    if (task.plan && task.planKey === currentPlanKey) {
      activeAdvice = task.plan;
      log(progress, `  ${task.id}› reusing saved plan from PRD`);
    } else {
      // A cached plan is free, so the router only decides whether one is worth
      // BUYING. Its facts are logged: a task that failed after being routed past
      // the advisor has to be diagnosable from progress.md alone.
      const route = routeAdvisorPlan(task, cfg.advisor_plan_threshold);
      if (!route.plan) {
        log(progress, t("run.log.planSkipped", { id: task.id, reason: route.reason }));
      } else {
        emit({ taskId: task.id, subphase: "advising" });
        // The advisor bills too and NOTHING meters it: it runs without the event
        // stream, because its stdout IS its answer. Marking the tally unknown is
        // what keeps the reported total honest as a floor instead of a total.
        addCost(cost, undefined);
        const newAdvice = await getAdvice(task, prd, advis, cfg, workspace, progress, standards, signal);
        if (newAdvice) {
          activeAdvice = newAdvice;
          task.plan = newAdvice;
          task.planKey = currentPlanKey;
          onPlanGenerated?.(newAdvice, currentPlanKey);
        }
      }
    }
    if (activeAdvice) execPrompt = injectAdvice(prompt, activeAdvice);
  }
  // The advisor call above is abortable, so a skip or quit during PLANNING lands
  // here. runExecutor checks the signal only after it has spawned, so without
  // this the abandoned task still starts a cli process just to kill it — and the
  // pane would show it entering "executing" after the user asked it to stop. The
  // fix loop already guards the same way at the top of each round.
  if (signal?.aborted) return { ok: false, reason: "failed", cost, handoff: lastHandoff };
  log(progress, t("run.log.cross", { id: task.id, executor: `${execu.cli}:${execu.model}` }));
  emit({ taskId: task.id, subphase: "executing", attempt });
  let ok = await runExecutor(execu, execPrompt, cfg, workspace, progress, task, [], signal, onCost, onFinal);
  const reviewOn = !!advis && cfg.review_after;
  // Diff every review against the index tree that existed before this task.
  // This works even before the first commit and excludes pre-existing changes.
  const taskReviewBase = reviewOn ? (reviewBase === undefined ? captureReviewBase(workspace) : reviewBase) : null;
  let lastApproved = !reviewOn; // review off → approval is vacuously true
  let lastReviewChanges = "";
  let lastReviewFindings: ReviewFinding[] = [];
  let lastVerificationPassed = false;
  let previousStallSignature = "";
  let stalledRounds = 0;
  let previousDiff = "";
  let previousVerificationOutput = "";
  let previousVerificationPassed = false;
  let failureReason: RunTaskFailureReason = "failed";
  const maxStalledRounds = Math.max(0, cfg.max_stalled_review_rounds ?? 2);
  // max_review_rounds is now the configurable soft budget, capped by the
  // absolute safety ceiling. The default is 20; the adaptive gate below stops
  // earlier when there is no actionable progress.
  const maxReviewCycles = Math.min(MAX_REVIEW_CYCLES, Math.max(1, cfg.max_review_rounds ?? MAX_REVIEW_CYCLES));

  for (let rnd = 1; rnd <= maxReviewCycles; rnd++) {
    // A skip or quit kills the child, but runExecutor still RETURNS — and a
    // failed exec always assembles feedback, so the loop would otherwise spend
    // every remaining round re-verifying and re-reviewing an attempt the user
    // already abandoned. The phases below are individually interruptible too;
    // this is what stops the next round from starting at all.
    if (signal?.aborted) break;
    emit({ taskId: task.id, subphase: "verifying", round: { n: rnd, max: maxReviewCycles } });
    const { passed: testOk, output: testOut } = await runVerify(task, workspace, progress, signal);
    lastVerificationPassed = testOk;
    emit({ taskId: task.id, subphase: "reviewing" });
    // The verify verdict goes WITH the diff: these two gates judge the same
    // attempt, and the reviewer that does not see the test output re-derives it
    // by guessing. run.ts still gates on testOk itself below — the reviewer gets
    // it as evidence, never as an approval (see verificationBlock in prompts.ts).
    if (reviewOn && advis) addCost(cost, undefined); // unmetered, same as the planner above
    const priorFindings = lastReviewFindings;
    const reviewContext = {
      cycle: rnd,
      maxCycles: maxReviewCycles,
      previousFindings: priorFindings,
      previousHandoff: lastHandoff,
      previousVerification: rnd > 1 ? { passed: previousVerificationPassed, output: previousVerificationOutput } : undefined,
      previousDiff,
    };
    const { approved, changes, diff = "", note, findings = [] } =
      reviewOn && advis
        ? await advisorReview(
            task,
            prd,
            advis,
            cfg,
            workspace,
            progress,
            standards,
            taskReviewBase,
            { passed: testOk, output: testOut },
            signal,
            reviewContext,
          )
        : { approved: true, changes: "", diff: "" };
    lastApproved = approved;
    if (changes.trim()) lastReviewChanges = changes;
    lastReviewFindings = findings;
    emit({ taskId: task.id, gates: { exec: ok, tests: testOk, review: approved } });
    if (ok && testOk && approved) {
      log(progress, t("run.log.pass", { id: task.id, n: rnd }));
      return { ok: true, cost, handoff: lastHandoff, note };
    }
    if (ok && testOk && !approved) {
      log(progress, t("run.log.reviewChanges", { id: task.id, n: rnd }));
      if (changes.trim()) log(progress, t("run.log.reviewFeedback", { id: task.id, changes: compactReviewChanges(changes, 1000) }));
    }
    const reviewFeedback = changes.trim() || (findings.length ? formatReviewFindings(findings) : "");
    const feedback = assembleFeedback(ok, testOk, testOut, approved, reviewFeedback);
    if (!feedback.trim()) break; // failing but nothing actionable; let task-level retry handle it
    const stallSignature = reviewStallSignature(ok, testOk, testOut, approved, reviewFeedback, diff, findings, lastHandoff);
    if (stallSignature === previousStallSignature) stalledRounds += 1;
    else stalledRounds = 0;
    previousStallSignature = stallSignature;
    previousDiff = diff;
    previousVerificationOutput = testOut;
    previousVerificationPassed = testOk;
    if (maxStalledRounds > 0 && stalledRounds >= maxStalledRounds) {
      log(progress, t("run.log.stalledReview", { id: task.id, n: rnd, reason: t("run.reason.repeatedStall") }));
      failureReason = "review_stalled";
      break;
    }
    // Do not spend an executor call on a fix that cannot receive a review: the
    // absolute ceiling counts reviewer cycles, and this is the last one.
    if (reviewOn && rnd >= maxReviewCycles) break;
    log(
      progress,
      t("run.log.fixing", { id: task.id, n: rnd, exec: String(ok), tests: String(testOk), approved: String(approved) }),
    );
    let fixPrompt = buildPrompt(task, prd, standards);
    if (activeAdvice) fixPrompt = injectAdvice(fixPrompt, activeAdvice);
    fixPrompt = injectReviewContext(
      fixPrompt,
      {
        cycle: rnd,
        maxCycles: maxReviewCycles,
        previousFindings: priorFindings,
        previousHandoff: lastHandoff,
        previousVerification: { passed: testOk, output: testOut },
        previousDiff: diff,
      },
      findings,
    );
    fixPrompt += "\n\n" + feedback;
    emit({ taskId: task.id, subphase: "fixing" });
    ok = await runExecutor(execu, fixPrompt, cfg, workspace, progress, task, [], signal, onCost, onFinal);
  }

  log(progress, t("run.log.exhausted", { id: task.id }));
  if (!lastApproved) {
    log(progress, t("run.log.neverApproved", { id: task.id }));
    return {
      ok: false,
      reason: failureReason === "review_stalled" ? "review_stalled" : "review_exhausted",
      reviewChanges: lastReviewChanges,
      reviewFindings: lastReviewFindings,
      // The ONLY thing that can override a refusing reviewer, so it has to mean
      // "something judged this and said yes". runVerify answers `passed: true`
      // for a task with no verify command — correct there, since nothing is
      // blocking — but read as verification it turns a missing gate into a
      // passing one, and a task no gate ever judged would reach done.
      verificationPassed: !!task.verify && lastVerificationPassed,
      cost,
      // The review-refused retry is the one that needs this MOST: it is handed
      // the reviewer's complaint but, without the account, none of what the
      // rejected attempt already tried — and in worktree mode that attempt was
      // rolled back, so the workspace cannot tell it either.
      handoff: lastHandoff,
    };
  }
  // The signal reaches THIS verify too, and it is the call that needs it most:
  // with review off the loop above breaks on the abort with lastApproved
  // vacuously true, so the skip lands here — straight into a gate that would
  // otherwise run the suite for its full 600s after the user abandoned the task.
  const passed = ok && (await runVerify(task, workspace, progress, signal)).passed;
  return { ok: passed, reason: passed ? undefined : "failed", cost, handoff: lastHandoff };
}

function injectReviewRetryFeedback(prompt: string, feedback?: string): string {
  const trimmed = feedback?.trim();
  if (!trimmed) return prompt;
  // Says "the workspace may not contain that attempt" on purpose: with
  // worktree_per_task the rejected attempt was DISCARDED with its cell, so an
  // instruction to fix code that is no longer there makes the executor invent a
  // target. The demand for concrete changes stays — it is what stops a retry
  // from answering that nothing needs doing.
  return `${prompt}

## A previous attempt at this task was rejected
That attempt may have been rolled back, so do not assume the workspace still contains it — implement the task from what is there now, with concrete code, test, or config changes that address the feedback below. Do not answer by arguing that no changes are needed. If the feedback is impossible or out of scope, make the smallest unblocker and explain the constraint in the final response.

Why it was rejected:
${trimmed}`;
}

function compactReviewChanges(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1).trimEnd() + "…";
}

function reviewStallSignature(
  execOk: boolean,
  testOk: boolean,
  testOut: string,
  approved: boolean,
  changes: string,
  diff: string,
  findings: ReviewFinding[] = [],
  handoff = "",
): string {
  return [
    execOk ? "exec:1" : "exec:0",
    testOk ? "tests:1" : "tests:0",
    approved ? "review:1" : "review:0",
    "verify:" + normalizeSignal(testOut.slice(-3000)),
    "changes:" + normalizeSignal(changes),
    "diff:" + normalizeSignal(diff),
    "findings:" +
      findings
        .map((f) => f.id + "|" + f.severity + "|" + (f.criterion ?? "") + "|" + (f.location ?? "") + "|" + f.problem + "|" + f.fix)
        .join("\n"),
    "handoff:" + executionReportSignal(handoff),
  ].join("\n");
}

function executionReportSignal(handoff: string): string {
  const line = handoff
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith("EXECUTION_REPORT:"));
  // Free-form closing prose is context for the next agent, not proof of
  // progress. Only the explicit report participates in the stall decision.
  return line ? normalizeSignal(line) : "";
}

function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
