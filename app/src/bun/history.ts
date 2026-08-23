// history.ts — runs that already happened, kept next to the backlog they ran.
//
// The project screen and the home feed both show finished runs, and the app is
// not the process that outlives them, so this is the only part of a run that is
// written to disk.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getProject } from "./registry.ts";
import type { RunState } from "./store.ts";
import type { RunSummary } from "../shared/types.ts";

// ── history ────────────────────────────────────────────────────────────────
// Finished runs outlive the process because the project screen shows them.
// A flat append next to the PRD, in the directory the loop already writes
// progress.md into.

function historyPath(projectDir: string): string {
  return join(projectDir, ".ralphrun", "runs.json");
}

export function appendHistory(state: RunState): void {
  const project = getProject(state.summary.projectId);
  if (!project) return;
  try {
    const path = historyPath(project.dir);
    // a run that died in preflight never got as far as the core creating
    // .ralphrun, and losing its record is exactly when the user wants it
    mkdirSync(dirname(path), { recursive: true });
    const prev: RunSummary[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    prev.unshift({ ...state.summary });
    // atomic: killed mid-write, a truncated runs.json reads as EMPTY on the
    // next load and every earlier run disappears with it
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(prev.slice(0, 50), null, 2) + "\n");
    renameSync(tmp, path);
  } catch {
    // history is a nicety; a run must never fail because it could not be logged
  }
}

export function readHistory(projectDir: string): RunSummary[] {
  try {
    const path = historyPath(projectDir);
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as RunSummary[]) : [];
  } catch {
    return [];
  }
}
