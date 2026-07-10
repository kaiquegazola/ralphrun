import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendFileSync } from "node:fs";
import { log, setReporter } from "./log.js";

vi.mock("node:fs", () => ({ appendFileSync: vi.fn() }));

const mockAppend = vi.mocked(appendFileSync);

describe("log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setReporter(null);
    vi.useRealTimers();
  });

  it("writes a [HH:MM:SS] timestamped line to console + file", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 9, 4, 5, 6)); // 04:05:06 local
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("progress.md", "hello");
    expect(spy).toHaveBeenCalledWith("- [04:05:06] hello");
    expect(mockAppend).toHaveBeenCalledWith("progress.md", "- [04:05:06] hello\n");
    spy.mockRestore();
  });

  it("routes to reporter instead of console when set, then restores", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rep = vi.fn();
    setReporter(rep);
    log("p.md", "via reporter");
    expect(rep).toHaveBeenCalledTimes(1);
    expect(rep.mock.calls[0][0]).toMatch(/^- \[\d\d:\d\d:\d\d\] via reporter$/);
    expect(spy).not.toHaveBeenCalled();

    setReporter(null);
    log("p.md", "via console");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rep).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
