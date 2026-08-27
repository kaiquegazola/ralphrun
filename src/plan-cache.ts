// plan-cache.ts — whether a CROSS advisor plan is worth computing, and whether a
// persisted one may still be reused. Pure: no I/O, no CLI calls.

import { createHash } from "node:crypto";
import type { AgentSpec } from "./config.js";
import type { PRD, Task } from "./prd.js";
import { advisorPrompt } from "./prompts.js";

export function advisorPlanKey(task: Task, prd: PRD, advisor: AgentSpec, standards: string, workspace?: string): string {
  const promptHash = createHash("sha256").update(advisorPrompt(task, prd, standards, workspace)).digest("hex");
  return `${advisor.cli}:${advisor.model}:${promptHash}`;
}

/**
 * Drop a persisted plan so the next attempt re-advises from scratch.
 *
 * The key is derived from the advisor prompt, and a retry of the same task
 * changes nothing in it — so a task that stalled BECAUSE its plan was wrong would
 * retry with that exact plan forever. The plan has to be removed by whoever knows
 * the plan is the suspect; the key alone would be enough for run.ts to miss, but
 * leaving the dead text in prd.json makes the file lie about what is in play.
 */
export function invalidatePlan(task: Task): void {
  delete task.plan;
  delete task.planKey;
}

/** Score at or above which a task earns an advisor call. Overridable per project. */
export const DEFAULT_ADVISOR_PLAN_THRESHOLD = 3;

export interface PlanRoute {
  plan: boolean;
  /** the arithmetic and the facts behind it, for the log line when a plan is skipped */
  reason: string;
}

/**
 * Should this task get an advisor plan?
 *
 * Measured facts only — asking a model whether a task is hard costs the very call
 * this is trying to avoid, and its answer would not be reproducible.
 *
 * Deliberately biased toward planning: an unnecessary plan wastes one advisor
 * call, while skipping a needed one wastes a whole task plus its retries. At the
 * default threshold the only task that goes unplanned is small on EVERY axis AND
 * carries its own objective gate.
 */
export function routeAdvisorPlan(task: Task, threshold: number = DEFAULT_ADVISOR_PLAN_THRESHOLD): PlanRoute {
  // No verify command means nothing objective will ever contradict the executor,
  // so the plan is the last thing between it and an unchecked "done". Kept out of
  // the score on purpose: no threshold may route an unverified task past the
  // advisor, however small the task looks.
  if (!task.verify) return { plan: true, reason: "no verify command — an unverified task always gets a plan" };
  const description = task.description?.trim() ?? "";
  const words = description ? description.split(/\s+/).length : 0;
  const acceptance = task.acceptance?.length ?? 0;
  const deps = task.deps?.length ?? 0;
  const scope = task.scope?.length ?? 0;
  const score = acceptance + deps + scope + Math.ceil(words / 40);
  return {
    plan: score >= threshold,
    reason:
      `score ${score} ${score >= threshold ? ">=" : "<"} ${threshold} ` +
      `(acceptance:${acceptance} deps:${deps} scope:${scope} words:${words})`,
  };
}
