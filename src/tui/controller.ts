// controller.ts — PURE reducer + initial state + selectors for the dashboard.
// Folds RunEvents and control actions into UiState. NO Ink/React, NO Date.now:
// elapsed comes from events only, so this is fully deterministic + unit-testable.

import { t } from "../i18n.js";
import type { TaskStatus } from "../prd.js";
import type { RunEvent, Subphase } from "./events.js";

const LINE_CAP = 12;

export interface UiState {
  tasks: { id: string; title: string; status: TaskStatus }[];
  current: {
    taskId?: string;
    title?: string;
    subphase: Subphase;
    round?: { n: number; max: number };
    attempt?: { n: number; max: number };
    gates: { exec?: boolean; tests?: boolean; review?: boolean };
    lines: string[]; // last LINE_CAP executor lines, ring-capped
    elapsedMs?: number;
    timeoutMs?: number;
    taskElapsedMs?: number;
  };
  globalElapsedMs?: number;
  counts: { done: number; doing: number; todo: number; blocked: number; total: number };
  blocked: { id: string; reason: string }[];
  paused: boolean;
  pendingConfirm: null | "skip" | "quit";
  skipRequested: boolean; // consume-once flag polled by loop via handle.control.takeSkip()
  quit: boolean;
  stalled: boolean;
  stalledAction: "retry" | "quit" | null;
  reviewBlocked: boolean;
  reviewBlockedReason: string;
  reviewCanApprove: boolean;
  reviewAction: "retry" | "approve" | "block" | "quit" | null;
  configRequested: boolean;
}

export type Action =
  | { type: "seedTasks"; tasks: { id: string; title: string; status: TaskStatus }[] }
  | { type: "event"; event: RunEvent }
  | { type: "pauseToggle" }
  | { type: "requestSkip" }
  | { type: "requestQuit" }
  | { type: "confirm" }
  | { type: "cancelConfirm" }
  | { type: "consumeSkip" }
  | { type: "setStalled" }
  | { type: "stalledPick"; pick: "retry" | "quit" }
  | { type: "setReviewBlocked"; reason: string; canApprove: boolean }
  | { type: "reviewPick"; pick: "retry" | "approve" | "block" | "quit" }
  | { type: "requestConfig" };

export const initialState: UiState = {
  tasks: [],
  current: { subphase: "idle", gates: {}, lines: [] },
  counts: { done: 0, doing: 0, todo: 0, blocked: 0, total: 0 },
  blocked: [],
  paused: false,
  pendingConfirm: null,
  skipRequested: false,
  quit: false,
  stalled: false,
  stalledAction: null,
  reviewBlocked: false,
  reviewBlockedReason: "",
  reviewCanApprove: false,
  reviewAction: null,
  configRequested: false,
};

function countOf(tasks: UiState["tasks"]): UiState["counts"] {
  const counts = { done: 0, doing: 0, todo: 0, blocked: 0, total: tasks.length };
  for (const t of tasks) counts[t.status]++;
  return counts;
}

function foldEvent(state: UiState, e: RunEvent): UiState {
  let current = { ...state.current };
  let tasks = state.tasks;
  let blocked = state.blocked;
  let globalElapsedMs = state.globalElapsedMs;

  // status "doing" = task transition: wipe the per-task view so lines/gates from
  // the previous task don't bleed into the next one.
  if (e.status === "doing") {
    current = { taskId: e.taskId, subphase: "idle", gates: {}, lines: [] };
  }

  if (e.title !== undefined) {
    current.title = e.title;
    tasks = tasks.map((t) => (t.id === e.taskId ? { ...t, title: e.title! } : t));
  }
  if (e.subphase !== undefined) current.subphase = e.subphase;
  if (e.round !== undefined) current.round = e.round;
  if (e.attempt !== undefined) current.attempt = e.attempt;
  if (e.gates !== undefined) current.gates = { ...current.gates, ...e.gates };
  if (e.line !== undefined) current.lines = [...current.lines, formatLine(e.line, e.lineSource)].slice(-LINE_CAP);
  if (e.elapsedMs !== undefined) current.elapsedMs = e.elapsedMs;
  if (e.timeoutMs !== undefined) current.timeoutMs = e.timeoutMs;
  if (e.taskElapsedMs !== undefined) current.taskElapsedMs = e.taskElapsedMs;
  if (e.globalElapsedMs !== undefined) globalElapsedMs = e.globalElapsedMs;

  if (e.status !== undefined) {
    const mapped: TaskStatus = e.status === "retry" ? "todo" : e.status;
    tasks = tasks.map((t) => (t.id === e.taskId ? { ...t, status: mapped } : t));
    if (e.status === "blocked") {
      blocked = [...blocked, { id: e.taskId, reason: e.reason ?? "" }];
      current.gates = {};
      current.subphase = "idle";
    }
  }

  return { ...state, current, tasks, blocked, globalElapsedMs, counts: countOf(tasks) };
}

function formatLine(line: string, source?: RunEvent["lineSource"]): string {
  if (!source) return line;
  return `[${source}] ${line}`;
}

export function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "seedTasks": {
      const tasks = action.tasks.map((t) => ({ ...t }));
      return { ...state, tasks, counts: countOf(tasks) };
    }
    case "event":
      return foldEvent(state, action.event);
    case "pauseToggle":
      return { ...state, paused: !state.paused };
    case "requestSkip":
      return { ...state, pendingConfirm: "skip" };
    case "requestQuit":
      return { ...state, pendingConfirm: "quit" };
    case "confirm": {
      const fire = state.pendingConfirm;
      return {
        ...state,
        pendingConfirm: null,
        skipRequested: fire === "skip" ? true : state.skipRequested,
        quit: fire === "quit" ? true : state.quit,
      };
    }
    case "cancelConfirm":
      return { ...state, pendingConfirm: null };
    case "consumeSkip":
      return { ...state, skipRequested: false };
    case "setStalled":
      return { ...state, stalled: true, stalledAction: null };
    case "stalledPick":
      return { ...state, stalled: false, stalledAction: action.pick };
    case "setReviewBlocked":
      return {
        ...state,
        reviewBlocked: true,
        reviewBlockedReason: action.reason,
        reviewCanApprove: action.canApprove,
        reviewAction: null,
      };
    case "reviewPick":
      return { ...state, reviewBlocked: false, reviewAction: action.pick };
    case "requestConfig":
      return { ...state, configRequested: true };
  }
}

// selectors
export function selectProgress(s: UiState): number {
  return s.counts.total === 0 ? 0 : s.counts.done / s.counts.total;
}

export function selectCurrentTask(s: UiState): UiState["tasks"][number] | null {
  return s.tasks.find((t) => t.id === s.current.taskId) ?? null;
}

export function selectFooterHint(s: UiState): string {
  if (s.reviewBlocked) {
    return t(s.reviewCanApprove ? "run.footerReviewBlocked" : "run.footerReviewBlockedNoApprove", {
      reason: s.reviewBlockedReason,
    });
  }
  if (s.stalled) return t("run.footerStalled");
  if (s.pendingConfirm === "skip") return t("run.confirmSkip");
  if (s.pendingConfirm === "quit") return t("run.confirmQuit");
  if (s.paused) return t("run.footerPaused");
  return t("run.footerHint");
}
