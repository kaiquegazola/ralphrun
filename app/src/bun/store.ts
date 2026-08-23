// store.ts — what a run IS, while the app is open.
//
// The shape of a live run, the map holding them, and the two ways anything
// finds out something changed: the change bus the screens ride on, and the OS
// notifier. Every other module in this folder reads or writes through here, so
// this one deliberately knows nothing about processes, git or decisions.

import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import type { PRD } from "../../../src/prd.js";
import { loadPrdFile } from "../../../src/prdload.js";
import type { RunSummary, StreamLine, TaskView, TimelineEvent } from "../shared/types.ts";


export const MAX_STREAM_LINES = 800;

export interface LiveTask {
  subphase?: TaskView["subphase"];
  gates?: TaskView["gates"];
  round?: TaskView["round"];
  attempt?: TaskView["attempt"];
  elapsedMs?: number;
  reason?: string;
  lastLineAt?: number;
  /** tree object of the workspace as this task found it — see events.baseline */
  baseline?: string;
  /** and WHERE it was taken: the task's worktree, or the main checkout */
  baselineDir?: string;
  /**
   * The tree as it stood the moment this task stopped and became a decision.
   * Snapshotting then, rather than when the diff is asked for, is what keeps a
   * task the user edits around — or a later run in the same checkout — from
   * showing up as work this task did.
   */
  finalTree?: string;
}

/** A task whose loop is parked on the review gate, waiting for this human. */
export interface PendingGate {
  id: string;
  reason: string;
  canApprove: boolean;
  at: number;
}

export interface RunState {
  summary: RunSummary;
  child: ChildProcess | null;
  /** the user asked for this — tells a SIGTERM exit apart from a crash */
  stopping: boolean;
  live: Map<string, LiveTask>;
  streams: Map<string, StreamLine[]>;
  timeline: TimelineEvent[];
  focusTaskId: string | null;
  /** frozen at exit — a finished run is history, not a view of the live file */
  finalTasks: TaskView[] | null;
  /**
   * Decisions sent down stdin that the child has not acknowledged yet.
   *
   * The child applies them in its own process (the only place that write is
   * safe), but it can also exit before reading one — a run finishing on
   * stop_on_blocked, say. An unacknowledged answer is not a lost one: the exit
   * handler applies whatever is left here, where writing the file is safe again.
   */
  unacked: Map<string, "retry" | "accept">;
  dismissed: Set<string>;
  reviewFeedback: Map<string, string>;
  gates: Map<string, PendingGate>;
  /**
   * Gate answers written to stdin that the child has not acted on yet.
   *
   * An `approve` cannot be applied from here — it needs the loop's own verify,
   * commit and cherry-pick — so if the run dies holding one the honest move is
   * to say so and let the task surface again, not to pretend it landed.
   */
  answeredGates: Set<string>;
  /**
   * Stalled tasks whose restart is waiting for the child to actually die.
   *
   * A SET: a human can answer a second stall before the first exit arrives, and
   * a single slot would drop the earlier one — reset, dismissed, and then
   * nothing rolling it back if the replacement run never starts.
   */
  pendingRestarts: Set<string>;
}

type Listener = (kind: "runs" | "decisions", payload: { runId: string; taskId?: string; line?: StreamLine }) => void;

export const runs = new Map<string, RunState>();
const listeners = new Set<Listener>();

/**
 * Ended runs kept in memory. Each one holds its whole task board and every
 * output line of every task, so a desktop left open for weeks would grow
 * without bound. The summaries survive on disk in `.ralphrun/runs.json`;
 * what is dropped here is the detail view of a run long finished.
 */
const KEEP_ENDED = 50;

export function pruneEnded(): void {
  const ended = [...runs.values()].filter((r) => r.summary.endedAt !== null);
  if (ended.length <= KEEP_ENDED) return;
  ended
    .sort((a, b) => (a.summary.endedAt ?? 0) - (b.summary.endedAt ?? 0))
    .slice(0, ended.length - KEEP_ENDED)
    .forEach((r) => runs.delete(r.summary.id));
}
let seq = 0;

export function onRunChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * OS notifications go through a hook rather than a direct import so this module
 * never pulls in electrobun/main — which is native FFI, and would make the
 * supervisor unloadable anywhere but inside a running app.
 */
type Notifier = (event: "decision" | "merge" | "runEnd", title: string, body: string) => void;
let notifier: Notifier = () => {};
export function setNotifier(n: Notifier): void {
  notifier = n;
}

export function notify(kind: "runs" | "decisions", payload: { runId: string; taskId?: string; line?: StreamLine }): void {
  for (const l of listeners) l(kind, payload);
}

/** Run ids are only unique within a session, so the counter lives with the map. */
export function nextRunId(): string {
  return `run-${++seq}-${Date.now().toString(36)}`;
}

/** Raise an OS notification, if the host installed a notifier. */
export function notifyUser(event: "decision" | "merge" | "runEnd", title: string, body: string): void {
  notifier(event, title, body);
}

export function readPrdOrNull(path: string): PRD | null {
  // keepDoing: the default normalization rewrites `doing` back to `todo` — that
  // is CRASH RECOVERY, and applying it to a live run would make the board show
  // no task in flight and stall detection never fire. Reading is not recovering.
  const res = loadPrdFile(resolve(path), { keepDoing: true });
  return res.ok ? res.prd : (res.prd ?? null);
}

export function countsOf(tasks: TaskView[]): Pick<RunSummary, "total" | "done" | "doing" | "blocked"> {
  return {
    total: tasks.length,
    done: tasks.filter((t) => t.status === "done").length,
    doing: tasks.filter((t) => t.status === "doing").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
  };
}
