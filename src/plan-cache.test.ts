import { describe, expect, it } from "vitest";
import type { AgentSpec } from "./config.js";
import { DEFAULT_ADVISOR_PLAN_THRESHOLD, advisorPlanKey, invalidatePlan, routeAdvisorPlan } from "./plan-cache.js";
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

describe("invalidatePlan", () => {
  // The key is a pure function of the task and the advisor, so a retry of the
  // same task recomputes the SAME key and hits the cache forever. Dropping both
  // fields is the only thing that makes the next attempt re-advise.
  it("removes both the plan and the key that would rematch it", () => {
    const stalled: Task = { ...task, plan: "the plan that stalled", planKey: "grok:reasoner:abc" };
    invalidatePlan(stalled);
    expect("plan" in stalled).toBe(false);
    expect("planKey" in stalled).toBe(false);
  });

  it("is a no-op on a task that never had a plan", () => {
    const fresh: Task = { ...task };
    invalidatePlan(fresh);
    expect(fresh).toEqual(task);
  });
});

describe("routeAdvisorPlan", () => {
  // one criterion, one word, no deps, no scope, and its own objective gate:
  // score 2 — the only shape the default threshold lets through unplanned
  const tiny: Task = { ...task, description: "Rename", acceptance: ["renamed"], verify: "npm test" };

  it("skips the plan only for a task that is small on every measured axis", () => {
    expect(routeAdvisorPlan(tiny).plan).toBe(false);
  });

  it.each([
    ["a second acceptance criterion", { acceptance: ["a", "b"] }],
    ["a dependency", { deps: ["T0"] }],
    ["two declared scope paths", { scope: ["src/a.ts", "src/b.ts"] }],
    ["a long description", { description: "w ".repeat(60) }],
    ["no verify command", { verify: undefined }],
  ])("plans as soon as the task grows %s", (_why, over) => {
    expect(routeAdvisorPlan({ ...tiny, ...over }).plan).toBe(true);
  });

  // Nothing objective will ever contradict an unverified executor, so no
  // threshold — not even an absurd one set by a user chasing cheaper runs — may
  // route such a task past the advisor.
  it("always plans an unverified task, whatever its size or the threshold", () => {
    const empty: Task = { ...task, description: "", acceptance: [], verify: undefined };
    expect(routeAdvisorPlan(empty)).toMatchObject({ plan: true, reason: expect.stringContaining("no verify command") });
    expect(routeAdvisorPlan(empty, 9_999).plan).toBe(true);
  });

  it("does not plan an empty VERIFIED task — there is nothing to plan about", () => {
    const empty: Task = { ...task, description: "", acceptance: [], verify: "npm test" };
    expect(routeAdvisorPlan(empty).plan).toBe(false);
  });

  // the threshold is the one knob, so both extremes have to actually move
  it("honours an overridden threshold in both directions", () => {
    expect(routeAdvisorPlan(tiny, 1).plan).toBe(true);
    expect(routeAdvisorPlan({ ...tiny, acceptance: ["a", "b", "c"], deps: ["T0"] }, 99).plan).toBe(false);
  });

  it("defaults to the exported threshold", () => {
    expect(routeAdvisorPlan(tiny).reason).toContain(`${DEFAULT_ADVISOR_PLAN_THRESHOLD}`);
    expect(routeAdvisorPlan(tiny, DEFAULT_ADVISOR_PLAN_THRESHOLD)).toEqual(routeAdvisorPlan(tiny));
  });

  // a task routed past the advisor and then failing must be diagnosable from
  // progress.md alone, so the reason carries the facts, not just the verdict
  it("reports the arithmetic and every fact behind it", () => {
    const r = routeAdvisorPlan({ ...tiny, deps: ["T0"], scope: ["src/a.ts"] });
    expect(r.reason).toBe("score 4 >= 3 (acceptance:1 deps:1 scope:1 words:1)");
    expect(routeAdvisorPlan(tiny).reason).toBe("score 2 < 3 (acceptance:1 deps:0 scope:0 words:1)");
  });

  it("is pure — it never touches the task", () => {
    const before = structuredClone(tiny);
    routeAdvisorPlan(tiny);
    expect(tiny).toEqual(before);
  });
});
