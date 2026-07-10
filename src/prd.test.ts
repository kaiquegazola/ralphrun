// prd.test.ts — nextTask, findTask (normalize/recovery cases live in prdload.test.ts)
import { describe, it, expect } from "vitest";
import { nextTask, findTask } from "./prd.js";
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
