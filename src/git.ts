// git.ts — git helper (silent; auto-inits, stages, commits, diffs)

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAX_REVIEW_DIFF_CHARS = 12_000;

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

export function git(workspace: string, ...args: string[]): void {
  spawnSync("git", args, { cwd: workspace, stdio: "ignore" });
}

export function headCommit(workspace: string): string | null {
  if (!existsSync(workspace + "/.git")) return null;
  const out = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).stdout;
  const hash = out?.trim();
  return hash || null;
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
    return (stat + "\n\n" + full).slice(0, MAX_REVIEW_DIFF_CHARS);
  });
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
