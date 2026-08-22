// expand.test.ts — JIT skeleton expansion (patch parsing + advisor round-trip)
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("./advisor.js", () => ({ runAdvisorCli: vi.fn() }));
vi.mock("./log.js", () => ({ log: vi.fn() }));

import { runAdvisorCli } from "./advisor.js";
import { isSkeletonTask, parseTaskPatch, expandSkeletonTask } from "./expand.js";
import type { AgentSpec, Config } from "./config.js";
import type { PRD, Task } from "./prd.js";

const ask = runAdvisorCli as unknown as Mock;

const advis: AgentSpec = { cli: "claude", model: "fable" };
const cfg = { advisor_timeout: 300 } as unknown as Config;
const task = { id: "t07", title: "Family module", deps: [], retries: 0 } as unknown as Task;
const prd = {
  project: "p",
  stack: "bun",
  architecture_notes: "monorepo",
  tasks: [task],
} as unknown as PRD;

beforeEach(() => vi.clearAllMocks());

describe("isSkeletonTask", () => {
  it("skeletal when ANY executable field is missing", () => {
    expect(isSkeletonTask({ id: "a" } as Task)).toBe(true);
    expect(isSkeletonTask({ ...task, description: "d", acceptance: ["x"] } as Task)).toBe(true);
    expect(isSkeletonTask({ ...task, description: "d", acceptance: ["x"], verify: "  " } as Task)).toBe(true);
  });
  it("expanded when description, acceptance and verify are all present", () => {
    expect(isSkeletonTask({ ...task, description: "d", acceptance: ["x"], verify: "bun test" } as Task)).toBe(false);
  });
});

describe("parseTaskPatch", () => {
  const ID = { id: "t07" };
  it("fills only usable fields and drops junk shapes — scope is never an expansion output", () => {
    expect(
      parseTaskPatch(
        {
          ...ID,
          description: "do it",
          acceptance: ["a", 42 as unknown as string],
          scope: ["src/**"], // ignored by design: scoping stays with the planner
          verify: "bun test",
          status: "done", // ignored: never clobbers loop-owned fields
        },
        "t07",
      ),
    ).toEqual({ description: "do it", acceptance: undefined, verify: "bun test" });
  });
  it("binds the reply to the task being expanded — wrong or missing id is refused", () => {
    const spec = { description: "d", verify: "v" };
    expect(parseTaskPatch({ ...spec, id: "OTHER" }, "t07")).toBeNull();
    expect(parseTaskPatch(spec, "t07")).toBeNull(); // no id at all
    expect(parseTaskPatch({ ...spec, id: "t07" }, "t07")).toEqual({ description: "d", verify: "v" });
  });
  it("null for an empty or non-object reply", () => {
    expect(parseTaskPatch({}, "t07")).toBeNull();
    expect(parseTaskPatch("nope", "t07")).toBeNull();
    expect(parseTaskPatch(null, "t07")).toBeNull();
  });
});

describe("expandSkeletonTask", () => {
  it("asks the advisor with a prompt naming the task and merges the fenced reply", async () => {
    ask.mockResolvedValue(['sure:', "```json", JSON.stringify({ id: "t07", description: "full spec", acceptance: ["a"], verify: "bun test apps/family" }), "```"].join("\n"));
    const patch = await expandSkeletonTask(task, prd, advis, cfg, "/w", "progress.md");
    expect(patch).toEqual({ description: "full spec", acceptance: ["a"], verify: "bun test apps/family" });
    const prompt = ask.mock.calls[0][1] as string;
    expect(prompt).toContain('"id": "t07"');
    expect(prompt).toContain("fenced json block");
  });

  it("null (and a log) when the reply holds no usable json — never throws", async () => {
    ask.mockResolvedValue("I could not expand this task.");
    expect(await expandSkeletonTask(task, prd, advis, cfg, "/w", "progress.md")).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

// codex-review regression: an expansion FILLS gaps, never overwrites authored spec
import { applyTaskPatch } from "./expand.js";

describe("applyTaskPatch (fill-only)", () => {
  it("fills the empty fields and keeps everything already authored", () => {
    const t = { id: "t1", description: "authored", acceptance: ["authored"], verify: "" } as unknown as Task;
    applyTaskPatch(t, { description: "AI version", acceptance: [{}, "x"] as never, verify: "bun test" });
    expect(t).toMatchObject({ description: "authored", acceptance: ["authored"], verify: "bun test" });
  });
  it("fills every gap when the task is a bare skeleton", () => {
    const t = { id: "t1", title: "T" } as unknown as Task;
    applyTaskPatch(t, { description: "d", acceptance: ["a"], verify: "v" });
    expect(t).toMatchObject({ description: "d", acceptance: ["a"], verify: "v" });
  });
});
