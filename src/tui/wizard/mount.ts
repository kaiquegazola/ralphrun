// mount.ts — Ink glue for the fullscreen init wizard: enters the alt screen,
// renders ONE <WizardApp/> instance with the wizard store + a lazily-created
// PRD-studio store (same subscribe/getSnapshot/dispatch pattern as ../mount.ts),
// and resolves to { prdPath, run } or null on quit. All fs/spawn side effects
// live in the caller's closures (checkAgents/loadSeed/savePrd) so wizard.ts
// stays 100% covered. Excluded from coverage (Ink can't mount under the test
// runner). The alt buffer is restored via: the finally (normal paths + render
// errors, raced against waitUntilExit since Ink's ErrorBoundary unmounts
// without settling `result`), uncaughtException/unhandledRejection hooks
// (stray throws in Ink callbacks), signal handlers (external SIGINT/SIGTERM/
// SIGHUP don't emit 'exit'), and a process 'exit' listener as the last resort.
// An AbortController kills any in-flight planner child on every teardown path.

import React from "react";
import { render } from "ink";
import { resolve } from "node:path";
import type { AgentDiagnostic } from "../../diagnostics.js";
import { setLocale } from "../../i18n.js";
import type { PRD } from "../../prd.js";
import type { PrdLoadResult } from "../../prdload.js";
import { readAttachment } from "../../picker.js";
import { saveUserConfig } from "../../userconfig.js";
import { enterAltScreen, exitAltScreen } from "../fullscreen.js";
import type { PrdStore } from "../prd/PrdApp.js";
import { runPlannerTurn } from "../prd/prdChat.js";
import {
  canSave,
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

export interface WizardResult {
  prdPath: string; // absolute
  run: boolean; // true → cli hands it straight to runLoop
}

export interface MountWizardArgs {
  init: WizardInit;
  checkAgents(): AgentDiagnostic[];
  loadSeed(prdPath: string): PrdLoadResult; // pipeline: parse + normalize + validate (never throws)
  loadForRun(prdPath: string): PrdLoadResult; // pipeline + write-back of the normalized file when ok (write may throw)
  savePrd(state: WizardState, prd: PRD, absPrdPath: string): void; // writes prd + ralph.config.json (may throw)
  saveConfig(state: WizardState, absPrdPath: string): void; // config + global defaults only ("run it now": the prd already exists)
}

export async function mountWizard(args: MountWizardArgs): Promise<WizardResult | null> {
  let wstate = initialWizardState(args.init, args.checkAgents());
  const subs = new Set<() => void>();
  let prdStore: PrdStore | null = null;
  // aborted on every teardown path so an in-flight planner child is killed
  // instead of keeping the process alive (and running) after quit/save.
  const turnAbort = new AbortController();

  let resolveResult!: (v: WizardResult | null) => void;
  let rejectResult!: (e: unknown) => void;
  const result = new Promise<WizardResult | null>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  let settled = false;
  const finish = (v: WizardResult | null): void => {
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

  // write the PRD + config at the remembered save path, then clear the dirty
  // bit. Returns false on a write throw — the error lands in the studio chat
  // (the drafted PRD survives) and callers never resolve run:true for a file
  // that was not written.
  const doSave = (): boolean => {
    const abs = resolve(args.init.cwd, wstate.savedPath!);
    try {
      args.savePrd(wstate, prdStore!.getSnapshot().prd!, abs);
    } catch (err) {
      prdStore!.dispatch({
        type: "saveError",
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    prdStore!.dispatch({ type: "markSaved" });
    return true;
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
      const prevScreen = wstate.screen;
      const prevSavedPath = wstate.savedPath;
      wstate = reducer(wstate, a);
      // first-run language pick: apply + persist BEFORE notifying subscribers
      // so the very next frame already renders translated.
      if (wstate.language && wstate.language !== prevLang) {
        setLocale(wstate.language);
        saveUserConfig({ language: wstate.language });
      }
      // entering the studio: build the store BEFORE notifying subscribers so
      // the first studio frame renders with the store already present.
      if (wstate.screen === "studio" && prevScreen !== "studio" && !prdStore) {
        let seed: PRD | null = null;
        if (wstate.prdPath) {
          const r = args.loadSeed(wstate.prdPath);
          if (!r.ok && !r.prd) {
            // unparseable JSON: back to filepick with the error shown — the
            // mount promise never rejects after the user finished setup.
            wstate = reducer(wstate, { type: "prdInvalid", errors: r.errors, parseable: false });
            for (const cb of subs) cb();
            return;
          }
          // parseable-but-invalid DOES seed the studio: the chat exists to fix
          // it; validity is gated at save/build by writePrdFile.
          seed = r.prd ?? null;
        }
        prdStore = buildPrdStore(seed);
      }
      // save-as confirmed: write STRICTLY BEFORE resolving done, so CONSTRUIR
      // never resolves run:true for an unwritten path. A throw stays in-app:
      // saveFailed forgets the bad path + pending done and the studio lives on.
      if (wstate.savedPath !== null && prevSavedPath === null) {
        if (!doSave()) {
          wstate = reducer(wstate, { type: "saveFailed" });
          for (const cb of subs) cb();
          return;
        }
      }
      const d = wstate.done;
      if (d?.type === "quit") {
        finish(null);
      } else if (d?.type === "result") {
        if (wstate.savedPath === null) {
          // "run it now" is the only run:true with no studio save — gate it on
          // the pipeline BEFORE saveConfig/finish, so an invalid PRD never runs.
          if (d.run) {
            let r: PrdLoadResult;
            try {
              r = args.loadForRun(resolve(args.init.cwd, d.prdPath));
            } catch (err) {
              fail(err); // write-back fs throw: reject as today
              return;
            }
            if (!r.ok) {
              // cancel the pending done + show the errors (saveFailed pattern:
              // one notify, no finish — subscribers never see a settled done).
              wstate = reducer(wstate, { type: "prdInvalid", errors: r.errors, parseable: r.prd !== undefined });
              for (const cb of subs) cb();
              return;
            }
          }
          // persist the settings-screen choices so runLoop uses them instead
          // of a stale project config / DEFAULTS.
          try {
            args.saveConfig(wstate, resolve(args.init.cwd, d.prdPath));
          } catch (err) {
            fail(err);
            return;
          }
        }
        finish({ prdPath: resolve(args.init.cwd, d.prdPath), run: d.run });
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

  // [s]: first save opens the save-as screen; after that, silent re-save.
  const onSave = (): void => {
    if (settled) return;
    if (!canSave(prdStore!.getSnapshot())) return; // defensive; PrdApp already gates
    if (wstate.savedPath !== null) doSave();
    else store.dispatch({ type: "openSaveAs", build: false });
  };

  // [c] CONSTRUIR: save (or save-as with pendingBuild) then resolve run:true.
  const onBuild = (): void => {
    if (settled) return;
    if (!canSave(prdStore!.getSnapshot())) return; // defensive; PrdApp already gates
    if (wstate.savedPath !== null) {
      if (doSave()) finish({ prdPath: resolve(args.init.cwd, wstate.savedPath), run: true });
    } else {
      store.dispatch({ type: "openSaveAs", build: true });
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
        onSend,
        onSave,
        onBuild,
        // reducer decides: savedPath set → { prdPath, run:false }, else quit/null
        onQuitStudio: () => store.dispatch({ type: "quit" }),
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
    return await Promise.race([result, instance.waitUntilExit().then((): WizardResult | null => null)]);
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
