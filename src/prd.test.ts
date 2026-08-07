// prd.test.ts — nextTask, findTask (normalize/recovery cases live in prdload.test.ts)
import { describe, it, expect } from "vitest";
import { nextTask, findTask, readyTasks, sessionRunnableIds } from "./prd.js";
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

describe("readyTasks", () => {
  const prd = (tasks: Task[]): PRD => ({ project: "", stack: "", architecture_notes: "", tasks });

  it("returns EVERY todo whose deps are all done — that set is what a wave dispatches", () => {
    const p = prd([t({ id: "A", status: "done" }), t({ id: "B", deps: ["A"] }), t({ id: "C" })]);
    expect(readyTasks(p).map((x) => x.id)).toEqual(["B", "C"]);
  });

  it("never admits a task whose dep is merely READY, only one that is done", () => {
    // the whole difference from sessionRunnableIds: admitting B here would put
    // two ordered tasks in the same wave, running B against a half-built A
    const p = prd([t({ id: "A" }), t({ id: "B", deps: ["A"] })]);
    expect(readyTasks(p).map((x) => x.id)).toEqual(["A"]);
  });

  it("excludes doing/blocked tasks, so a wave never re-dispatches one in flight", () => {
    const p = prd([t({ id: "A", status: "doing" }), t({ id: "B", status: "blocked" }), t({ id: "C" })]);
    expect(readyTasks(p).map((x) => x.id)).toEqual(["C"]);
  });
});

describe("findTask", () => {
  it("finds by id or returns null", () => {
    const prd: PRD = { project: "", stack: "", architecture_notes: "", tasks: [t({ id: "A" })] };
    expect(findTask(prd, "A")?.id).toBe("A");
    expect(findTask(prd, "Z")).toBeNull();
  });
});

describe("sessionRunnableIds", () => {
  const prd = (tasks: Task[]): PRD => ({ project: "", stack: "", architecture_notes: "", tasks });

  it("admits a chain of todo tasks (each dep completes the next)", () => {
    const p = prd([t({ id: "A" }), t({ id: "B", deps: ["A"] }), t({ id: "C", deps: ["B"] })]);
    expect(sessionRunnableIds(p, false)).toEqual(new Set(["A", "B", "C"]));
  });

  it("counts already-done deps as satisfied", () => {
    const p = prd([t({ id: "A", status: "done" }), t({ id: "B", deps: ["A"] })]);
    expect(sessionRunnableIds(p, false)).toEqual(new Set(["B"])); // done A is not itself 'runnable'
  });

  it("EXCLUDES a todo task transitively gated by a non-promotable blocked dep (non-TTY)", () => {
    // the round-4 scenario: B (browser) depends on blocked A; C is independent.
    const p = prd([t({ id: "A", status: "blocked" }), t({ id: "B", deps: ["A"] }), t({ id: "C" })]);
    expect(sessionRunnableIds(p, false)).toEqual(new Set(["C"])); // B can never run this session
  });

  it("INCLUDES that chain on a TTY, where the blocked dep can be promoted", () => {
    const p = prd([t({ id: "A", status: "blocked" }), t({ id: "B", deps: ["A"] }), t({ id: "C" })]);
    expect(sessionRunnableIds(p, true)).toEqual(new Set(["A", "B", "C"]));
  });
});
