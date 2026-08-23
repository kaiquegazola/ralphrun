// requeue.ts — apply a human's decision to one task, in the process that owns
// the backlog.
//
// THE prd.json rule (see loop.ts): every read-modify-write of that file must be
// SYNCHRONOUS, because the loop is one process on one thread and N parallel
// tasks are N child *processes* collected at await points. A read → mutate →
// save with no await in between is therefore atomic with respect to everything
// else the loop does.
//
// That rule holds for the loop's own writes and for anything running inside its
// process — which is exactly why a GUI host answering a decision must send the
// answer to the run and let it apply this, rather than writing the file from
// outside. A second process cannot participate in that guarantee: its stale
// snapshot lands last and quietly restores the status the human just changed.

import { readFileSync } from "node:fs";

import { invalidatePlan } from "./plan-cache.js";
import { savePrdAtomic } from "./prdwrite.js";
import type { PRD } from "./prd.js";

/**
 * `block` exists for a rollback: a host that reset a task and then could not
 * start the run has to put the status back rather than leave a phantom retry.
 */
export type RequeueAction = "retry" | "accept" | "block";

/**
 * true when the task was found and rewritten. `retry` also clears the retry
 * budget: a task that comes back with its attempts already spent re-blocks on
 * the first stumble, which is not what the human asked for.
 */
export function requeueTask(prdPath: string, taskId: string, action: RequeueAction): boolean {
  let prd: PRD;
  try {
    prd = JSON.parse(readFileSync(prdPath, "utf8")) as PRD;
  } catch {
    return false;
  }
  if (!Array.isArray(prd.tasks)) return false;
  const task = prd.tasks.find((t) => t.id === taskId);
  if (!task) return false;
  if (action === "accept") task.status = "done";
  else if (action === "block") task.status = "blocked";
  else {
    task.status = "todo";
    task.retries = 0;
    // The cached advisor plan belongs to the attempt that FAILED. Its key still
    // matches, so leaving it behind would hand the retry the same plan that did
    // not work — which is what every other manual retry path already avoids.
    invalidatePlan(task);
  }
  // false, not a throw: every caller is answering a HUMAN decision and needs
  // to say "not applied" (the inbox item comes back, the child emits
  // `decided: false`) rather than take its host down with it.
  try {
    savePrdAtomic(prdPath, prd);
  } catch {
    return false;
  }
  return true;
}
