import { describe, expect, it } from "vitest";
import { createElapsedTracker } from "./elapsed.js";

describe("createElapsedTracker", () => {
  it("records pause transitions that happen entirely between display ticks", () => {
    let nowMs = 0;
    const now = (): number => nowMs;
    const tracker = createElapsedTracker(now());
    tracker.startTask(now());

    nowMs = 100;
    tracker.setPaused(true, now());
    nowMs = 400;
    tracker.setPaused(false, now());
    nowMs = 1_000;

    expect(tracker.stopTask(now())).toBe(700);
    expect(tracker.tick("T1", false, now())).toEqual({ taskId: "T1", globalElapsedMs: 700 });
  });

  it("takes the final paused interval into account when a task stops before another tick", () => {
    let nowMs = 0;
    const now = (): number => nowMs;
    const tracker = createElapsedTracker(now());
    tracker.startTask(now());

    nowMs = 250;
    tracker.setPaused(true, now());
    nowMs = 1_000;

    expect(tracker.stopTask(now())).toBe(250);
  });

  it("subtracts real pause intervals globally and per task, then resets at the next task", () => {
    const tracker = createElapsedTracker(1_000);
    expect(tracker.tick("", false, 2_000)).toEqual({ taskId: "", globalElapsedMs: 1_000 });

    tracker.startTask(2_000);
    expect(tracker.tick("T1", false, 3_000)).toEqual({ taskId: "T1", globalElapsedMs: 2_000, taskElapsedMs: 1_000 });
    expect(tracker.tick("T1", true, 3_500)).toEqual({ taskId: "T1" });
    expect(tracker.tick("T1", true, 8_750)).toEqual({ taskId: "T1" });
    expect(tracker.tick("T1", false, 9_000)).toEqual({ taskId: "T1", globalElapsedMs: 2_500, taskElapsedMs: 1_500 });
    expect(tracker.stopTask(10_000)).toBe(2_500);
    expect(tracker.tick("T1", false, 11_000)).toEqual({ taskId: "T1", globalElapsedMs: 4_500 });

    tracker.startTask(12_000);
    expect(tracker.tick("T2", false, 12_400)).toEqual({ taskId: "T2", globalElapsedMs: 5_900, taskElapsedMs: 400 });
  });

  it("counts a configuration/remount gap as paused even without ticker delivery", () => {
    const tracker = createElapsedTracker(0);
    tracker.setPaused(true, 1_000);
    tracker.setPaused(true, 4_000);
    tracker.startTask(4_000);
    expect(tracker.tick("T1", true, 5_000)).toEqual({ taskId: "T1" });
    tracker.setPaused(false, 6_000);
    expect(tracker.tick("T1", false, 7_000)).toEqual({ taskId: "T1", globalElapsedMs: 2_000, taskElapsedMs: 1_000 });

    tracker.setPaused(true, 8_000);
    expect(tracker.stopTask(10_000)).toBe(2_000);
    tracker.setPaused(false, 12_000);
    expect(tracker.tick("T1", false, 13_000)).toEqual({ taskId: "T1", globalElapsedMs: 4_000 });
  });
});
