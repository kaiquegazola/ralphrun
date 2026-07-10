// verify.test.ts — runVerify gate + assembleFeedback
import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { log } from "./log.js";
import { runVerify, assembleFeedback } from "./verify.js";
import type { Task } from "./prd.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("./log.js", () => ({ log: vi.fn() }));

const mockSpawn = vi.mocked(spawnSync);
const mockLog = vi.mocked(log);

function task(over: Partial<Task> = {}): Task {
  return {
    id: "T1",
    title: "t",
    status: "todo",
    deps: [],
    retries: 0,
    description: "",
    acceptance: [],
    ...over,
  };
}

describe("runVerify", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes with no verify cmd", () => {
    expect(runVerify(task(), "/ws", "p.md")).toEqual({ passed: true, output: "" });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("passes on exit 0", () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: "ok", stderr: "" } as never);
    expect(runVerify(task({ verify: "make test" }), "/ws", "p.md")).toEqual({ passed: true, output: "ok" });
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("handles null stdout/stderr via nullish coalescing", () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: null, stderr: null } as never);
    expect(runVerify(task({ verify: "x" }), "/ws", "p.md")).toEqual({ passed: true, output: "" });
  });

  it("fails on non-zero exit and logs", () => {
    mockSpawn.mockReturnValue({ status: 2, stdout: "boom", stderr: "err" } as never);
    const r = runVerify(task({ verify: "x" }), "/ws", "p.md");
    expect(r.passed).toBe(false);
    expect(r.output).toBe("boomerr");
    expect(mockLog).toHaveBeenCalledWith("p.md", expect.stringContaining("verify FAILED (exit 2)"));
  });

  it("catches Error throw", () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("nope");
    });
    const r = runVerify(task({ verify: "x" }), "/ws", "p.md");
    expect(r.passed).toBe(false);
    expect(mockLog).toHaveBeenCalledWith("p.md", expect.stringContaining("nope"));
  });

  it("catches non-Error throw", () => {
    mockSpawn.mockImplementation(() => {
      throw "kaboom";
    });
    const r = runVerify(task({ verify: "x" }), "/ws", "p.md");
    expect(r.passed).toBe(false);
    expect(r.output).toBe("kaboom");
    expect(mockLog).toHaveBeenCalledWith("p.md", expect.stringContaining("kaboom"));
  });
});

describe("assembleFeedback", () => {
  it("empty when all good", () => {
    expect(assembleFeedback(true, true, "out", true, "")).toBe("");
  });

  it("exec non-zero part", () => {
    expect(assembleFeedback(false, true, "", true, "")).toContain("exited non-zero");
  });

  it("test failing part", () => {
    const r = assembleFeedback(true, false, "tOUT", true, "");
    expect(r).toContain("Tests are failing");
    expect(r).toContain("tOUT");
  });

  it("reviewer changes part", () => {
    expect(assembleFeedback(true, true, "", false, "fix this")).toContain("fix this");
  });

  it("skips reviewer part when approved", () => {
    expect(assembleFeedback(true, true, "", true, "ignored")).toBe("");
  });

  it("skips reviewer part when no changes text", () => {
    expect(assembleFeedback(true, true, "", false, "")).toBe("");
  });

  it("joins all parts", () => {
    const r = assembleFeedback(false, false, "T", false, "C");
    expect(r).toContain("exited non-zero");
    expect(r).toContain("Tests are failing");
    expect(r).toContain("C");
    expect(r.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });
});
