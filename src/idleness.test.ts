// idleness.test.ts — the shared escalating-silence watchdog
import { describe, it, expect, vi, beforeEach } from "vitest";

import { startIdleLadder } from "./idleness.js";

beforeEach(() => vi.clearAllMocks());

describe("startIdleLadder", () => {
  it("warns on every non-lethal rung with the accumulated minutes", () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const fatal = vi.fn();
      startIdleLadder({ stepMs: 60_000, steps: 3, warn, fatal });
      vi.advanceTimersByTime(60_000);
      expect(warn).toHaveBeenNthCalledWith(1, 1);
      vi.advanceTimersByTime(60_000);
      expect(warn).toHaveBeenNthCalledWith(2, 2);
      expect(fatal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the last rung is lethal, and only it", () => {
    vi.useFakeTimers();
    try {
      const fatal = vi.fn();
      startIdleLadder({ stepMs: 60_000, steps: 4, warn: vi.fn(), fatal });
      vi.advanceTimersByTime(180_000);
      expect(fatal).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(fatal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a bump resets to rung zero — continuous silence is what accumulates", () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const fatal = vi.fn();
      const ladder = startIdleLadder({ stepMs: 60_000, steps: 2, warn, fatal });
      vi.advanceTimersByTime(59_000);
      ladder.bump(); // a line arrived just before the rung fired
      vi.advanceTimersByTime(59_000);
      expect(warn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000); // full step since the bump
      expect(warn).toHaveBeenCalledWith(1);
      // and the ladder keeps climbing from the reset point: one more full step is lethal
      vi.advanceTimersByTime(60_000);
      expect(fatal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop silences the current rung for good", () => {
    vi.useFakeTimers();
    try {
      const fatal = vi.fn();
      const ladder = startIdleLadder({ stepMs: 60_000, steps: 1, warn: vi.fn(), fatal });
      ladder.stop();
      vi.advanceTimersByTime(600_000);
      expect(fatal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
