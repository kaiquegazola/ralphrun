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
    endTask(signal: AbortSignal): void; // drops it: a settled task is not skippable
  };
  waitConfigOrResume(): Promise<"resume" | "config" | "quit">;
  waitStalled(): Promise<"retry" | "quit">;
  waitReviewBlocked(reason: string, canApprove: boolean): Promise<"retry" | "approve" | "block" | "quit">;
  unmount(): void;
}

export function mount(
  seedTasks: UiState["tasks"],
  header: string,
  project: string,
  startPaused = false,
  onPausedChange?: (paused: boolean) => void,
): TuiHandle {
  const initialStateWithTasks = { ...initialState, tasks: seedTasks };
  if (startPaused) initialStateWithTasks.paused = true;
  let state: UiState = reducer(initialStateWithTasks, { type: "seedTasks", tasks: seedTasks });
  const subs = new Set<() => void>();
  // one controller per IN-FLIGHT task: a wave runs several executors at once, so
  // a single slot would leave every task but the last one un-killable. Keyed by
  // signal so a settled task can drop its own without the caller holding the
  // controller — otherwise a long backlog accumulates one per attempt, and a
  // skip walks every task the run has ever started to abort the two that are
  // actually live.
  const acs = new Map<AbortSignal, AbortController>();

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
      const wasPaused = state.paused;
      state = reducer(state, a);
      if (state.paused !== wasPaused) onPausedChange?.(state.paused);
      // Side-effect: a confirmed skip OR quit aborts the running tasks' signal,
      // so the control takes effect now rather than after the task finishes.
      // Every phase that spawns a child honours it — the executor, the verify
      // command and the advisor/review call — and run.ts stops opening further
      // review rounds. Anything less would leave the control waiting out a 600s
      // verify or a 900s review it had already killed the executor for.
      // Deliberately coarse: it kills the WHOLE wave, because the dashboard has
      // no per-task selection to aim a skip at.
      if (state.skipRequested || state.quit) for (const ac of acs.values()) ac.abort();
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
        const ac = new AbortController();
        acs.set(ac.signal, ac);
        return ac.signal;
      },
      endTask: (signal) => {
        acs.delete(signal);
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
