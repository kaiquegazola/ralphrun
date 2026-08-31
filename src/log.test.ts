import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendFileSync } from "node:fs";
import { createRawLog, log, setReporter } from "./log.js";

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

  it("can persist a line without forwarding it to the live reporter", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rep = vi.fn();
    setReporter(rep);
    log("p.md", "raw executor output", false);
    expect(mockAppend).toHaveBeenCalledOnce();
    expect(rep).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("can echo a line without persisting it", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("p.md", "live only", false, false);
    expect(mockAppend).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("live only"));
    spy.mockRestore();
  });

  it("bounds raw executor output per call and records what was omitted", () => {
    const raw = createRawLog("p.md", "T1", 52);
    raw.write("12345");
    raw.write("67890");
    raw.write("overflow");
    raw.finish();
    raw.finish();

    expect(mockAppend).toHaveBeenCalledTimes(3);
    expect(mockAppend.mock.calls[0][1]).toContain("T1› 12345");
    expect(mockAppend.mock.calls[1][1]).toContain("T1› 67890");
    expect(mockAppend.mock.calls[2][1]).toContain("raw executor output truncated");
  });

  it("keeps dropped raw lines visible in headless mode", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const raw = createRawLog("p.md", "T1", 52);
    raw.write("12345");
    raw.write("overflow");
    raw.finish();
    expect(spy.mock.calls.some(([line]) => String(line).includes("overflow"))).toBe(true);
    expect(mockAppend.mock.calls.some(([, line]) => String(line).includes("overflow"))).toBe(false);
    spy.mockRestore();
  });
});
