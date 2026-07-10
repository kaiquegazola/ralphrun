// prdController.test.ts — every action, diffTasks branches, and selectors.
import { describe, it, expect } from "vitest";
import {
  reducer,
  initialPrdState,
  diffTasks,
  canFinalize,
  taskCount,
  depsOk,
  type PrdState,
} from "./prdController.js";
import type { PRD } from "../../prd.js";

function mkPrd(tasks: PRD["tasks"]): PRD {
  return { project: "p", stack: "s", architecture_notes: "a", tasks };
}
function mkTask(id: string, over: Partial<PRD["tasks"][number]> = {}): PRD["tasks"][number] {
  return { id, title: id, status: "todo", deps: [], retries: 0, description: "d", acceptance: [], ...over };
}
const VALID = mkPrd([mkTask("A"), mkTask("B", { deps: ["A"] })]);

it("addUserMessage pushes a 'you' message", () => {
  const s = reducer(initialPrdState, { type: "addUserMessage", text: "hi" });
  expect(s.messages).toEqual([{ role: "you", text: "hi" }]);
});

it("startDrafting sets drafting + streaming placeholder", () => {
  const s = reducer(initialPrdState, { type: "startDrafting" });
  expect(s.status).toBe("drafting");
  expect(s.messages).toEqual([{ role: "planner", text: "" }]);
});

it("appendPlannerChunk accumulates lines into the last message, space-separated", () => {
  let s = reducer(initialPrdState, { type: "startDrafting" });
  s = reducer(s, { type: "appendPlannerChunk", text: "hel" });
  s = reducer(s, { type: "appendPlannerChunk", text: "lo" });
  expect(s.messages[s.messages.length - 1]).toEqual({ role: "planner", text: "hel lo" });
});

it("applyPlannerResult (valid) replaces prd, pushes undo, writes summary+diff, clears attachments", () => {
  let s: PrdState = { ...initialPrdState, attachments: [{ path: "x" }] };
  s = reducer(s, { type: "startDrafting" });
  s = reducer(s, { type: "applyPlannerResult", result: { summary: "drafted", prd: VALID, errors: [] } });
  expect(s.prd).toBe(VALID);
  expect(s.undoStack).toEqual([null]);
  expect(s.attachments).toEqual([]);
  expect(s.status).toBe("idle");
  expect(s.errors).toEqual([]);
  expect(s.messages[s.messages.length - 1]).toEqual({ role: "planner", text: "drafted +2 -0 ~0" });
});

it("applyPlannerResult (invalid) keeps old prd, pushes error bubble, clears attachments", () => {
  let s: PrdState = { ...initialPrdState, prd: VALID, attachments: [{ path: "x" }] };
  s = reducer(s, { type: "applyPlannerResult", result: { summary: "", prd: null, errors: ["bad", "worse"] } });
  expect(s.prd).toBe(VALID);
  expect(s.status).toBe("error");
  expect(s.errors).toEqual(["bad", "worse"]);
  expect(s.attachments).toEqual([]);
  expect(s.messages[s.messages.length - 1]).toEqual({ role: "error", text: "bad; worse" });
});

it("undo pops the stack, or no-ops when empty", () => {
  expect(reducer(initialPrdState, { type: "undo" })).toBe(initialPrdState);
  const withStack: PrdState = { ...initialPrdState, prd: VALID, undoStack: [null] };
  const s = reducer(withStack, { type: "undo" });
  expect(s.prd).toBeNull();
  expect(s.undoStack).toEqual([]);
  expect(s.status).toBe("idle");
});

it("addAttachment and clearAttachments", () => {
  let s = reducer(initialPrdState, { type: "addAttachment", path: "a.ts" });
  expect(s.attachments).toEqual([{ path: "a.ts" }]);
  s = reducer(s, { type: "clearAttachments" });
  expect(s.attachments).toEqual([]);
});

it("reset returns the initial state", () => {
  const s: PrdState = { ...initialPrdState, prd: VALID, status: "error" };
  expect(reducer(s, { type: "reset" })).toBe(initialPrdState);
});

it("diffTasks reports added / removed / changed", () => {
  const old = mkPrd([mkTask("A"), mkTask("B"), mkTask("C")]);
  const next = mkPrd([mkTask("A"), mkTask("B", { title: "renamed" }), mkTask("D")]);
  expect(diffTasks(old, next)).toBe("+1 -1 ~1");
  expect(diffTasks(null, next)).toBe("+3 -0 ~0");
});

it("canFinalize is true only for a valid, non-drafting PRD", () => {
  expect(canFinalize(initialPrdState)).toBe(false); // prd null
  expect(canFinalize({ ...initialPrdState, prd: mkPrd([mkTask("A", { deps: ["ghost"] })]) })).toBe(false); // invalid
  expect(canFinalize({ ...initialPrdState, prd: VALID, status: "drafting" })).toBe(false); // drafting
  expect(canFinalize({ ...initialPrdState, prd: VALID })).toBe(true);
});

it("taskCount and depsOk read the current PRD", () => {
  expect(taskCount(initialPrdState)).toBe(0);
  expect(taskCount({ ...initialPrdState, prd: VALID })).toBe(2);
  expect(depsOk(initialPrdState)).toBe(false);
  expect(depsOk({ ...initialPrdState, prd: VALID })).toBe(true);
});
