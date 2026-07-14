import { describe, expect, it } from "vitest";
import type { AgentSpec } from "./config.js";
import { advisorPlanKey } from "./plan-cache.js";
import type { PRD, Task } from "./prd.js";

const task: Task = {
  id: "T1",
  title: "Title",
  status: "todo",
  deps: [],
  retries: 0,
  description: "Description",
  acceptance: ["Acceptance"],
};
const prd: PRD = { project: "Project", stack: "Node", architecture_notes: "ESM", tasks: [task] };
const advisor: AgentSpec = { cli: "grok", model: "reasoner" };

describe("advisorPlanKey", () => {
  it("is deterministic and records the advisor identity plus a SHA-256 prompt hash", () => {
    const key = advisorPlanKey(task, prd, advisor, "standards");
    expect(key).toMatch(/^grok:reasoner:[0-9a-f]{64}$/);
    expect(advisorPlanKey(task, prd, advisor, "standards")).toBe(key);
  });

  it("changes for advisor, task, project prompt inputs, or standards changes", () => {
    const original = advisorPlanKey(task, prd, advisor, "standards");
    const variants = [
      advisorPlanKey(task, prd, { ...advisor, cli: "codex" }, "standards"),
      advisorPlanKey(task, prd, { ...advisor, model: "other" }, "standards"),
      advisorPlanKey({ ...task, title: "Changed" }, prd, advisor, "standards"),
      advisorPlanKey({ ...task, description: "Changed" }, prd, advisor, "standards"),
      advisorPlanKey({ ...task, acceptance: ["Changed"] }, prd, advisor, "standards"),
      advisorPlanKey(task, { ...prd, stack: "TypeScript" }, advisor, "standards"),
      advisorPlanKey(task, { ...prd, architecture_notes: "Changed" }, advisor, "standards"),
      advisorPlanKey(task, prd, advisor, "changed standards"),
    ];
    expect(new Set(variants)).not.toContain(original);
  });
});
