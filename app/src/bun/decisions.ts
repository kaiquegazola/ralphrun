// decisions.ts — everything waiting on a human, and the board state it is read
// from.
//
// Two sources: the runs this session is supervising, and the BACKLOG itself —
// a task left blocked in prd.json outlives the process that blocked it, and
// after a restart the inbox is the only way back to it.

import { resolve } from "node:path";

import { loadAppSettings } from "./appsettings.ts";
import { findPrdFiles, prdName, toTaskViews, waveCount } from "./prds.ts";
import { listProjects } from "./registry.ts";
import { countsOf, notify, notifyUser, readPrdOrNull, runs, type RunState } from "./store.ts";
import { diffstatFor } from "./taskdiff.ts";
import type { DecisionView, TaskView } from "../shared/types.ts";

/** Refresh the counters and the wave off the PRD file the child keeps writing. */
export function refreshFromDisk(state: RunState): TaskView[] {
  // A run that ended keeps the board it ended with. Re-reading prd.json would
  // let a LATER run (or an inbox retry) rewrite the finished one's tasks,
  // counters and decisions after the fact.
  if (state.finalTasks) return state.finalTasks;
  const prd = readPrdOrNull(state.summary.prdPath);
  if (!prd) return [];
  const tasks = toTaskViews(prd);
  const s = state.summary;
  Object.assign(s, countsOf(tasks));
  s.waveCount = waveCount(tasks);
  const pending = tasks.filter((t) => t.status !== "done");
  s.wave = pending.length === 0 ? s.waveCount : Math.min(...pending.map((t) => t.wave)) + 1;
  if (s.status === "running" && decisionsOf(state, tasks).length > 0) s.status = "attention";
  else if (s.status === "attention" && decisionsOf(state, tasks).length === 0) s.status = "running";
  return tasks;
}

// ── decisions ──────────────────────────────────────────────────────────────

export function decisionsOf(state: RunState, tasks: TaskView[]): DecisionView[] {
  const stallMs = loadAppSettings().stallMinutes * 60_000;
  const now = Date.now();
  const out: DecisionView[] = [];

  for (const t of tasks) {
    const key = `${state.summary.id}:${t.id}`;
    if (state.dismissed.has(key)) continue;
    const live = state.live.get(t.id);

    // A PARKED task first: its loop is holding the cell open for this answer,
    // so this is the decision that can still change the outcome. The status on
    // disk is whatever it was before the gate — do not read it as blocked.
    const gate = state.gates.get(t.id);
    if (gate) {
      out.push({
        id: key,
        runId: state.summary.id,
        projectId: state.summary.projectId,
        prdPath: state.summary.prdPath,
        taskId: t.id,
        projectName: state.summary.projectName,
        prdName: state.summary.prdName,
        taskTitle: t.title,
        kind: "review-blocked",
        reason: gate.reason,
        feedback: state.reviewFeedback.get(t.id) ?? null,
        since: gate.at,
        diffstat: diffstatFor(state, t.id),
        canAccept: gate.canApprove,
      });
      continue;
    }

    if (t.status === "blocked") {
      const reason = live?.reason ?? "";
      out.push({
        id: key,
        runId: state.summary.id,
        projectId: state.summary.projectId,
        prdPath: state.summary.prdPath,
        taskId: t.id,
        projectName: state.summary.projectName,
        prdName: state.summary.prdName,
        taskTitle: t.title,
        kind: reason.toLowerCase().includes("review") ? "review-blocked" : "blocked",
        reason: reason || "blocked",
        feedback: state.reviewFeedback.get(t.id) ?? null,
        since: live?.lastLineAt ?? state.summary.startedAt,
        diffstat: diffstatFor(state, t.id),
        canAccept: false,
      });
      continue;
    }

    if (
      t.status === "doing" &&
      stallMs > 0 &&
      state.summary.endedAt === null &&
      live?.lastLineAt !== undefined &&
      now - live.lastLineAt > stallMs
    ) {
      out.push({
        id: key,
        runId: state.summary.id,
        projectId: state.summary.projectId,
        prdPath: state.summary.prdPath,
        taskId: t.id,
        projectName: state.summary.projectName,
        prdName: state.summary.prdName,
        taskTitle: t.title,
        kind: "stall",
        reason: `sem output há ${Math.round((now - live.lastLineAt) / 60_000)} min`,
        feedback: null,
        since: live.lastLineAt,
        diffstat: diffstatFor(state, t.id),
        canAccept: false,
      });
    }
  }
  return out;
}

/**
 * Every decision waiting on this human, from two places.
 *
 * The live runs are the obvious one. The other is the BACKLOG: a task left
 * blocked in prd.json outlives the process that blocked it, and after an app
 * restart it would otherwise be invisible — with no way to retry or skip it
 * short of editing JSON by hand. Those carry no runId; resolveDecision answers
 * them by writing the file and starting a fresh run.
 */
export function listDecisions(): DecisionView[] {
  const live = [...runs.values()].flatMap((state) => decisionsOf(state, refreshFromDisk(state)));
  const covered = new Set(live.map((d) => `${d.prdPath}:${d.taskId}`));
  return [...live, ...backlogDecisions(covered)];
}

/**
 * Is this decision still true on disk?
 *
 * A frozen board outlives its run: a LATER run can finish the very task an old
 * inbox item still shows as blocked, and answering it then would reset finished
 * work back to todo. The file is the authority for anything not live.
 */
export function decisionStillStands(prdPath: string, taskId: string): boolean {
  const prd = readPrdOrNull(prdPath);
  const task = prd?.tasks?.find((t) => t.id === taskId);
  return task?.status === "blocked" || task?.status === "doing";
}

function backlogDecisions(covered: Set<string>): DecisionView[] {
  const out: DecisionView[] = [];
  for (const project of listProjects()) {
    for (const prdPath of findPrdFiles(project.dir)) {
      const prd = readPrdOrNull(prdPath);
      if (!prd) continue;
      for (const task of prd.tasks) {
        if (task.status !== "blocked") continue;
        const key = `${resolve(prdPath)}:${task.id}`;
        if (covered.has(key) || dismissedBacklog.has(key)) continue;
        out.push({
          id: key,
          runId: null,
          projectId: project.id,
          prdPath: resolve(prdPath),
          taskId: task.id,
          projectName: project.name,
          prdName: prdName(prdPath, prd),
          taskTitle: task.title,
          kind: "blocked",
          reason: "bloqueada numa run anterior",
          feedback: null,
          since: 0,
          diffstat: null,
          canAccept: false,
        });
      }
    }
  }
  return out;
}

/** Skipped backlog decisions, for this session — the file keeps the status. */
export const dismissedBacklog = new Set<string>();

/**
 * A stall is the ABSENCE of events, so nothing pushes it. Everything else in
 * this module is event-driven; this one condition needs a clock, or a task that
 * went quiet would only surface when the user happened to navigate.
 *
 * Cheap and self-silencing: it does nothing while no run is live, and it
 * notifies only when the set of decisions actually changes.
 */
let lastDecisionKeys = new Set<string>();
setInterval(() => {
  if (![...runs.values()].some((r) => r.child !== null)) return;
  const current = listDecisions();
  const keys = new Set(current.map((d) => d.id));
  if (keys.size === lastDecisionKeys.size && [...keys].every((k) => lastDecisionKeys.has(k))) return;
  // an OS notification for each NEW one: a stall is discovered by this clock
  // and by nothing else, and the window is usually behind something.
  for (const d of current) {
    if (lastDecisionKeys.has(d.id)) continue;
    notifyUser("decision", `${d.projectName} · ${d.taskId} aguarda você`, d.reason);
  }
  lastDecisionKeys = keys;
  notify("decisions", { runId: "" });
}, 30_000).unref?.();
