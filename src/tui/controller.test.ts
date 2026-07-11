// controller.test.ts — pure reducer + selectors, every fold branch.
import { describe, it, expect } from "vitest";
import { t } from "../i18n.js";
import {
  reducer,
  initialState,
  selectProgress,
  selectCurrentTask,
  selectFooterHint,
  type UiState,
} from "./controller.js";

function seeded(): UiState {
  return reducer(initialState, {
    type: "seedTasks",
    tasks: [
      { id: "T1", title: "one", status: "todo" },
      { id: "T2", title: "two", status: "todo" },
    ],
  });
}

describe("seedTasks", () => {
  it("loads tasks and recomputes counts", () => {
    const s = seeded();
    expect(s.tasks).toHaveLength(2);
    expect(s.counts).toEqual({ done: 0, doing: 0, todo: 2, blocked: 0, total: 2 });
  });
});

describe("foldEvent fields", () => {
  it("title updates current + the matching task only", () => {
    const s = reducer(seeded(), { type: "event", event: { taskId: "T1", title: "renamed" } });
    expect(s.current.title).toBe("renamed");
    expect(s.tasks[0].title).toBe("renamed"); // matched
    expect(s.tasks[1].title).toBe("two"); // untouched
  });

  it("subphase / round / attempt / elapsed / timeout land on current", () => {
    const s = reducer(seeded(), {
      type: "event",
      event: {
        taskId: "T1",
        subphase: "executing",
        round: { n: 1, max: 3 },
        attempt: { n: 2, max: 5 },
        elapsedMs: 100,
        timeoutMs: 9000,
      },
    });
    expect(s.current.subphase).toBe("executing");
    expect(s.current.round).toEqual({ n: 1, max: 3 });
    expect(s.current.attempt).toEqual({ n: 2, max: 5 });
    expect(s.current.elapsedMs).toBe(100);
    expect(s.current.timeoutMs).toBe(9000);
  });

  it("gates shallow-merge across events", () => {
    let s = reducer(seeded(), { type: "event", event: { taskId: "T1", gates: { exec: true } } });
    s = reducer(s, { type: "event", event: { taskId: "T1", gates: { tests: false } } });
    expect(s.current.gates).toEqual({ exec: true, tests: false });
  });

  it("lines push and ring-cap at 12", () => {
    let s = seeded();
    for (let i = 0; i < 15; i++) s = reducer(s, { type: "event", event: { taskId: "T1", line: `L${i}` } });
    expect(s.current.lines).toHaveLength(12);
    expect(s.current.lines[0]).toBe("L3");
    expect(s.current.lines[11]).toBe("L14");
  });

  it("lines can include their source label", () => {
    const s = reducer(seeded(), { type: "event", event: { taskId: "T1", line: "fix x", lineSource: "review" } });
    expect(s.current.lines).toEqual(["[review] fix x"]);
  });

  it("empty event leaves state unchanged in fields", () => {
    const s = reducer(seeded(), { type: "event", event: { taskId: "T1" } });
    expect(s.current.subphase).toBe("idle");
    expect(s.current.lines).toEqual([]);
    expect(s.blocked).toEqual([]);
  });
});

describe("foldEvent status", () => {
  it("doing resets the per-task view and marks the task doing", () => {
    // dirty the current view first
    let s = reducer(seeded(), {
      type: "event",
      event: { taskId: "T1", subphase: "fixing", gates: { exec: true }, line: "stale" },
    });
    s = reducer(s, { type: "event", event: { taskId: "T2", title: "two", status: "doing" } });
    expect(s.current.taskId).toBe("T2");
    expect(s.current.subphase).toBe("idle");
    expect(s.current.gates).toEqual({});
    expect(s.current.lines).toEqual([]);
    expect(s.tasks.find((t) => t.id === "T2")!.status).toBe("doing");
    expect(s.counts.doing).toBe(1);
  });

  it("retry maps to todo", () => {
    let s = reducer(seeded(), { type: "event", event: { taskId: "T1", status: "done" } });
    s = reducer(s, { type: "event", event: { taskId: "T1", status: "retry" } });
    expect(s.tasks[0].status).toBe("todo");
    expect(s.counts.done).toBe(0);
    expect(s.counts.todo).toBe(2);
  });

  it("blocked records reason, clears gates+subphase; missing reason defaults to ''", () => {
    let s = reducer(seeded(), { type: "event", event: { taskId: "T1", status: "blocked", reason: "skipped by user" } });
    expect(s.blocked).toEqual([{ id: "T1", reason: "skipped by user" }]);
    expect(s.current.gates).toEqual({});
    expect(s.current.subphase).toBe("idle");
    // reason omitted -> ""
    s = reducer(s, { type: "event", event: { taskId: "T2", status: "blocked" } });
    expect(s.blocked[1]).toEqual({ id: "T2", reason: "" });
    expect(s.counts.blocked).toBe(2);
  });
});

describe("control actions", () => {
  it("pauseToggle flips", () => {
    const s = reducer(seeded(), { type: "pauseToggle" });
    expect(s.paused).toBe(true);
    expect(reducer(s, { type: "pauseToggle" }).paused).toBe(false);
  });

  it("requestSkip → confirm fires skipRequested; consumeSkip clears it", () => {
    let s = reducer(seeded(), { type: "requestSkip" });
    expect(s.pendingConfirm).toBe("skip");
    s = reducer(s, { type: "confirm" });
    expect(s.skipRequested).toBe(true);
    expect(s.quit).toBe(false);
    expect(s.pendingConfirm).toBe(null);
    s = reducer(s, { type: "consumeSkip" });
    expect(s.skipRequested).toBe(false);
  });

  it("requestQuit → confirm fires quit", () => {
    let s = reducer(seeded(), { type: "requestQuit" });
    expect(s.pendingConfirm).toBe("quit");
    s = reducer(s, { type: "confirm" });
    expect(s.quit).toBe(true);
    expect(s.skipRequested).toBe(false);
  });

  it("cancelConfirm clears the pending gate", () => {
    let s = reducer(seeded(), { type: "requestSkip" });
    s = reducer(s, { type: "cancelConfirm" });
    expect(s.pendingConfirm).toBe(null);
    expect(s.skipRequested).toBe(false);
  });

  it("review blocked dialog records the user pick", () => {
    let s = reducer(seeded(), { type: "setReviewBlocked", reason: "review not approved", canApprove: true });
    expect(s.reviewBlocked).toBe(true);
    expect(s.reviewBlockedReason).toBe("review not approved");
    s = reducer(s, { type: "reviewPick", pick: "approve" });
    expect(s.reviewBlocked).toBe(false);
    expect(s.reviewAction).toBe("approve");
  });

  it("tracks stalled and configuration control actions", () => {
    let s = reducer(seeded(), { type: "setStalled" });
    expect(s.stalled).toBe(true);
    s = reducer(s, { type: "stalledPick", pick: "retry" });
    expect(s.stalledAction).toBe("retry");
    s = reducer(s, { type: "requestConfig" });
    expect(s.configRequested).toBe(true);
  });
});

describe("selectors", () => {
  it("selectProgress: 0 when empty, done/total otherwise", () => {
    expect(selectProgress(initialState)).toBe(0);
    let s = seeded();
    s = reducer(s, { type: "event", event: { taskId: "T1", status: "done" } });
    expect(selectProgress(s)).toBe(0.5);
  });

  it("selectCurrentTask: found vs null", () => {
    let s = reducer(seeded(), { type: "event", event: { taskId: "T2", status: "doing" } });
    expect(selectCurrentTask(s)!.id).toBe("T2");
    expect(selectCurrentTask(seeded())).toBe(null); // no current.taskId
  });

  it("selectFooterHint: default / skip / quit", () => {
    expect(selectFooterHint(seeded())).toBe(t("run.footerHint"));
    expect(selectFooterHint(reducer(seeded(), { type: "requestSkip" }))).toBe(t("run.confirmSkip"));
    expect(selectFooterHint(reducer(seeded(), { type: "requestQuit" }))).toBe(t("run.confirmQuit"));
    expect(selectFooterHint(reducer(seeded(), { type: "setReviewBlocked", reason: "x", canApprove: true }))).toBe(
      t("run.footerReviewBlocked", { reason: "x" }),
    );
    expect(selectFooterHint(reducer(seeded(), { type: "setReviewBlocked", reason: "x", canApprove: false }))).toBe(
      t("run.footerReviewBlockedNoApprove", { reason: "x" }),
    );
    expect(selectFooterHint(reducer(seeded(), { type: "setStalled" }))).toBe(t("run.footerStalled"));
    expect(selectFooterHint(reducer(seeded(), { type: "pauseToggle" }))).toBe(t("run.footerPaused"));
  });
});
