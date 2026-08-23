// gitpaths.ts — where a task's work physically lives. Split out of
// worktrees.ts so the run supervisor can ask the same question without the two
// modules importing each other.

import { basename, join } from "node:path";

import { gitOut } from "../../../src/git.js";
import { taskWorktreeName } from "../../../src/worktree.js";

/**
 * What to diff a task's worktree AGAINST.
 *
 * Not `HEAD`: a worktree is checked out detached, and the executor is allowed
 * to commit inside it — once it does, `git diff HEAD` is empty and the inbox
 * would ask a human to approve a task while showing no work at all. The
 * merge-base with the trunk is the commit the cell was cut from, so diffing
 * against it shows everything the task produced, committed or not.
 */
export function worktreeBase(workspace: string, dir: string): string {
  const head = gitOut(dir, "rev-parse", "HEAD");
  const base = head ? gitOut(workspace, "merge-base", "HEAD", head) : null;
  return base ?? "HEAD";
}

/** git speaks POSIX paths on every platform; the rest of node does not. */
const slash = (p: string): string => p.replace(/\\/g, "/");

/** Paths git itself reports for this repo's ralphrun worktrees, minus the main checkout. */
export function listWorktreePaths(workspace: string): string[] {
  const out = gitOut(workspace, "worktree", "list", "--porcelain");
  if (!out) return [];
  // The exact directory the core creates cells in — a substring match would
  // also claim an unrelated `.ralphrun-old/` worktree and hand its diff to a
  // task. Compared with separators normalised: git prints POSIX paths even on
  // Windows, where join() would build a backslash prefix that never matches.
  const home = slash(join(workspace, ".ralphrun", "worktrees")) + "/";
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter((p) => slash(p) !== slash(workspace) && slash(p).startsWith(home));
}

/**
 * The worktree a task is running in, resolved through git instead of rebuilt
 * from the id. The core sanitizes an id into a directory name (and appends a
 * digest when it had to), so recomputing that rule here would be a second copy
 * of it — one free to drift.
 */
export function worktreeDirFor(workspace: string, taskId: string): string | null {
  // THE core's rule, imported rather than re-derived: the naming is injective
  // on purpose (an id that survives sanitizing keeps its name, one that does
  // not carries THIS id's digest, so a leftover cell from "foo:bar" is never
  // handed to "foo/bar"), and a second copy of it here drifts the moment the
  // core adds a case — which is exactly what happened with "." and "..".
  const expected = taskWorktreeName(taskId);
  return listWorktreePaths(workspace).find((p) => basename(p) === expected) ?? null;
}
