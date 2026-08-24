// expand.ts — JUST-IN-TIME expansion of skeleton tasks.
//
// STAGED AUTHORING lets the planner ship a PRD whose tasks start as a skeleton
// (id/title/deps only) and get expanded over studio turns. The run gates refuse
// a build with skeletal tasks — but expansion does not have to happen in the
// studio at all. When the loop meets a task with no details, the advisor fills
// them in HERE, seconds before execution, with the freshest context available:
// the architecture notes and the neighbors' scopes are all the prompt needs,
// and each call stays small no matter how large the product is.

import type { AgentSpec, Config } from "./config.js";
import { lastJsonObject } from "./fence.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { PRD, Task } from "./prd.js";
import { taskExpandPrompt } from "./prompts.js";
import { runAdvisorCli } from "./advisor.js";

/** a task the planner has not expanded yet: it lacks ANY of the executable fields */
export function isSkeletonTask(task: Task): boolean {
  return !task.description?.trim() || !task.acceptance?.length || !task.verify?.trim();
}

export interface TaskPatch {
  description?: string;
  acceptance?: string[];
  verify?: string;
  // DELIBERATELY no scope: an advisor-generated glob set cannot be validated
  // against every OTHER task's scope without a full-file pass, and an explicit
  // `scope: []` means UNRESTRICTED in this codebase — silently replacing it
  // with generated globs changes task meaning. Scope stays a planner/user
  // decision; the expansion fills only the fields the executor reads.
}

/**
 * Only ever FILLS: an existing non-empty field on the task wins over anything
 * in the reply, so an expansion can never erase what the planner (or the user)
 * already wrote. Returns null when the reply holds no usable spec at all.
 *
 * The reply MUST carry the id of the task being expanded: an unbound or
 * mis-targeted object would apply another task's description/verify here, and
 * nothing downstream would ever notice.
 */
export function parseTaskPatch(parsed: unknown, expectedId: string): TaskPatch | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.id !== expectedId) return null;
  const patch: TaskPatch = {};
  if (typeof p.description === "string" && p.description.trim()) patch.description = p.description;
  if (Array.isArray(p.acceptance) && p.acceptance.length && p.acceptance.every((a) => typeof a === "string"))
    patch.acceptance = p.acceptance as string[];
  if (typeof p.verify === "string" && p.verify.trim()) patch.verify = p.verify;
  return Object.keys(patch).length ? patch : null;
}

/**
 * FILL-ONLY application: an existing non-empty field on the task wins over
 * anything in the reply, so an expansion can never erase what the planner
 * (or the user) already wrote — it exists to fill gaps, and overwriting
 * authored spec is how plans silently drift.
 */
export function applyTaskPatch(task: Task, patch: TaskPatch): void {
  if (!task.description?.trim() && patch.description) task.description = patch.description;
  if (!task.acceptance?.length && patch.acceptance) task.acceptance = patch.acceptance;
  if (!task.verify?.trim() && patch.verify) task.verify = patch.verify;
}

/**
 * Ask the advisor for the full spec of ONE skeletal task. Best-effort by
 * design: null means "run with what the PRD has", never a crashed loop — the
 * verify gate downstream is still what decides whether the work counted.
 */
export async function expandSkeletonTask(
  task: Task,
  prd: PRD,
  advis: AgentSpec,
  cfg: Config,
  workspace: string,
  progress: string,
  signal?: AbortSignal,
): Promise<TaskPatch | null> {
  log(progress, t("expand.log.start", { id: task.id }));
  const out = await runAdvisorCli(advis, taskExpandPrompt(task, prd), cfg, workspace, task.id, "advisor", signal, progress);
  const patch = parseTaskPatch(lastJsonObject(out ?? ""), task.id);
  if (!patch) {
    log(progress, t("expand.log.failed", { id: task.id }));
    return null;
  }
  log(progress, t("expand.log.done", { id: task.id }));
  return patch;
}
