// validatePrd.test.ts — every shape / uniqueness / dep-reference branch.
import { describe, it, expect } from "vitest";
import { validatePrd } from "./validatePrd.js";

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T1",
    title: "t",
    status: "todo",
    deps: [],
    retries: 0,
    description: "d",
    acceptance: [],
    scope: [],
    verify: "npm test",
    ...over,
  };
}

function prd(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { project: "p", stack: "s", architecture_notes: "a", tasks: [task()], ...over };
}

it("accepts a valid PRD (deps referencing existing ids)", () => {
  const p = prd({ tasks: [task({ id: "A" }), task({ id: "B", deps: ["A"] })] });
  expect(validatePrd(p)).toEqual({ ok: true, errors: [] });
});

it("rejects a non-object top level", () => {
  expect(validatePrd(null).ok).toBe(false);
  expect(validatePrd("nope").ok).toBe(false);
});

it("rejects wrong top-level field types", () => {
  const r = validatePrd(prd({ project: 1, stack: 2, architecture_notes: 3 }));
  expect(r.ok).toBe(false);
  expect(r.errors).toEqual(
    expect.arrayContaining([
      "project must be a string",
      "stack must be a string",
      "architecture_notes must be a string",
    ]),
  );
});

it("rejects tasks that is not an array (and returns early)", () => {
  const r = validatePrd(prd({ tasks: {} }));
  expect(r).toEqual({ ok: false, errors: ["tasks must be an array"] });
});

it("rejects an empty task list", () => {
  const r = validatePrd(prd({ tasks: [] }));
  expect(r.ok).toBe(false);
  expect(r.errors).toContain("prd must have at least one task");
});

it("rejects a non-object task entry", () => {
  const r = validatePrd(prd({ tasks: [42] }));
  expect(r.errors).toContain("task[0] must be an object");
});

it("rejects a null task entry", () => {
  const r = validatePrd(prd({ tasks: [null] }));
  expect(r.errors).toContain("task[0] must be an object");
});

it("rejects a task with a non-string id", () => {
  const r = validatePrd(prd({ tasks: [task({ id: 5 })] }));
  expect(r.errors).toContain("task[0].id must be a string");
});

it("rejects duplicate task ids", () => {
  const r = validatePrd(prd({ tasks: [task({ id: "X" }), task({ id: "X" })] }));
  expect(r.errors).toContain("duplicate task id: X");
});

it("rejects bad per-task field types in one shot", () => {
  const r = validatePrd(
    prd({
      tasks: [task({ title: 1, status: "weird", retries: "no", description: 2, acceptance: {}, deps: {} })],
    }),
  );
  expect(r.errors).toEqual(
    expect.arrayContaining([
      "task[0].title must be a string",
      "task[0].status invalid",
      "task[0].retries must be a number",
      "task[0].description must be a string",
      "task[0].acceptance must be an array",
      "task[0].deps must be an array",
    ]),
  );
});

it("rejects non-string acceptance items", () => {
  const r = validatePrd(prd({ tasks: [task({ acceptance: [1, 2] })] }));
  expect(r.errors).toContain("task[0].acceptance items must be strings");
});

it("rejects a non-string verify", () => {
  const r = validatePrd(prd({ tasks: [task({ verify: 42 })] }));
  expect(r.errors).toContain("task[0].verify must be a string");
  expect(validatePrd(prd({ tasks: [task({ verify: "npm test" })] })).ok).toBe(true);
});

// the shim is the AUTHORING view: a PRD coming out of the planner or the studio
// must not ship a task whose gate can never fail. The load path stays lenient —
// prdload.test.ts covers that side.
it("rejects a task with no verify on the authoring path", () => {
  for (const missing of [undefined, "", "   "]) {
    const r = validatePrd(prd({ tasks: [task({ verify: missing })] }));
    expect(r.errors).toContain("task[0].verify is required — a task with no verify command is never verified");
  }
  // callers can still opt back out explicitly (the shim only sets the default)
  expect(validatePrd(prd({ tasks: [task({ verify: undefined })] }), { requireVerify: false }).ok).toBe(true);
});

it("rejects a scope that is not an array of strings (omitted stays allowed)", () => {
  expect(validatePrd(prd({ tasks: [task({ scope: "src/" })] })).errors).toContain("task[0].scope must be an array");
  expect(validatePrd(prd({ tasks: [task({ scope: ["src/a.ts", 7] })] })).errors).toContain(
    "task[0].scope items must be strings",
  );
  expect(validatePrd(prd({ tasks: [task({ scope: undefined })] })).ok).toBe(true);
  expect(validatePrd(prd({ tasks: [task({ scope: ["src/**", "README.md"] })] })).ok).toBe(true);
});

// two tasks the graph does not order can run at the same time, so declaring the
// same files in both is a merge conflict the plan can refuse up front. The glob
// arithmetic itself is covered directly in prdload.test.ts.
it("rejects overlapping editor scopes between tasks with no dependency between them", () => {
  const r = validatePrd(
    prd({ tasks: [task({ id: "A", scope: ["src/api/**"] }), task({ id: "B", scope: ["src/api/db.ts"] })] }),
  );
  expect(r.ok).toBe(false);
  expect(r.errors).toContain(
    "tasks A and B have no dependency between them but edit the same files: src/api/** overlaps src/api/db.ts",
  );
});

it("accepts the same overlap once an edge orders the two tasks", () => {
  const p = prd({
    tasks: [task({ id: "A", scope: ["src/api/**"] }), task({ id: "B", deps: ["A"], scope: ["src/api/db.ts"] })],
  });
  expect(validatePrd(p)).toEqual({ ok: true, errors: [] });
});

it("rejects non-string persisted plan fields", () => {
  const r = validatePrd(prd({ tasks: [task({ plan: 42, planKey: false })] }));
  expect(r.errors).toContain("task[0].plan must be a string");
  expect(r.errors).toContain("task[0].planKey must be a string");
  expect(validatePrd(prd({ tasks: [task({ plan: "steps", planKey: "advisor:hash" })] })).ok).toBe(true);
});

it("rejects a dep referencing an unknown id", () => {
  const r = validatePrd(prd({ tasks: [task({ id: "A", deps: ["ghost"] })] }));
  expect(r.errors).toContain("task[0] dep references unknown id: ghost");
});

// a cycle passes every per-task check, so without this the PRD loads and only
// dies later as "no runnable tasks" — a message that blames the backlog for an
// unsatisfiable graph. The error has to name the tasks so it is fixable.
it("rejects a dependency cycle and names the tasks in it", () => {
  const r = validatePrd(prd({ tasks: [task({ id: "A", deps: ["B"] }), task({ id: "B", deps: ["A"] })] }));
  expect(r.ok).toBe(false);
  expect(r.errors).toContain("dependency cycle: A -> B -> A — no task in it can ever start");
});

it("rejects a self-dependency", () => {
  const r = validatePrd(prd({ tasks: [task({ id: "A", deps: ["A"] })] }));
  expect(r.errors).toContain("dependency cycle: A -> A — no task in it can ever start");
});

// a cycle nobody points at is still unsatisfiable, and it is only reachable if
// the walk starts from every node rather than from the roots.
it("finds a cycle that no acyclic task depends on", () => {
  const r = validatePrd(
    prd({ tasks: [task({ id: "A" }), task({ id: "B", deps: ["C"] }), task({ id: "C", deps: ["B"] })] }),
  );
  expect(r.errors).toContain("dependency cycle: B -> C -> B — no task in it can ever start");
});

// the regression that a naive "already on the stack" check causes: a diamond
// visits A twice on two different paths, which is re-convergence, not a cycle.
it("accepts a diamond DAG (a node reached twice is not a cycle)", () => {
  const r = validatePrd(
    prd({
      tasks: [
        task({ id: "A" }),
        task({ id: "B", deps: ["A"] }),
        task({ id: "C", deps: ["A"] }),
        task({ id: "D", deps: ["B", "C"] }),
      ],
    }),
  );
  expect(r).toEqual({ ok: true, errors: [] });
});

// deps pointing at ids that do not exist already have their own error; feeding
// them to the cycle walk would report a cycle through a task nobody declared.
it("does not report a cycle through an unknown dep id", () => {
  const r = validatePrd(prd({ tasks: [task({ id: "A", deps: ["ghost"] })] }));
  expect(r.errors).toEqual(["task[0] dep references unknown id: ghost"]);
});
