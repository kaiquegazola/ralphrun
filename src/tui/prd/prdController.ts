// prdController.ts — PURE reducer + initial state + selectors for the PRD studio.
// Chat-driven, in-memory PRD editing. NO Ink/React, NO child_process. Fully
// deterministic; exhaustive switch (no default) mirrors controller.ts for
// branch coverage.

import type { PRD } from "../../prd.js";
import { validatePrd } from "./validatePrd.js";

export type Role = "you" | "planner" | "error";
export interface ChatMessage {
  role: Role;
  text: string;
}
export interface Attachment {
  path: string;
}
export type PrdStatus = "idle" | "drafting" | "error";

export interface PrdState {
  prd: PRD | null;
  messages: ChatMessage[];
  attachments: Attachment[];
  undoStack: (PRD | null)[];
  status: PrdStatus;
  errors: string[];
}

export interface PlannerResult {
  summary: string;
  prd: PRD | null;
  errors: string[];
}

export type PrdAction =
  | { type: "addUserMessage"; text: string }
  | { type: "startDrafting" }
  | { type: "appendPlannerChunk"; text: string }
  | { type: "applyPlannerResult"; result: PlannerResult }
  | { type: "undo" }
  | { type: "addAttachment"; path: string }
  | { type: "clearAttachments" }
  | { type: "reset" };

export const initialPrdState: PrdState = {
  prd: null,
  messages: [],
  attachments: [],
  undoStack: [],
  status: "idle",
  errors: [],
};

// diffTasks — compact "+A -R ~C" (added / removed / changed by id) for the
// planner's confirmation line.
export function diffTasks(old: PRD | null, next: PRD): string {
  const oldTasks = old?.tasks ?? [];
  const oldIds = new Set(oldTasks.map((t) => t.id));
  const nextIds = new Set(next.tasks.map((t) => t.id));
  const oldById = new Map(oldTasks.map((t) => [t.id, t]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const t of next.tasks) {
    if (!oldIds.has(t.id)) added++;
    else {
      const prev = oldById.get(t.id)!;
      if (JSON.stringify(prev) !== JSON.stringify(t)) changed++;
    }
  }
  for (const t of oldTasks) if (!nextIds.has(t.id)) removed++;
  return `+${added} -${removed} ~${changed}`;
}

export function reducer(state: PrdState, action: PrdAction): PrdState {
  switch (action.type) {
    case "addUserMessage":
      return { ...state, messages: [...state.messages, { role: "you", text: action.text }] };
    case "startDrafting":
      return { ...state, status: "drafting", messages: [...state.messages, { role: "planner", text: "" }] };
    case "appendPlannerChunk": {
      const messages = state.messages.slice();
      const last = messages[messages.length - 1];
      // chunks are readline lines: join with a space so the live drafting
      // message stays a single row by design, not by gluing words together.
      messages[messages.length - 1] = { ...last, text: last.text ? `${last.text} ${action.text}` : action.text };
      return { ...state, messages };
    }
    case "applyPlannerResult": {
      const { summary, prd, errors } = action.result;
      if (prd !== null) {
        const messages = state.messages.slice();
        messages[messages.length - 1] = { role: "planner", text: `${summary} ${diffTasks(state.prd, prd)}` };
        return {
          ...state,
          prd,
          undoStack: [...state.undoStack, state.prd],
          messages,
          attachments: [],
          status: "idle",
          errors: [],
        };
      }
      return {
        ...state,
        messages: [...state.messages, { role: "error", text: errors.join("; ") }],
        attachments: [],
        status: "error",
        errors,
      };
    }
    case "undo": {
      if (state.undoStack.length === 0) return state;
      const undoStack = state.undoStack.slice();
      const prd = undoStack.pop()!;
      return { ...state, prd, undoStack, status: "idle" };
    }
    case "addAttachment":
      return { ...state, attachments: [...state.attachments, { path: action.path }] };
    case "clearAttachments":
      return { ...state, attachments: [] };
    case "reset":
      return initialPrdState;
  }
}

// selectors
export function canFinalize(s: PrdState): boolean {
  return s.prd !== null && validatePrd(s.prd).ok && s.status !== "drafting";
}

export function taskCount(s: PrdState): number {
  return s.prd?.tasks.length ?? 0;
}

export function depsOk(s: PrdState): boolean {
  return s.prd ? validatePrd(s.prd).ok : false;
}
