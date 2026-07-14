// elapsed.ts — monotonic elapsed accounting with pause intervals removed.

import type { RunEvent } from "./tui/events.js";

export type ElapsedRunEvent = Pick<RunEvent, "taskId"> &
  Partial<Pick<RunEvent, "globalElapsedMs" | "taskElapsedMs">>;

export interface ElapsedTracker {
  setPaused(paused: boolean, nowMs: number): void;
  startTask(nowMs: number): void;
  stopTask(nowMs: number): number;
  tick(taskId: string, paused: boolean, nowMs: number): ElapsedRunEvent;
}

export function createElapsedTracker(globalStartMs: number): ElapsedTracker {
  let globalPausedMs = 0;
  let globalPauseStartMs: number | null = null;
  let taskStartMs = globalStartMs;
  let taskPausedMs = 0;
  let taskPauseStartMs: number | null = null;
  let taskRunning = false;

  const setPaused = (paused: boolean, nowMs: number): void => {
    if (paused) {
      if (globalPauseStartMs === null) globalPauseStartMs = nowMs;
      if (taskRunning && taskPauseStartMs === null) taskPauseStartMs = nowMs;
      return;
    }
    if (globalPauseStartMs !== null) {
      globalPausedMs += nowMs - globalPauseStartMs;
      globalPauseStartMs = null;
    }
    if (taskPauseStartMs !== null) {
      taskPausedMs += nowMs - taskPauseStartMs;
      taskPauseStartMs = null;
    }
  };

  return {
    setPaused,
    startTask(nowMs) {
      taskStartMs = nowMs;
      taskPausedMs = 0;
      taskRunning = true;
      taskPauseStartMs = globalPauseStartMs === null ? null : nowMs;
    },
    stopTask(nowMs) {
      if (taskPauseStartMs !== null) {
        taskPausedMs += nowMs - taskPauseStartMs;
        taskPauseStartMs = null;
      }
      taskRunning = false;
      return nowMs - taskStartMs - taskPausedMs;
    },
    tick(taskId, paused, nowMs) {
      setPaused(paused, nowMs);
      const payload: ElapsedRunEvent = { taskId };
      if (!paused) {
        payload.globalElapsedMs = nowMs - globalStartMs - globalPausedMs;
        if (taskRunning) payload.taskElapsedMs = nowMs - taskStartMs - taskPausedMs;
      }
      return payload;
    },
  };
}
