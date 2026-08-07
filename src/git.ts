// git.ts — git helper (silent; auto-inits, stages, commits, diffs)

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAX_REVIEW_DIFF_CHARS = 12_000;

// A silently cut diff reads as a whole one: the reviewer approves what it never
// saw and reports full confidence. Saying so costs a line and is the difference
// between a partial review and a wrong one.
const DIFF_TRUNCATED_NOTE =
  `\n\n[TRUNCATED at ${MAX_REVIEW_DIFF_CHARS} characters — this is a PARTIAL view of the change. ` +
  "Judge only what is shown above; do NOT treat the omitted part as reviewed.]";

// Lockfiles are often large and ordered before source files. They do not help an
// acceptance review, but can otherwise consume the complete prompt budget.
const REVIEW_DIFF_PATHSPEC = [
  "--",
  ".",
  ":(exclude)prd.json",
  ":(exclude)progress.md",
  ":(exclude)ralph.config.json",
  ":(exclude)package-lock.json",
  ":(exclude)npm-shrinkwrap.json",
  ":(exclude)yarn.lock",
  ":(exclude)pnpm-lock.yaml",
  ":(exclude)bun.lock",
  ":(exclude)bun.lockb",
];

export function git(workspace: string, ...args: string[]): number | null {
  return spawnSync("git", args, { cwd: workspace, stdio: "ignore" }).status;
}

/**
 * Same, with the pathspec on stdin. A task can touch more files than an argv
 * holds, and NUL separation is the only form safe for every filename.
 */
function gitWithPathspec(workspace: string, paths: string[], ...args: string[]): number | null {
  return spawnSync("git", [...args, "--pathspec-from-file=-", "--pathspec-file-nul"], {
    cwd: workspace,
    input: paths.map((p) => p + "\0").join(""),
    stdio: ["pipe", "ignore", "ignore"],
  }).status;
}

/** Same as `git`, but for the commands whose ANSWER is their stdout. Empty = null. */
export function gitOut(workspace: string, ...args: string[]): string | null {
  const out = spawnSync("git", args, { cwd: workspace, encoding: "utf8" }).stdout;
  return out?.trim() || null;
}

export function headCommit(workspace: string): string | null {
  // a linked worktree's .git is a FILE, not a directory — existsSync covers both
  if (!existsSync(workspace + "/.git")) return null;
  return gitOut(workspace, "rev-parse", "--verify", "HEAD");
}

// A tree object snapshots the worktree in a private Git index. Comparing later
// reviews to it covers executor-created commits and excludes changes that were
// already present when the task began without staging the user's files.
export function captureReviewBase(workspace: string): string | null {
  if (!existsSync(workspace + "/.git")) return null;
  return withTemporaryIndex(workspace, (index) => {
    stageWorktree(workspace, index);
    const out = runWithIndex(workspace, index, ["write-tree"]).stdout;
    const tree = out?.trim();
    return tree || null;
  });
}

export function captureDiff(workspace: string, base?: string | null): string {
  if (!existsSync(workspace + "/.git")) return "";
  return withTemporaryIndex(workspace, (index) => {
    stageWorktree(workspace, index);
    const baseArgs = base ? [base] : [];
    const stat = runWithIndex(workspace, index, ["diff", "--cached", "--stat", ...baseArgs, ...REVIEW_DIFF_PATHSPEC]).stdout;
    const full = runWithIndex(workspace, index, ["diff", "--cached", ...baseArgs, ...REVIEW_DIFF_PATHSPEC]).stdout;
    const body = stat + "\n\n" + full;
    return body.length <= MAX_REVIEW_DIFF_CHARS ? body : body.slice(0, MAX_REVIEW_DIFF_CHARS) + DIFF_TRUNCATED_NOTE;
  });
}

/**
 * Every path that differs from `base` — the task's OWN footprint, which is what
 * separates its work from whatever the user already had dirty when it started.
 *
 * `null` means "cannot be computed" (no repo, no base, git failed); a caller
 * must read that as "no scoping possible", never as "nothing changed".
 *
 * --no-renames on purpose: rename detection reports only the new path, so the
 * old path's deletion would never make it into the commit.
 */
export function taskChangedPaths(workspace: string, base?: string | null): string[] | null {
  if (!base || !existsSync(workspace + "/.git")) return null;
  return withTemporaryIndex(workspace, (index) => {
    stageWorktree(workspace, index);
    const res = runWithIndex(workspace, index, ["diff", "--cached", "--name-only", "--no-renames", "-z", base, "--", "."]);
    if (res.status !== 0 || typeof res.stdout !== "string") return null;
    return res.stdout.split("\0").filter((p) => p !== "");
  });
}

/**
 * Stage and commit ONLY `paths`. Whatever the user had uncommitted when the task
 * began is not in that list, so it stays in the worktree instead of being
 * swallowed by a commit labelled with this task's name.
 *
 * false = the scoped STAGE failed, so the caller can fall back to an unscoped
 * one. It fails when a path is in neither the worktree nor the index — only
 * reachable if the executor staged a rename or deletion itself, which the task
 * prompt tells it not to do.
 *
 * true is NOT "a commit exists": git refuses a commit of its own accord (a
 * pre-commit hook, an unset identity, an unusable signing key, or a path list
 * whose content the executor already committed itself). Reporting that as a
 * stage failure would send the caller into `git add -A`, which sweeps the user's
 * unrelated work into a commit named after this task — so the commit's own
 * outcome is left to the caller, which reads it off HEAD (see logTaskCommit).
 */
export function commitPaths(workspace: string, paths: string[], message: string): boolean {
  // -A so a path the task DELETED still stages as a removal
  if (gitWithPathspec(workspace, paths, "add", "-A") !== 0) return false;
  // scoped again on commit: a path the USER staged before the run must not ride
  // along just because it was sitting in the index
  gitWithPathspec(workspace, paths, "commit", "-m", message);
  return true;
}

function withTemporaryIndex<T>(workspace: string, fn: (index: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ralphrun-index-"));
  const index = join(dir, "index");
  try {
    // No HEAD is normal in a freshly initialized repository.
    runWithIndex(workspace, index, ["read-tree", "HEAD"]);
    return fn(index);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stageWorktree(workspace: string, index: string): void {
  runWithIndex(workspace, index, ["add", "-A"]);
}

function runWithIndex(workspace: string, index: string, args: string[]) {
  return spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, GIT_INDEX_FILE: index },
  });
}
