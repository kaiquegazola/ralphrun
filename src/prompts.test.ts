// prompts.test.ts — cover build/advisor/inject/review/parse + read/standards
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  readStandards,
  buildPrompt,
  advisorPrompt,
  injectAdvice,
  reviewPrompt,
  parseReview,
} from "./prompts.js";
import type { PRD, Task } from "./prd.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const task: Task = {
  id: "T1",
  title: "Do a thing",
  status: "todo",
  deps: [],
  retries: 0,
  description: "desc",
  acceptance: ["a1", "a2"],
};
const prd: PRD = {
  project: "Proj",
  stack: "TS",
  architecture_notes: "notes",
  tasks: [task],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readStandards", () => {
  it("returns joined blocks for files that exist, truncated to 6000", () => {
    vi.mocked(existsSync).mockImplementation((f) => String(f).endsWith("CLAUDE.md"));
    vi.mocked(readFileSync).mockReturnValue("X".repeat(7000) as unknown as string);
    const out = readStandards("/ws");
    expect(out).toContain("### CLAUDE.md");
    expect(out).not.toContain("### AGENTS.md");
    // 6000-char slice
    expect(out.length).toBeLessThan(6100);
    expect(existsSync).toHaveBeenCalledWith("/ws/CLAUDE.md");
  });

  it("returns empty string when nothing exists", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(readStandards("/ws")).toBe("");
  });

  it("joins both files", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("body" as unknown as string);
    const out = readStandards("/ws");
    expect(out).toContain("### CLAUDE.md");
    expect(out).toContain("### AGENTS.md");
    expect(out).toContain("\n\n");
  });
});

describe("buildPrompt", () => {
  it("includes standards block when standards present", () => {
    const out = buildPrompt(task, prd, "STD");
    expect(out).toContain("Project standards");
    expect(out).toContain("STD");
    expect(out).toContain("T1 — Do a thing");
    expect(out).toContain("- a1");
  });
  it("omits standards block when empty (default arg)", () => {
    const out = buildPrompt(task, prd);
    expect(out).not.toContain("Project standards");
  });
  it("appends the browser guide only when the task's verify uses dev-browser", () => {
    expect(buildPrompt(task, prd)).not.toContain("Browser validation");
    const browserTask: Task = { ...task, verify: "npm run build && dev-browser --headless < e2e.mjs" };
    const out = buildPrompt(browserTask, { ...prd, tasks: [browserTask] });
    expect(out).toContain("Browser validation");
    expect(out).toContain("dev-browser --help");
  });
});

describe("advisorPrompt", () => {
  it("renders with and without standards", () => {
    expect(advisorPrompt(task, prd, "STD")).toContain("Project standards");
    expect(advisorPrompt(task, prd)).not.toContain("Project standards");
    expect(advisorPrompt(task, prd)).toContain("a1; a2");
  });
});

describe("injectAdvice", () => {
  it("appends advice section", () => {
    const out = injectAdvice("BASE", "ADV");
    expect(out).toContain("BASE");
    expect(out).toContain("Advisor guidance");
    expect(out).toContain("ADV");
  });
});

describe("reviewPrompt", () => {
  it("includes diff and acceptance", () => {
    const out = reviewPrompt(task, prd, "STD", "the diff");
    expect(out).toContain("the diff");
    expect(out).toContain("- a1");
    expect(out).toContain("Project standards");
  });
});

describe("parseReview", () => {
  it("empty verdict -> approved", () => {
    expect(parseReview("")).toEqual({ approved: true, changes: "" });
  });
  it("APPROVE -> approved", () => {
    expect(parseReview("  approve  ")).toEqual({ approved: true, changes: "" });
  });
  it("CHANGES with colon -> not approved with trimmed changes", () => {
    const r = parseReview("CHANGES: fix x\nfix y");
    expect(r.approved).toBe(false);
    expect(r.changes).toBe("fix x\nfix y");
  });
  it("colon-in-changes keeps only first colon boundary", () => {
    const r = parseReview("CHANGES: do a:b thing");
    expect(r.approved).toBe(false);
    expect(r.changes).toBe("do a:b thing");
  });
  it("CHANGES without colon -> empty changes", () => {
    const r = parseReview("CHANGES no colon here");
    expect(r.approved).toBe(false);
    expect(r.changes).toBe("");
  });
  it("truncates changes to 4000", () => {
    const r = parseReview("CHANGES: " + "z".repeat(5000));
    expect(r.changes.length).toBe(4000);
  });
  it("no APPROVE / no CHANGES -> approved default", () => {
    expect(parseReview("looks fine to me")).toEqual({ approved: true, changes: "" });
  });
});
