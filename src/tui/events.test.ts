// events.test.ts — the tiny typed bus: subscribe, emit, unsubscribe, clear.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { on, emit, clear } from "./events.js";

beforeEach(() => clear());

describe("events bus", () => {
  it("delivers emitted events to every listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    on(a);
    on(b);
    emit({ taskId: "T1", line: "hi" });
    expect(a).toHaveBeenCalledWith({ taskId: "T1", line: "hi" });
    expect(b).toHaveBeenCalledWith({ taskId: "T1", line: "hi" });
  });

  it("unsubscribe stops delivery (and a second unsubscribe is a no-op)", () => {
    const a = vi.fn();
    const off = on(a);
    off(); // i >= 0 branch: removed
    off(); // i < 0 branch: already gone, no throw
    emit({ taskId: "T1" });
    expect(a).not.toHaveBeenCalled();
  });

  it("clear() drops all listeners", () => {
    const a = vi.fn();
    on(a);
    clear();
    emit({ taskId: "T1" });
    expect(a).not.toHaveBeenCalled();
  });
});
