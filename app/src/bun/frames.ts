// frames.ts — the child's NDJSON, folded into run state.
//
// One frame kind per thing a run can say: an event from the core's own bus, a
// captured log line, a review gate opening, a decision the run acted on, and
// the exit. Nothing here decides anything; it records what happened.

import { dismissedBacklog, refreshFromDisk } from "./decisions.ts";
import { MAX_STREAM_LINES, notify, notifyUser, type RunState } from "./store.ts";
import { freezeTree } from "./taskdiff.ts";
import type { StreamLine, TaskView } from "../shared/types.ts";

// ── frame folding ──────────────────────────────────────────────────────────

export function pushLine(state: RunState, taskId: string, line: StreamLine): void {
  // "" is the RUN's own stream. It cannot collide with a task, because a task
  // id is validated non-empty at intake — a named key like "run" could, since
  // ids are free text.
  const key = taskId;
  const arr = state.streams.get(key) ?? [];
  arr.push(line);
  if (arr.length > MAX_STREAM_LINES) arr.splice(0, arr.length - MAX_STREAM_LINES);
  state.streams.set(key, arr);
  // The stall clock only moves for the AGENT's own output. The core emits a
  // system heartbeat while an executor is silent, and letting that count as
  // life would mean a task that never says anything can never look stalled —
  // which is the exact case the inbox exists to catch.
  if (line.source !== "system") {
    const live = state.live.get(key) ?? {};
    live.lastLineAt = line.at;
    state.live.set(key, live);
  }
  notify("runs", { runId: state.summary.id, taskId: key, line });
}

export function handleFrame(state: RunState, raw: string): void {
  let frame: { t: string; e?: Record<string, unknown>; line?: string; code?: number; error?: string };
  try {
    frame = JSON.parse(raw);
  } catch {
    pushLine(state, state.focusTaskId ?? "", { at: Date.now(), text: raw, source: "system" });
    return;
  }

  if (frame.t === "log") {
    pushLine(state, state.focusTaskId ?? "", { at: Date.now(), text: frame.line ?? "", source: "system" });
    return;
  }
  if (frame.t === "exit") {
    if (frame.error) pushLine(state, "", { at: Date.now(), text: frame.error, source: "system" });
    return;
  }
  if (frame.t === "decided") {
    const d = frame as unknown as { taskId: string; ok?: boolean };
    if (d.ok) {
      state.unacked.delete(d.taskId);
      return;
    }
    // The child could not apply it — the PRD changed or stopped parsing between
    // the decision being shown and answered. Leaving `unacked` set means the
    // exit fallback tries again; undismissing puts the task back in the inbox
    // so the human is not told it was handled when it was not.
    state.dismissed.delete(`${state.summary.id}:${d.taskId}`);
    pushLine(state, d.taskId, {
      at: Date.now(),
      text: `a run não conseguiu aplicar a decisão em ${d.taskId} — o PRD mudou?`,
      source: "system",
    });
    notify("decisions", { runId: state.summary.id });
    return;
  }
  if (frame.t === "gate") {
    // the loop is parked on this task until resolveDecision answers — that is
    // what makes "aceitar" actually commit instead of marking a discarded cell
    const g = frame as unknown as { id: string; taskId: string; reason: string; canApprove: boolean };
    freezeTree(state, g.taskId);
    state.gates.set(g.taskId, { id: g.id, reason: g.reason, canApprove: g.canApprove, at: Date.now() });
    state.summary.status = "attention";
    notifyUser("decision", `${state.summary.projectName} · ${g.taskId} aguarda você`, g.reason);
    notify("runs", { runId: state.summary.id });
    notify("decisions", { runId: state.summary.id });
    return;
  }
  if (frame.t !== "ev" || !frame.e) return;

  const e = frame.e as {
    taskId: string;
    line?: string;
    lineSource?: StreamLine["source"];
    status?: TaskView["status"];
    subphase?: TaskView["subphase"];
    gates?: TaskView["gates"];
    round?: TaskView["round"];
    attempt?: TaskView["attempt"];
    elapsedMs?: number;
    reason?: string;
    title?: string;
    baseline?: string;
    baselineDir?: string;
  };

  const live = state.live.get(e.taskId) ?? {};
  if (e.subphase) live.subphase = e.subphase;
  if (e.gates) live.gates = { ...live.gates, ...e.gates };
  if (e.round) live.round = e.round;
  if (e.attempt) live.attempt = e.attempt;
  if (typeof e.elapsedMs === "number") live.elapsedMs = e.elapsedMs;
  if (e.baseline) live.baseline = e.baseline;
  if (e.baselineDir) live.baselineDir = e.baselineDir;
  if (e.reason) live.reason = e.reason;
  state.live.set(e.taskId, live);

  if (e.line) {
    if (e.lineSource === "review" || e.lineSource === "advisor") {
      // the reviewer's words are the whole content of a review-blocked
      // decision — keep the last one per task so the inbox can show it.
      state.reviewFeedback.set(e.taskId, e.line);
    }
    pushLine(state, e.taskId, { at: Date.now(), text: e.line, source: e.lineSource ?? "executor" });
  }

  if (e.status) {
    // Leaving `blocked` ENDS the decision that was dismissed. A task that
    // blocks again is a new decision and has to be asked again — a permanent
    // dismissal would retire the task from the inbox after one answer.
    state.answeredGates.delete(e.taskId); // the loop acted on it
    if (e.status !== "blocked") {
      state.dismissed.delete(`${state.summary.id}:${e.taskId}`);
      dismissedBacklog.delete(`${state.summary.prdPath}:${e.taskId}`);
    }

    if (e.status === "doing") {
      state.focusTaskId = e.taskId;
      // the stall clock starts when the task STARTS. An executor that produces
      // no output at all is exactly the case worth escalating, and keying only
      // off output lines would leave it invisible forever.
      if (live.lastLineAt === undefined) {
        live.lastLineAt = Date.now();
        state.live.set(e.taskId, live);
      }
      state.timeline.push({ at: Date.now(), taskId: e.taskId, kind: "start", label: `${e.taskId} start` });
    } else if (e.status === "done") {
      state.timeline.push({ at: Date.now(), taskId: e.taskId, kind: "merge", label: `${e.taskId} ✓ merge` });
      notifyUser("merge", `${e.taskId} voltou ao trunk`, `${state.summary.projectName} · ${state.summary.prdName}`);
    } else if (e.status === "blocked") {
      freezeTree(state, e.taskId);
      state.timeline.push({ at: Date.now(), taskId: e.taskId, kind: "blocked", label: `${e.taskId} blocked` });
      notify("decisions", { runId: state.summary.id });
    }
    refreshFromDisk(state);
    notify("runs", { runId: state.summary.id });
  }

  if (e.gates?.tests === false) {
    state.timeline.push({ at: Date.now(), taskId: e.taskId, kind: "fail", label: `${e.taskId} tests ✗` });
  }
}
