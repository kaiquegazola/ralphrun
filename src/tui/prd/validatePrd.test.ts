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

it("rejects a non-string verify (undefined stays allowed)", () => {
  const r = validatePrd(prd({ tasks: [task({ verify: 42 })] }));
  expect(r.errors).toContain("task[0].verify must be a string");
  expect(validatePrd(prd({ tasks: [task({ verify: "npm test" })] })).ok).toBe(true);
  expect(validatePrd(prd()).ok).toBe(true); // verify omitted
});

it("rejects a dep referencing an unknown id", () => {
  const r = validatePrd(prd({ tasks: [task({ id: "A", deps: ["ghost"] })] }));
  expect(r.errors).toContain("task[0] dep references unknown id: ghost");
});
