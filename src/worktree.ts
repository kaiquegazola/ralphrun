// worktree.ts — a disposable git worktree per task, and the cherry-pick that
// brings its work back into the main workspace.
//
// The point is READ isolation, not write isolation. Two tasks with no
// dependency between them and overlapping `scope` are already refused at load
// (overlappingScopePairs), so executors do not write the same file. But a
// `verify` command shells `tsc` / `npm test` with cwd set to the workspace, and
// those read the WHOLE project — a task's gate would observe files it never
// asked about even with disjoint scopes. Do not "optimize" the worktree away
// for tasks whose scopes do not overlap; the scopes are not what it is for.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { git, gitOut, headCommit } from "./git.js";

const WORKTREES = join(".ralphrun", "worktrees");

export type MergeBackStatus = "ok" | "conflict" | "dirty" | "nothing";

/**
 * A detached worktree at HEAD, or `null` when isolation is not available: no
 * repository, or a repository with no commit yet (prepareRun inits one).
 *
 * `null` means "run this task in the main workspace" — it must never be scored
 * as a task failure, which would burn the task's retry budget on a problem the
 * task cannot fix.
 */
export function createTaskWorktree(workspace: string, taskId: string, links: string[]): string | null {
  const base = headCommit(workspace);
  if (!base) return null;
  const dir = worktreePath(workspace, taskId);
  try {
    excludeRalphrunDir(workspace);
    // a leftover directory or a stale administrative entry both make `add` refuse
    rmSync(dir, { recursive: true, force: true });
    git(workspace, "worktree", "prune");
    if (git(workspace, "worktree", "add", "--detach", dir, base) !== 0) return null;
    for (const name of links) {
      // A fresh worktree holds TRACKED files only, so node_modules is absent and
      // `verify: "npm test"` fails on every task before anything interesting is
      // exercised. ponytail: one shared node_modules, so a verify that runs
      // `npm install` mutates every sibling's dependencies — and in a WAVE two
      // installs at once corrupt the real tree in the main workspace, which no
      // worktree discard can roll back (that is why the reviewer is refused an
      // install at all, see reviewexec.ts). Per-worktree installs cost minutes
      // per task; add them when a backlog genuinely needs a verify that installs.
      const src = join(workspace, name);
      if (existsSync(src) && !existsSync(join(dir, name))) symlinkSync(src, join(dir, name));
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * Cherry-pick `base..worktreeHead` into the main workspace.
 *
 * A RANGE, not a single sha: executors commit on their own (loop.ts logs when
 * they do) and a single-sha pick would silently drop those commits. An EMPTY
 * range is not a no-op to git — `cherry-pick a..a` exits 128 — hence the guard.
 *
 * This survives a dirty trunk on purpose: ralphrun is built to run on one (it
 * is the whole reason captureReviewBase exists), so a clean-tree precondition
 * would disable the feature for the common case.
 */
export function mergeBackTaskWork(
  workspace: string,
  dir: string,
  base: string | null,
): { status: MergeBackStatus; head: string | null } {
  const head = headCommit(dir);
  if (!base || !head || head === base) return { status: "nothing", head };
  if (git(workspace, "cherry-pick", `${base}..${head}`) === 0) return { status: "ok", head };
  // Two very different failures, and which one it is decides retry vs block.
  // A pick that STARTED and hit a textual conflict leaves CHERRY_PICK_HEAD
  // behind: work landed first, and a retry cut from the new HEAD can win. One
  // git refused outright — the user has that file uncommitted, so applying it
  // would overwrite their work — never gets that far, and no number of retries
  // moves their edit out of the way.
  //
  // NOT the abort's exit status: a RANGE pick writes .git/sequencer either way,
  // so `--abort` returns 0 for both (verified on git 2.50).
  const started = !!gitOut(workspace, "rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD");
  git(workspace, "cherry-pick", "--abort");
  return { status: started ? "conflict" : "dirty", head };
}

/**
 * What removing this worktree would throw away. Discarding a cell is the
 * rollback the serial loop never had, but it must not be silent: a commit
 * survives in the shared object database and is recoverable by sha, while
 * whatever the executor left uncommitted does not survive the removal.
 */
export function worktreeLoss(dir: string, base: string | null): { head: string | null; dirty: boolean } {
  const head = headCommit(dir);
  return { head: head && head !== base ? head : null, dirty: !!gitOut(dir, "status", "--porcelain") };
}

/**
 * --force because the executor leaves build output behind and the symlinks make
 * the tree look dirty. The removal unlinks a symlink rather than following it,
 * so the real node_modules is untouched — worth a test, because getting that
 * wrong deletes the user's dependencies.
 */
export function removeTaskWorktree(workspace: string, dir: string): void {
  git(workspace, "worktree", "remove", "--force", dir);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * At boot no ralphrun worktree can legitimately be live, so a leftover one is a
 * crash's litter and recovery needs no state file. This is the exact sibling of
 * normalizePrd resetting a stuck `doing` task, one layer down. It runs even
 * when worktree_per_task is off this run, so turning the feature off after a
 * crash still cleans up.
 *
 * ponytail: assumes one loop per workspace — two concurrent loops on the same
 * prd.json would reap each other's live worktrees. Already broken today for
 * other reasons; add a lock if that ever becomes a real workflow.
 */
export function reapOrphanWorktrees(workspace: string): number {
  const marker = sep + WORKTREES + sep;
  let n = 0;
  for (const line of gitOut(workspace, "worktree", "list", "--porcelain")?.split("\n") ?? []) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.slice("worktree ".length);
    // path match rather than realpath comparison: a repo checked out under a
    // symlinked temp dir reports its real path, and a user's own worktree
    // elsewhere is not ours to delete.
    if (!dir.includes(marker)) continue;
    removeTaskWorktree(workspace, dir);
    n += 1;
  }
  // `remove --force` handles a directory that still exists, `prune` handles an
  // administrative entry whose directory is already gone. Both crash shapes.
  if (n > 0) git(workspace, "worktree", "prune");
  return n;
}

/** Derived from the id, so crash recovery needs no bookkeeping file. */
function worktreePath(workspace: string, taskId: string): string {
  // a task id is free text in prd.json; keep it inside the directory we own
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  // Sanitizing is many-to-one — "api:get" and "api/get" are two distinct tasks
  // that both fold to "api_get" — and `add` starts by DELETING whatever sits at
  // the path, so in a wave the second task would reap the first one's live cell.
  // The digest makes the mapping injective again while staying derived.
  const dir = safe === taskId ? safe : `${safe}-${createHash("sha1").update(taskId).digest("hex").slice(0, 8)}`;
  return join(workspace, WORKTREES, dir);
}

/**
 * Repo-local, so the user's tracked .gitignore is never touched. Load-bearing,
 * not cosmetic: without it the temporary-index `git add -A` inside
 * captureReviewBase / taskChangedPaths sweeps the worktree directories into the
 * trunk's own baseline and commits.
 */
function excludeRalphrunDir(workspace: string): void {
  // createTaskWorktree already read a commit out of this repository before
  // calling, so rev-parse cannot come back empty — and if it somehow did, the
  // throw lands in that same caller's catch and the task degrades to the main
  // workspace, which is exactly what a silent ".git" guess would have hidden.
  const common = gitOut(workspace, "rev-parse", "--git-common-dir")!;
  const info = join(isAbsolute(common) ? common : resolve(workspace, common), "info");
  const file = join(info, "exclude");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur.split("\n").includes(".ralphrun/")) return;
  mkdirSync(info, { recursive: true });
  appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + ".ralphrun/\n");
}
