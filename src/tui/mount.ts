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
  waitResume(): Promise<void>; // resolves now if !paused, else on next unpause
  unmount(): void;
}

export function mount(
  seedTasks: { id: string; title: string; status: TaskStatus }[],
  header: string,
): TuiHandle {
  let state: UiState = reducer(initialState, { type: "seedTasks", tasks: seedTasks });
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
  const instance = render(React.createElement(App, { store, header }));

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
    waitResume: () =>
      // resolves on unpause OR quit — so a quit pressed while paused can't deadlock the loop.
      new Promise<void>((res) => {
        if (!state.paused || state.quit) return res();
        const un = store.subscribe(() => {
          if (!state.paused || state.quit) {
            un();
            res();
          }
        });
      }),
    unmount: () => {
      unsubBus();
      instance.unmount();
      clear();
    },
  };
}
