// git.ts — git helper (silent; auto-inits, stages, commits, diffs)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { PathLike } from "node:fs";

export function git(workspace: string, ...args: string[]): void {
  spawnSync("git", args, { cwd: workspace, stdio: "ignore" });
}

export function captureDiff(workspace: string): string {
  if (!existsSync(workspace + "/.git")) return "";
  git(workspace, "add", "-A");
  const stat = spawnSync("git", ["diff", "--cached", "--stat"], {
    cwd: workspace,
    encoding: "utf8",
  }).stdout;
  const full = spawnSync("git", ["diff", "--cached"], {
    cwd: workspace,
    encoding: "utf8",
  }).stdout;
  return (stat + "\n\n" + full).slice(0, 12000);
}