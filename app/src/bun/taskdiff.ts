// taskdiff.ts — what a task actually changed, as two git trees.
//
// The left tree is the baseline the core published when the task started; the
// right one is a snapshot of the same directory. Comparing trees rather than
// the working copy is what makes NEW files appear, which matters because this
// is the diff a human approves a task by.

import { existsSync } from "node:fs";

import { captureReviewBase, gitOut } from "../../../src/git.js";
import { runs, type RunState } from "./store.ts";
import type { DecisionView } from "../shared/types.ts";

export function diffstatFor(state: RunState, taskId: string): DecisionView["diffstat"] {
  const out = taskNumstat(state, taskId);
  if (out === null) return null;
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of out.split("\n")) {
    const [a, r] = line.split("\t");
    if (a === undefined || r === undefined) continue;
    files++;
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return files === 0 ? null : { files, added, removed };
}

/**
 * A task's work, as two TREES.
 *
 * The left one is the baseline the core published when the task started; the
 * right one is a snapshot of that same directory taken now, through the core's
 * own captureReviewBase. Comparing trees rather than the working copy is what
 * makes NEW files appear — a diff against a tree reports tracked paths only, so
 * a task whose whole contribution is new files would read as having done
 * nothing, in the one place a human is asked to approve it.
 *
 * null when there is nothing honest to show: no baseline was ever published, or
 * the directory it was taken in is gone (a discarded cell). Falling back to the
 * project checkout there would present the USER's own uncommitted changes as
 * this task's work.
 */
function taskTrees(state: RunState, taskId: string): { dir: string; base: string; now: string } | null {
  const live = state.live.get(taskId);
  if (!live?.baseline || !live.baselineDir || !existsSync(live.baselineDir)) return null;
  // the frozen one when this task already stopped; a live snapshot otherwise
  const now = live.finalTree ?? captureReviewBase(live.baselineDir);
  return now ? { dir: live.baselineDir, base: live.baseline, now } : null;
}

/**
 * Pin the tree a task ended on, at the moment it became a decision.
 *
 * A task that ran in the MAIN checkout shares that directory with the user and
 * with every later run. Snapshotting when the diff is requested would fold
 * whatever landed since into the diff the human is judging.
 */
export function freezeTree(state: RunState, taskId: string): void {
  const live = state.live.get(taskId) ?? {};
  if (live.finalTree || !live.baselineDir || !existsSync(live.baselineDir)) return;
  const now = captureReviewBase(live.baselineDir);
  if (!now) return;
  live.finalTree = now;
  state.live.set(taskId, live);
}

/**
 * The loop's OWN files, excluded from every task diff.
 *
 * In the main checkout the baseline is taken after the task was marked `doing`
 * and the final tree after its status changed, so prd.json moves between the
 * two on every single decision. progress.md grows the whole time. Neither is
 * work the executor did, and both would sit at the top of every diff a human is
 * asked to approve.
 */
const BOOKKEEPING = [":(exclude)prd.json", ":(exclude)prd-*.json", ":(exclude)progress.md", ":(exclude).ralphrun"];

function taskNumstat(state: RunState, taskId: string): string | null {
  const t = taskTrees(state, taskId);
  return t ? gitOut(t.dir, "diff", "--numstat", t.base, t.now, "--", ...BOOKKEEPING) : null;
}

export function taskDiff(runId: string, taskId: string): string {
  const state = runs.get(runId);
  if (!state) return "";
  const t = taskTrees(state, taskId);
  return t ? (gitOut(t.dir, "diff", t.base, t.now, "--", ...BOOKKEEPING) ?? "") : "";
}
