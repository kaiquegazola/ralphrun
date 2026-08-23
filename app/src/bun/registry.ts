// registry.ts — folder facts the screens need (git? which branch? empty?),
// on top of the core's project registry. The LIST itself lives in the core
// (src/projectreg.ts) because `ralphrun create .` writes the same file.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { gitOut } from "../../../src/git.js";

export {
  addProject,
  findProject as getProject,
  listProjects,
  projectId,
  projectsPath as registryPath,
  removeProject,
  type ProjectRecord,
} from "../../../src/projectreg.js";

/** `~/dev/x` instead of `/Users/me/dev/x` — the mockups show the tilde form. */
export function shortenDir(dir: string): string {
  const home = homedir();
  // the BOUNDARY matters: /Users/mega merely shares a prefix with /Users/me and
  // would otherwise be shown as "~ga"
  if (dir === home) return "~";
  return dir.startsWith(home + sep) ? "~" + dir.slice(home.length) : dir;
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export function currentBranch(dir: string): string | null {
  if (!isGitRepo(dir)) return null;
  return gitOut(dir, "rev-parse", "--abbrev-ref", "HEAD");
}

export function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).filter((f) => f !== ".DS_Store").length === 0;
  } catch {
    return false;
  }
}

export function detectPackageManager(dir: string): string | null {
  for (const [file, pm] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["Cargo.toml", "cargo"],
    ["go.mod", "go"],
    ["pyproject.toml", "uv/pip"],
  ] as const) {
    if (existsSync(join(dir, file))) return pm;
  }
  return null;
}
