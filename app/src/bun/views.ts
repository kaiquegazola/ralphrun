// views.ts — the read side. Every screen asks its questions here, and none of
// these answers mutate anything beyond the refresh a live run needs to be
// current.

import { refreshFromDisk } from "./decisions.ts";
import { runs } from "./store.ts";
import type { RunDetailView, RunSummary, StreamLine } from "../shared/types.ts";

// ── reads ──────────────────────────────────────────────────────────────────

export function listRuns(): RunSummary[] {
  return [...runs.values()].map((r) => ({ ...r.summary }));
}

export function activeRuns(): RunSummary[] {
  return listRuns().filter((r) => r.endedAt === null);
}

export function runForPrd(prdPath: string): RunSummary | null {
  return activeRuns().find((r) => r.prdPath === prdPath) ?? null;
}

export function getRunDetail(runId: string): RunDetailView {
  const state = runs.get(runId);
  if (!state) throw new Error(`unknown run ${runId}`);
  const tasks = refreshFromDisk(state).map((t) => {
    const live = state.live.get(t.id);
    return {
      ...t,
      ...live,
      agentCli: state.summary.executor.cli,
    };
  });
  return {
    ...state.summary,
    tasks,
    timeline: state.timeline.slice(-40),
    focusTaskId: state.focusTaskId,
  };
}

export function getStream(runId: string, taskId: string): StreamLine[] {
  return runs.get(runId)?.streams.get(taskId) ?? [];
}
