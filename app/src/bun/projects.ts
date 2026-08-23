// projects.ts — view assembly for the two project screens (4a list, 4b open).
// The registry stores three fields; everything else on those screens is read
// live off the folder, so a repo someone switched branches in from a terminal
// is never stale here.

import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { git, gitOut } from "../../../src/git.js";
import {
  addProject,
  currentBranch,
  detectPackageManager,
  getProject,
  isEmptyDir,
  isGitRepo,
  listProjects as listRecords,
  shortenDir,
} from "./registry.ts";
import { findPrdFiles, toPrdView } from "./prds.ts";
import { activeRuns, readHistory, runForPrd } from "./runs.ts";
import { drafts } from "./studio.ts";
import type { NewProjectProbe, PrdView, ProjectView, RunSummary } from "../shared/types.ts";

export function projectView(id: string): ProjectView | null {
  const rec = getProject(id);
  if (!rec) return null;
  const prds = findPrdFiles(rec.dir);
  const runs = activeRuns().filter((r) => r.projectId === id);
  const draftCount = drafts().filter((d) => d.projectId === id).length;
  return {
    id: rec.id,
    name: rec.name,
    dir: rec.dir,
    shortDir: shortenDir(rec.dir),
    git: isGitRepo(rec.dir),
    branch: currentBranch(rec.dir),
    prdCount: prds.length,
    draftCount,
    runs,
  };
}

export function listProjectViews(): ProjectView[] {
  return listRecords()
    .map((r) => projectView(r.id))
    .filter((p): p is ProjectView => p !== null);
}

export function projectDetail(id: string): { project: ProjectView; prds: PrdView[]; history: RunSummary[] } {
  const project = projectView(id);
  if (!project) throw new Error(`unknown project ${id}`);
  const prds = findPrdFiles(project.dir)
    .map((path) => toPrdView(id, path, runForPrd(path)?.id ?? null))
    .filter((p): p is PrdView => p !== null);
  return { project, prds, history: readHistory(project.dir).slice(0, 6) };
}

/** `git worktree` exists from 2.5 on. */
export function supportsWorktrees(version: string | null): boolean {
  if (!version) return false;
  const [major, minor] = version.split(".").map((n) => Number.parseInt(n, 10));
  if (!Number.isInteger(major)) return false;
  return major > 2 || (major === 2 && (minor ?? 0) >= 5);
}

export function probeDir(dir: string): NewProjectProbe {
  const path = resolve(dir.replace(/^~/, process.env.HOME ?? "~"));
  const exists = existsSync(path);
  const gitVersion = (gitOut(exists ? path : process.cwd(), "--version") ?? "").replace("git version ", "") || null;
  return {
    dir: path,
    exists,
    empty: exists ? isEmptyDir(path) : true,
    git: exists && isGitRepo(path),
    branch: exists ? currentBranch(path) : null,
    packageManager: exists ? detectPackageManager(path) : null,
    gitVersion,
    // `git worktree` landed in 2.5 — comparing only the major would promise it
    // on a 2.4 that cannot deliver, and the project would be configured for a
    // parallelism its git refuses.
    worktreesSupported: supportsWorktrees(gitVersion),
    name: basename(path),
  };
}

/**
 * Register a folder as a project, creating and `git init`-ing it when asked.
 * A repo is not required to plan — but it IS required to run with worktrees,
 * so an empty folder gets initialised rather than silently losing parallelism.
 */
export function createProject(dir: string, name: string | undefined, init: boolean): string {
  const path = resolve(dir.replace(/^~/, process.env.HOME ?? "~"));
  mkdirSync(path, { recursive: true });
  // A registered project that is not a repo cannot do worktrees, cherry-picks
  // or per-task commits — the whole loop. Refusing beats listing a project
  // that quietly cannot do what the screen just promised.
  if (init && !isGitRepo(path) && git(path, "init") !== 0) {
    throw new Error(`git init falhou em ${path} — confira se o git está instalado e se a pasta é gravável`);
  }
  return addProject(path, name).id;
}
