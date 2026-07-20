// run.ts — run a single task: NATIVE (one claude call with --advisor) or
// CROSS (planner-before → executor → unified fix loop with verify + review).

import { nativeAdvisorArgs, supportsNativeAdvisor } from "./agents.js";
import type { Config } from "./config.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { PRD, Task } from "./prd.js";
import { buildPrompt, injectAdvice, readStandards } from "./prompts.js";
import { runExecutor } from "./executor.js";
import { getAdvice, advisorReview } from "./advisor.js";
import { runVerify, assembleFeedback } from "./verify.js";
import { emit } from "./tui/events.js";
import { captureReviewBase } from "./git.js";
import { advisorPlanKey } from "./plan-cache.js";

export type RunTaskFailureReason = "failed" | "review_changes" | "review_exhausted" | "review_stalled";

export interface RunTaskResult {
  ok: boolean;
  reason?: RunTaskFailureReason;
  reviewChanges?: string;
  verificationPassed?: boolean;
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
): Promise<RunTaskResult> {
  const execu = cfg.executor;
  const advis = cfg.advisor;
  const native = supportsNativeAdvisor(execu.cli, advis?.cli);
  const standards = readStandards(workspace);
  const prompt = injectReviewRetryFeedback(buildPrompt(task, prd, standards), reviewRetryFeedback);

  // NATIVE: claude does executor + advisor (incl. its own pre-done review) in
  // one call. Objective test gate still applies; failures fall to task retry.
  const attempt = { n: task.retries + 1, max: cfg.max_retries_per_task };
  if (native && advis) {
    log(progress, t("run.log.native", { id: task.id, cli: execu.cli, model: execu.model, advisorModel: advis.model }));
    emit({ taskId: task.id, subphase: "executing", attempt });
    const advisorArgs = nativeAdvisorArgs(execu.cli, advis.model);
    const ok = await runExecutor(execu, prompt, cfg, workspace, progress, task, advisorArgs, signal);
    emit({ taskId: task.id, subphase: "verifying", gates: { exec: ok } });
    const passed = ok && (await runVerify(task, workspace, progress)).passed;
    return { ok: passed, reason: passed ? undefined : "failed" };
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
      emit({ taskId: task.id, subphase: "advising" });
      const newAdvice = await getAdvice(task, prd, advis, cfg, workspace, progress, standards);
      if (newAdvice) {
        activeAdvice = newAdvice;
        task.plan = newAdvice;
        task.planKey = currentPlanKey;
        onPlanGenerated?.(newAdvice, currentPlanKey);
      }
    }
    if (activeAdvice) execPrompt = injectAdvice(prompt, activeAdvice);
  }
  log(progress, t("run.log.cross", { id: task.id, executor: `${execu.cli}:${execu.model}` }));
  emit({ taskId: task.id, subphase: "executing", attempt });
  let ok = await runExecutor(execu, execPrompt, cfg, workspace, progress, task, [], signal);
  const reviewOn = !!advis && cfg.review_after;
  // Diff every review against the index tree that existed before this task.
  // This works even before the first commit and excludes pre-existing changes.
  const taskReviewBase = reviewOn ? (reviewBase === undefined ? captureReviewBase(workspace) : reviewBase) : null;
  let lastApproved = !reviewOn; // review off → approval is vacuously true
  let lastReviewChanges = "";
  let lastVerificationPassed = false;
  let previousStallSignature = "";
  let stalledRounds = 0;
  let failureReason: RunTaskFailureReason = "failed";
  const maxStalledRounds = Math.max(0, cfg.max_stalled_review_rounds ?? 2);

  for (let rnd = 1; rnd <= cfg.max_review_rounds; rnd++) {
    emit({ taskId: task.id, subphase: "verifying", round: { n: rnd, max: cfg.max_review_rounds } });
    const { passed: testOk, output: testOut } = await runVerify(task, workspace, progress);
    lastVerificationPassed = testOk;
    emit({ taskId: task.id, subphase: "reviewing" });
    const { approved, changes, diff = "" } =
      reviewOn && advis
        ? await advisorReview(task, prd, advis, cfg, workspace, progress, standards, taskReviewBase)
        : { approved: true, changes: "", diff: "" };
    lastApproved = approved;
    if (changes.trim()) lastReviewChanges = changes;
    emit({ taskId: task.id, gates: { exec: ok, tests: testOk, review: approved } });
    if (ok && testOk && approved) {
      log(progress, t("run.log.pass", { id: task.id, n: rnd }));
      return { ok: true };
    }
    if (ok && testOk && !approved) {
      log(progress, t("run.log.reviewChanges", { id: task.id, n: rnd }));
      if (changes.trim()) log(progress, t("run.log.reviewFeedback", { id: task.id, changes: compactReviewChanges(changes, 1000) }));
    }
    const feedback = assembleFeedback(ok, testOk, testOut, approved, changes);
    if (!feedback.trim()) break; // failing but nothing actionable; let task-level retry handle it
    const stallSignature = reviewStallSignature(ok, testOk, testOut, approved, changes, diff);
    if (stallSignature === previousStallSignature) stalledRounds += 1;
    else stalledRounds = 0;
    previousStallSignature = stallSignature;
    if (maxStalledRounds > 0 && stalledRounds >= maxStalledRounds) {
      log(progress, t("run.log.stalledReview", { id: task.id, n: rnd, reason: t("run.reason.repeatedStall") }));
      failureReason = "review_stalled";
      break;
    }
    log(
      progress,
      t("run.log.fixing", { id: task.id, n: rnd, exec: String(ok), tests: String(testOk), approved: String(approved) }),
    );
    let fixPrompt = buildPrompt(task, prd, standards);
    if (activeAdvice) fixPrompt = injectAdvice(fixPrompt, activeAdvice);
    fixPrompt += "\n\n" + feedback;
    emit({ taskId: task.id, subphase: "fixing" });
    ok = await runExecutor(execu, fixPrompt, cfg, workspace, progress, task, [], signal);
  }

  log(progress, t("run.log.exhausted", { id: task.id }));
  if (!lastApproved) {
    log(progress, t("run.log.neverApproved", { id: task.id }));
    return {
      ok: false,
      reason: failureReason === "review_stalled" ? "review_stalled" : "review_exhausted",
      reviewChanges: lastReviewChanges,
      verificationPassed: lastVerificationPassed,
    };
  }
  const passed = ok && (await runVerify(task, workspace, progress)).passed;
  return { ok: passed, reason: passed ? undefined : "failed" };
}

function injectReviewRetryFeedback(prompt: string, feedback?: string): string {
  const trimmed = feedback?.trim();
  if (!trimmed) return prompt;
  return `${prompt}

## Human-requested review retry
The previous reviewer rejected this task. Apply the reviewer feedback below with concrete code, test, or config changes. Do not answer by arguing that no changes are needed. If the feedback is impossible or out of scope, make the smallest unblocker and explain the constraint in the final response.

Reviewer feedback:
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
): string {
  return [
    execOk ? "exec:1" : "exec:0",
    testOk ? "tests:1" : "tests:0",
    approved ? "review:1" : "review:0",
    "verify:" + normalizeSignal(testOut.slice(-3000)),
    "changes:" + normalizeSignal(changes),
    "diff:" + normalizeSignal(diff),
  ].join("\n");
}

function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
