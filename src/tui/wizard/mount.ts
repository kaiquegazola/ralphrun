// mount.ts — Ink glue for the fullscreen init wizard: enters the alt screen,
// renders ONE <WizardApp/> instance with the wizard store + a lazily-created
// PRD-studio store (same subscribe/getSnapshot/dispatch pattern as ../mount.ts),
// and resolves to the finalized prd path or null on quit. All fs/spawn side
// effects live in the caller's closures (checkAgents/cfgExistsFor/loadSeed/
// finalize) so wizard.ts stays 100% covered. Excluded from coverage (Ink can't
// mount under the test runner). The alt buffer is restored via: the finally
// (normal paths + render errors, raced against waitUntilExit since Ink's
// ErrorBoundary unmounts without settling `result`), uncaughtException/
// unhandledRejection hooks (stray throws in Ink callbacks), signal handlers
// (external SIGINT/SIGTERM/SIGHUP don't emit 'exit'), and a process 'exit'
// listener as the last resort. An AbortController kills any in-flight planner
// child on every teardown path.

import React from "react";
import { render } from "ink";
import type { AgentDiagnostic } from "../../diagnostics.js";
import { setLocale } from "../../i18n.js";
import type { PRD } from "../../prd.js";
import { readAttachment } from "../../picker.js";
import { saveUserConfig } from "../../userconfig.js";
import { enterAltScreen, exitAltScreen } from "../fullscreen.js";
import type { PrdStore } from "../prd/PrdApp.js";
import { runPlannerTurn } from "../prd/prdChat.js";
import {
  canFinalize,
  initialPrdState,
  reducer as prdReducer,
  type PrdAction,
  type PrdState,
} from "../prd/prdController.js";
import { WizardApp } from "./WizardApp.js";
import {
  initialWizardState,
  reducer,
  type WizardAction,
  type WizardInit,
  type WizardState,
} from "./wizardController.js";

export interface MountWizardArgs {
  init: WizardInit;
  checkAgents(): AgentDiagnostic[];
  cfgExistsFor(prdPath: string): boolean; // does dirname(prdPath)/ralph.config.json exist
  loadSeed(prdPath: string): PRD | null; // readFileSync + recoverAndNormalize (may throw)
  finalize(state: WizardState, prd: PRD): string; // writes prd.json + config, returns prd path
}

export async function mountWizard(args: MountWizardArgs): Promise<string | null> {
  let wstate = initialWizardState(args.init, args.checkAgents());
  const subs = new Set<() => void>();
  let prdStore: PrdStore | null = null;
  // aborted on every teardown path so an in-flight planner child is killed
  // instead of keeping the process alive (and running) after quit/finalize.
  const turnAbort = new AbortController();

  let resolveResult!: (v: string | null) => void;
  let rejectResult!: (e: unknown) => void;
  const result = new Promise<string | null>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  let settled = false;
  const finish = (v: string | null): void => {
    if (settled) return;
    settled = true;
    resolveResult(v);
  };
  const fail = (e: unknown): void => {
    if (settled) return;
    settled = true;
    rejectResult(e);
  };

  const buildPrdStore = (seed: PRD | null): PrdStore => {
    let pstate: PrdState = { ...initialPrdState, prd: seed };
    const psubs = new Set<() => void>();
    return {
      subscribe(cb: () => void): () => void {
        psubs.add(cb);
        return () => {
          psubs.delete(cb);
        };
      },
      getSnapshot: () => pstate,
      dispatch(a: PrdAction): void {
        pstate = prdReducer(pstate, a);
        for (const cb of psubs) cb();
      },
    };
  };

  const store = {
    subscribe(cb: () => void): () => void {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    getSnapshot: () => wstate,
    dispatch(a: WizardAction): void {
      const prevLang = wstate.language;
      wstate = reducer(wstate, a);
      // first-run language pick: apply + persist BEFORE notifying subscribers
      // so the very next frame already renders translated.
      if (wstate.language && wstate.language !== prevLang) {
        setLocale(wstate.language);
        saveUserConfig({ language: wstate.language });
      }
      const d = wstate.done;
      if (d?.type === "proceed" && !prdStore) {
        // build the studio store BEFORE notifying subscribers so the first
        // studio frame renders with the store already present.
        let seed: PRD | null = null;
        try {
          seed = wstate.actionChoice === "SELECT_EXISTING" ? args.loadSeed(wstate.prdPath!) : null;
        } catch (err) {
          fail(err); // malformed PRD json: reject; finally still restores the buffer
          return;
        }
        prdStore = buildPrdStore(seed);
      } else if (d?.type === "quit") {
        finish(null);
      } else if (d?.type === "useExisting") {
        finish(d.prdPath);
      }
      for (const cb of subs) cb();
    },
  };

  const onSend = (text: string): void => {
    const ps = prdStore!.getSnapshot();
    // capture BEFORE the dispatch so history/instruction don't double-count.
    const history = ps.messages.slice();
    const currentPrd = ps.prd;
    const attachments = ps.attachments.map((a) => readAttachment(a.path));
    prdStore!.dispatch({ type: "addUserMessage", text });
    prdStore!.dispatch({ type: "startDrafting" });
    runPlannerTurn({
      cli: wstate.plannerSpec!.cli,
      model: wstate.plannerSpec!.model,
      cwd: args.init.cwd,
      currentPrd,
      history,
      instruction: text,
      attachments,
      signal: turnAbort.signal,
      onChunk: (t) => prdStore!.dispatch({ type: "appendPlannerChunk", text: t }),
    })
      .then((res) => prdStore!.dispatch({ type: "applyPlannerResult", result: res }))
      .catch(fail); // a dispatch throw must settle `result` so the finally restores
  };

  const onFinalize = (): void => {
    if (settled) return; // a second 'f' press must not run finalize's writes again
    const ps = prdStore!.getSnapshot();
    if (!canFinalize(ps)) return; // defensive; PrdApp already gates on canFinalize
    try {
      finish(args.finalize(wstate, ps.prd!));
    } catch (err) {
      fail(err);
    }
  };

  enterAltScreen(); // BEFORE render() so Ink's first frame lands in the alt buffer
  const restore = (): void => {
    turnAbort.abort(); // kill an in-flight planner child so nothing lingers/writes
    exitAltScreen();
  };
  process.once("exit", restore); // belt-and-braces for process.exit paths
  // external signals kill the process WITHOUT emitting 'exit' — exit explicitly
  // so `restore` runs and the alt buffer + cursor come back.
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = (): void => process.exit(1);
  for (const sig of SIGNALS) process.on(sig, onSignal);
  // throws inside Ink callbacks (useInput, readline onChunk, …) never reach the
  // try/finally — settle `result` so teardown runs and the error surfaces in the
  // normal buffer instead of dying silently inside the alt screen.
  const onFatal = (err: unknown): void => fail(err);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(
      React.createElement(WizardApp, {
        store,
        prdStore: () => prdStore,
        cwd: args.init.cwd,
        checkAgents: args.checkAgents,
        cfgExistsFor: args.cfgExistsFor,
        onSend,
        onFinalize,
        onQuitStudio: () => finish(null),
        onResize: () => instance?.clear(),
      }),
      // ctrl+c is an in-app quit action; Ink's default would unmount without
      // settling `result`, leaking the alt buffer past the finally.
      { exitOnCtrlC: false },
    );
    // a component render error trips Ink's INTERNAL ErrorBoundary, which
    // unmounts silently — `result` would never settle and the finally would
    // never run. waitUntilExit rejects with that error (or resolves on a
    // self-unmount, treated as quit), so racing it guarantees the finally.
    return await Promise.race([result, instance.waitUntilExit().then((): string | null => null)]);
  } finally {
    settled = true; // no late finish/fail can re-settle or reject `result`
    resolveResult(null); // defuse the losing promise (no-op if already settled)
    for (const sig of SIGNALS) process.removeListener(sig, onSignal);
    process.removeListener("uncaughtException", onFatal);
    process.removeListener("unhandledRejection", onFatal);
    turnAbort.abort(); // kill an in-flight planner child
    instance?.unmount(); // unmount FIRST so Ink's cleanup output stays in the alt buffer
    exitAltScreen();
    process.removeListener("exit", restore);
  }
}
