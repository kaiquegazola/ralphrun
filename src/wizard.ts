// wizard.ts — `ralphrun init`: computes the fs-derived context (paths, seeded
// defaults), then hands off to the ONE fullscreen Ink wizard app
// (src/tui/wizard/mount.ts). All fs side effects live here in closures
// (loadSeed / savePrd) so this module stays 100% covered while the Ink glue
// is excluded. Resolves { prdPath, run } | null (null = quit) for cli.ts.
// Non-TTY: lazy fallback, no Ink.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { browserStatusAsync } from "./browser.js";
import { checkAllAgents } from "./diagnostics.js";
import { DEFAULTS } from "./config.js";
import { resolveLocale, t } from "./i18n.js";
import { loadUserConfig, saveUserConfig, userConfigExists } from "./userconfig.js";
import type { PRD } from "./prd.js";
import { loadPrdFile, validatePrd } from "./prdload.js";
import { mountWizard, type WizardResult } from "./tui/wizard/mount.js";
import type { CliSpec, WizardInit, WizardState } from "./tui/wizard/wizardController.js";

export type { WizardResult };

// default scaffold for the non-TTY fallback (studio can't take raw mode).
export function defaultScaffold(): PRD {
  return {
    project: "project",
    stack: "describe stack here (e.g. Next.js + Postgres + Prisma). The executor reads this.",
    architecture_notes:
      "High-level decisions the executor must respect across ALL tasks. Kept short. Fresh context each task, so anything not written here is forgotten.",
    tasks: [
      {
        id: "T1-scaffold",
        title: "Project scaffold",
        status: "todo",
        deps: [],
        retries: 0,
        description: "Initialize the project structure and tooling per the stack.",
        acceptance: ["package.json (or equivalent) exists", "app builds / typechecks with no errors"],
        verify: "exit 1  # TODO: set a real stack-specific gate, e.g. typecheck && focused tests && build when relevant",
      },
    ],
  };
}

// EVERY prd.json write (savePrd + non-TTY fallback) routes through this one
// validatePrd gate — an invalid PRD is never written to disk.
function writePrdFile(prdPath: string, prd: PRD): void {
  const v = validatePrd(prd);
  if (!v.ok) throw new Error(t("wizard.err.invalidPrd", { errors: v.errors.join("; ") }));
  writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n");
}

const isSpec = (v: unknown): v is CliSpec =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as CliSpec).cli === "string" &&
  typeof (v as CliSpec).model === "string";

// field-wise sanitize of ./ralph.config.json for settings seeding: only known
// keys with the right shape survive; a missing/malformed file → null (never
// throws). "advisor": null is kept as an explicit "disabled".
export function readCwdConfig(path: string): WizardInit["cwdConfig"] {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const out: NonNullable<WizardInit["cwdConfig"]> = {};
  if (isSpec(r.executor)) out.executor = { cli: r.executor.cli, model: r.executor.model };
  if (r.advisor === null) out.advisor = null;
  else if (isSpec(r.advisor)) out.advisor = { cli: r.advisor.cli, model: r.advisor.model };
  if (typeof r.commit_per_task === "boolean") out.commit_per_task = r.commit_per_task;
  return out;
}

interface InitOptions {
  prd: string;
  config?: string; // undefined = no explicit --config → config lives next to the PRD
  force?: boolean;
  fromRootFallback?: boolean;
}

export async function initWizard(opts: InitOptions): Promise<WizardResult | null> {
  const prdPathNew = resolve(opts.prd);
  const cfgPathNew = resolve(opts.config ?? "ralph.config.json");
  // explicit --config wins; otherwise the config sits next to the PRD, which
  // is exactly where runLoop's loadConfig falls back to.
  const cfgTarget = (absPrdPath: string): string =>
    opts.config ? cfgPathNew : resolve(dirname(absPrdPath), "ralph.config.json");

  // ponytail: no TTY -> Ink can't grab raw mode. Write DEFAULTS config + a
  // minimal scaffold (no picker/studio possible) and skip the app entirely.
  // run mirrors today's behavior: the bare-`ralphrun` root fallback proceeds
  // into runLoop, a piped `ralphrun init` just writes and exits.
  if (!process.stdout.isTTY) {
    if ((existsSync(prdPathNew) || existsSync(cfgPathNew)) && !opts.force) {
      console.error(t("wizard.nontty.exists"));
      return null;
    }
    writePrdFile(prdPathNew, defaultScaffold());
    writeFileSync(cfgPathNew, JSON.stringify(DEFAULTS, null, 2) + "\n");
    console.error(t("wizard.nontty.skipped"));
    return { prdPath: prdPathNew, run: !!opts.fromRootFallback };
  }

  // studio seed: full pipeline result — the mount seeds parseable-but-invalid
  // PRDs into the studio (the chat fixes them; validity is gated at write).
  const loadSeed = (prdPath: string): ReturnType<typeof loadPrdFile> => loadPrdFile(prdPath);

  // run-it-now gate: validate BEFORE resolving run:true; persist the pipeline's
  // safe coercions so runLoop re-reads an already-clean file (fs stays here).
  const loadForRun = (prdPath: string): ReturnType<typeof loadPrdFile> => {
    const r = loadPrdFile(prdPath);
    if (r.ok && r.normalized) writeFileSync(prdPath, JSON.stringify(r.prd, null, 2) + "\n");
    return r;
  };

  // settings-screen choices → ralph.config.json (--config path or next to the
  // PRD) + merge-save of the global default agents for the next init. Also
  // called alone on the "run it now" path (the picked prd already exists).
  const saveConfig = (state: WizardState, absPrdPath: string): void => {
    const cfg = {
      ...structuredClone(DEFAULTS),
      executor: { ...state.executorSpec! },
      advisor: state.advisorSpec === null ? null : { ...state.advisorSpec },
      commit_per_task: state.commit,
    };
    writeFileSync(cfgTarget(absPrdPath), JSON.stringify(cfg, null, 2) + "\n");
    // language is NOT saved here: the language screen saves it on pick, and a
    // --lang override must stay one-run-only (never persisted).
    saveUserConfig({
      default_planner: state.plannerSpec,
      default_executor: state.executorSpec,
      default_advisor: state.advisorSpec,
    });
  };

  // one save = prd + the config (from the settings screen choices).
  const savePrd = (state: WizardState, prd: PRD, absPrdPath: string): void => {
    writePrdFile(absPrdPath, prd);
    saveConfig(state, absPrdPath);
  };

  const saved = loadUserConfig();
  // key presence matters for advisor (null = explicitly disabled) — only set
  // the key when the global config actually has one, so seeding can fall
  // through to the recommendation.
  const savedInit: WizardInit["saved"] = {
    planner: saved.default_planner,
    executor: saved.default_executor,
    commit_per_task: saved.commit_per_task,
  };
  if (saved.default_advisor !== undefined) savedInit.advisor = saved.default_advisor;

  const result = await mountWizard({
    init: {
      prdPathNew,
      cfgPathNew,
      force: !!opts.force,
      fromRootFallback: !!opts.fromRootFallback,
      cwd: process.cwd(),
      // language screen shows only when NO global config exists, so
      // resolveLocale() here IS the system locale (nothing saved to prefer).
      hasUserConfig: userConfigExists(),
      systemLocale: resolveLocale(),
      saved: savedInit,
      cwdConfig: readCwdConfig(cfgPathNew), // honors --config; defaults to ./ralph.config.json
    },
    checkAgents: checkAllAgents,
    checkBrowser: browserStatusAsync, // optional UI-validation tool — shown, never gated (async: never blocks the render)
    loadSeed,
    loadForRun,
    savePrd,
    saveConfig,
  });

  // post-restore so it's visible outside the alt buffer. run:false says
  // nothing here — cli.ts prints the "saved — run with" hint.
  if (result?.run) console.log(t("wizard.usingPrd", { path: result.prdPath }));
  return result;
}
