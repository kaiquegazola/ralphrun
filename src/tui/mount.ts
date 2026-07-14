// mount.ts — thin Ink glue: owns the external store (state + dispatch + subscriber
// Set), renders <App>, subscribes the event bus → dispatch, and returns the
// TuiHandle the loop drives. NO state logic (that's controller.ts). Excluded from
// coverage (added to vitest coverage.exclude — Ink can't mount under a test runner).

import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { on, clear, type RunEvent } from "./events.js";
import { initialState, reducer, type Action, type UiState } from "./controller.js";
import type { TaskStatus } from "../prd.js";

export interface TuiHandle {
  update(e: RunEvent): void;
  control: {
    isPaused(): boolean;
    shouldQuit(): boolean;
    takeSkip(): boolean; // consume-once: returns then clears skipRequested
    beginTask(): AbortSignal; // fresh AbortController per task; skip-confirm aborts it
  };
  waitConfigOrResume(): Promise<"resume" | "config" | "quit">;
  waitStalled(): Promise<"retry" | "quit">;
  waitReviewBlocked(reason: string, canApprove: boolean): Promise<"retry" | "approve" | "block" | "quit">;
  unmount(): void;
}

export function mount(seedTasks: UiState["tasks"], header: string, project: string, startPaused = false): TuiHandle {
  const initialStateWithTasks = { ...initialState, tasks: seedTasks };
  if (startPaused) initialStateWithTasks.paused = true;
  let state: UiState = reducer(initialStateWithTasks, { type: "seedTasks", tasks: seedTasks });
  const subs = new Set<() => void>();
  let ac: AbortController | null = null;

  const store = {
    subscribe(cb: () => void): () => void {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    getSnapshot(): UiState {
      return state;
    },
    dispatch(a: Action): void {
      state = reducer(state, a);
      // side-effect: a confirmed skip OR quit aborts the running task's executor
      // child so the control takes effect now, not after the task finishes.
      if (state.skipRequested || state.quit) ac?.abort();
      for (const cb of subs) cb();
    },
  };

  const unsubBus = on((e) => store.dispatch({ type: "event", event: e }));
  const instance = render(React.createElement(App, { store, header, project }));

  return {
    update: (e) => store.dispatch({ type: "event", event: e }),
    control: {
      isPaused: () => state.paused,
      shouldQuit: () => state.quit,
      takeSkip: () => {
        const s = state.skipRequested;
        if (s) store.dispatch({ type: "consumeSkip" });
        return s;
      },
      beginTask: () => {
        ac = new AbortController();
        return ac.signal;
      },
    },
    waitConfigOrResume: () =>
      new Promise<"resume" | "config" | "quit">((res) => {
        if (!state.paused || state.quit) return res(state.quit ? "quit" : "resume");
        if (state.configRequested) return res("config");
        const un = store.subscribe(() => {
          if (state.quit) {
            un();
            res("quit");
          } else if (state.configRequested) {
            un();
            res("config");
          } else if (!state.paused) {
            un();
            res("resume");
          }
        });
      }),
    waitStalled: () => {
      store.dispatch({ type: "setStalled" });
      return new Promise<"retry" | "quit">((res) => {
        const un = store.subscribe(() => {
          if (state.stalledAction) {
            un();
            res(state.stalledAction);
          }
        });
      });
    },
    waitReviewBlocked: (reason, canApprove) => {
      store.dispatch({ type: "setReviewBlocked", reason, canApprove });
      return new Promise<"retry" | "approve" | "block" | "quit">((res) => {
        const un = store.subscribe(() => {
          if (state.reviewAction) {
            un();
            res(state.reviewAction);
          }
        });
      });
    },
    unmount: () => {
      unsubBus();
      instance.unmount();
      clear();
    },
  };
}
