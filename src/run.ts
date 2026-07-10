// run.ts — run a single task: NATIVE (one claude call with --advisor) or
// CROSS (planner-before → executor → unified fix loop with verify + review).

import type { Config } from "./config.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { PRD, Task } from "./prd.js";
import { buildPrompt, injectAdvice, readStandards } from "./prompts.js";
import { runExecutor } from "./executor.js";
import { getAdvice, advisorReview } from "./advisor.js";
import { runVerify, assembleFeedback } from "./verify.js";
import { emit } from "./tui/events.js";

export async function runTask(
  task: Task,
  prd: PRD,
  cfg: Config,
  workspace: string,
  progress: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const execu = cfg.executor;
  const advis = cfg.advisor;
  const native = !!advis && execu.cli === "claude" && advis.cli === "claude";
  const standards = readStandards(workspace);
  const prompt = buildPrompt(task, prd, standards);

  // NATIVE: claude does executor + advisor (incl. its own pre-done review) in
  // one call. Objective test gate still applies; failures fall to task retry.
  const attempt = { n: task.retries + 1, max: cfg.max_retries_per_task };
  if (native && advis) {
    log(progress, t("run.log.native", { id: task.id, model: execu.model, advisorModel: advis.model }));
    emit({ taskId: task.id, subphase: "executing", attempt });
    const ok = await runExecutor(execu, prompt, cfg, workspace, progress, task, ["--advisor", advis.model], signal);
    emit({ taskId: task.id, subphase: "verifying", gates: { exec: ok } });
    return ok && (await runVerify(task, workspace, progress)).passed;
  }

  // CROSS: planner up front, then a unified fix loop — tests + review feed the
  // SAME feedback into the executor, within this task's budget.
  let execPrompt = prompt;
  if (advis) {
    emit({ taskId: task.id, subphase: "advising" });
    const advice = getAdvice(task, prd, advis, cfg, workspace, progress, standards);
    if (advice) execPrompt = injectAdvice(prompt, advice);
  }
  log(progress, t("run.log.cross", { id: task.id, executor: `${execu.cli}:${execu.model}` }));
  emit({ taskId: task.id, subphase: "executing", attempt });
  let ok = await runExecutor(execu, execPrompt, cfg, workspace, progress, task, [], signal);
  const reviewOn = !!advis && cfg.review_after;
  let lastApproved = !reviewOn; // review off → approval is vacuously true

  for (let rnd = 1; rnd <= cfg.max_review_rounds; rnd++) {
    emit({ taskId: task.id, subphase: "verifying", round: { n: rnd, max: cfg.max_review_rounds } });
    const { passed: testOk, output: testOut } = runVerify(task, workspace, progress);
    emit({ taskId: task.id, subphase: "reviewing" });
    const { approved, changes } =
      reviewOn && advis
        ? advisorReview(task, prd, advis, cfg, workspace, progress, standards)
        : { approved: true, changes: "" };
    lastApproved = approved;
    emit({ taskId: task.id, gates: { exec: ok, tests: testOk, review: approved } });
    if (ok && testOk && approved) {
      log(progress, t("run.log.pass", { id: task.id, n: rnd }));
      return true;
    }
    const feedback = assembleFeedback(ok, testOk, testOut, approved, changes);
    if (!feedback.trim()) break; // failing but nothing actionable; let task-level retry handle it
    log(
      progress,
      t("run.log.fixing", { id: task.id, n: rnd, exec: String(ok), tests: String(testOk), approved: String(approved) }),
    );
    const fixPrompt = buildPrompt(task, prd, standards) + "\n\n" + feedback;
    emit({ taskId: task.id, subphase: "fixing" });
    ok = await runExecutor(execu, fixPrompt, cfg, workspace, progress, task, [], signal);
  }

  log(progress, t("run.log.exhausted", { id: task.id }));
  if (!lastApproved) {
    log(progress, t("run.log.neverApproved", { id: task.id }));
    return false;
  }
  return ok && (await runVerify(task, workspace, progress)).passed;
}