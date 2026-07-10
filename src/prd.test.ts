// prd.test.ts — recoverAndNormalize, nextTask, findTask
import { describe, it, expect } from "vitest";
import { recoverAndNormalize, nextTask, findTask } from "./prd.js";
import type { PRD, Task } from "./prd.js";

function t(partial: Partial<Task> & { id: string }): Task {
  return {
    title: "t",
    status: "todo",
    deps: [],
    retries: 0,
    description: "",
    acceptance: [],
    ...partial,
  };
}

describe("recoverAndNormalize", () => {
  it("fills missing defaults and reports changed", () => {
    const prd = { project: "", stack: "", architecture_notes: "", tasks: [{ id: "A", title: "x", description: "" }] } as unknown as PRD;
    const changed = recoverAndNormalize(prd);
    expect(changed).toBe(true);
    const task = prd.tasks[0];
    expect(task.status).toBe("todo");
    expect(task.retries).toBe(0);
    expect(task.deps).toEqual([]);
    expect(task.acceptance).toEqual([]);
  });

  it("converts doing -> todo", () => {
    const prd: PRD = { project: "", stack: "", architecture_notes: "", tasks: [t({ id: "A", status: "doing" })] };
    expect(recoverAndNormalize(prd)).toBe(true);
    expect(prd.tasks[0].status).toBe("todo");
  });

  it("no change when already normalized", () => {
    const prd: PRD = { project: "", stack: "", architecture_notes: "", tasks: [t({ id: "A", status: "done" })] };
    expect(recoverAndNormalize(prd)).toBe(false);
  });
});

describe("nextTask", () => {
  it("returns first todo with satisfied deps", () => {
    const prd: PRD = {
      project: "", stack: "", architecture_notes: "",
      tasks: [t({ id: "A", status: "done" }), t({ id: "B", deps: ["A"] })],
    };
    expect(nextTask(prd)?.id).toBe("B");
  });

  it("skips todos with unmet deps -> null", () => {
    const prd: PRD = {
      project: "", stack: "", architecture_notes: "",
      tasks: [t({ id: "B", deps: ["A"] })],
    };
    expect(nextTask(prd)).toBeNull();
  });
});

describe("findTask", () => {
  it("finds by id or returns null", () => {
    const prd: PRD = { project: "", stack: "", architecture_notes: "", tasks: [t({ id: "A" })] };
    expect(findTask(prd, "A")?.id).toBe("A");
    expect(findTask(prd, "Z")).toBeNull();
  });
});
