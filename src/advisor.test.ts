// advisor.test.ts — unit tests for getAdvice + advisorReview
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("./adapters.js", () => ({ buildCmd: vi.fn(() => ["bin", "-p", "x"]) }));
vi.mock("./log.js", () => ({ log: vi.fn() }));
vi.mock("./git.js", () => ({ captureDiff: vi.fn() }));
vi.mock("./prompts.js", () => ({
  advisorPrompt: vi.fn(() => "ap"),
  reviewPrompt: vi.fn(() => "rp"),
  parseReview: vi.fn(() => ({ approved: false, changes: "do x" })),
}));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import { log } from "./log.js";
import { captureDiff } from "./git.js";
import { parseReview } from "./prompts.js";
import { getAdvice, advisorReview } from "./advisor.js";
import type { AgentSpec, Config } from "./config.js";
import type { PRD, Task } from "./prd.js";

const spawnMock = spawnSync as unknown as Mock;
const diffMock = captureDiff as unknown as Mock;

const advis: AgentSpec = { cli: "claude", model: "fable" };
const cfg = { advisor_timeout: 300 } as unknown as Config;
const task = { id: "T1", title: "t", acceptance: [] } as unknown as Task;
const prd = { project: "p", stack: "s", architecture_notes: "" } as unknown as PRD;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAdvice", () => {
  it("returns trimmed advice on success and logs char count", () => {
    spawnMock.mockReturnValue({ stdout: "  advice text  " });
    const r = getAdvice(task, prd, advis, cfg, "ws", "prog", "std");
    expect(r).toBe("advice text");
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("→ 11 chars"));
  });

  it("returns null when advice is empty (whitespace only)", () => {
    spawnMock.mockReturnValue({ stdout: "   " });
    expect(getAdvice(task, prd, advis, cfg, "ws", "prog", "std")).toBeNull();
  });

  it("handles missing stdout (?? fallback)", () => {
    spawnMock.mockReturnValue({});
    expect(getAdvice(task, prd, advis, cfg, "ws", "prog", "std")).toBeNull();
  });

  it("returns null and logs failure when spawn throws", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("nope");
    });
    expect(getAdvice(task, prd, advis, cfg, "ws", "prog", "std")).toBeNull();
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("advisor failed"));
  });
});

describe("advisorReview", () => {
  it("approves immediately on empty diff without spawning", () => {
    diffMock.mockReturnValue("   ");
    expect(advisorReview(task, prd, advis, cfg, "ws", "prog", "std")).toEqual({
      approved: true,
      changes: "",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("delegates to parseReview on success", () => {
    diffMock.mockReturnValue("some diff");
    spawnMock.mockReturnValue({ stdout: "CHANGES: x" });
    const r = advisorReview(task, prd, advis, cfg, "ws", "prog", "std");
    expect(parseReview).toHaveBeenCalledWith("CHANGES: x");
    expect(r).toEqual({ approved: false, changes: "do x" });
  });

  it("approves and logs when review CLI throws", () => {
    diffMock.mockReturnValue("some diff");
    spawnMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(advisorReview(task, prd, advis, cfg, "ws", "prog", "std")).toEqual({
      approved: true,
      changes: "",
    });
    expect(log).toHaveBeenCalledWith("prog", expect.stringContaining("review failed"));
  });
});
