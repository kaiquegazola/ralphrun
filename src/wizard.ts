// wizard.ts — `ralphrun init`: computes the fs-derived context (overwrite
// flags, paths), then hands off to the ONE fullscreen Ink wizard app
// (src/tui/wizard/mount.ts). All fs side effects live here in closures
// (cfgExistsFor / loadSeed / finalize) so this module stays 100% covered
// while the Ink glue is excluded. Preserves the string prd-path | null
// contract for cli.ts. Non-TTY: lazy fallback, no Ink.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { checkAllAgents } from "./diagnostics.js";
import { DEFAULTS, parseAgent } from "./config.js";
import { resolveLocale, t } from "./i18n.js";
import { loadUserConfig, saveUserConfig, userConfigExists } from "./userconfig.js";
import { recoverAndNormalize, type PRD } from "./prd.js";
import { validatePrd } from "./tui/prd/validatePrd.js";
import { mountWizard } from "./tui/wizard/mount.js";
import type { WizardState } from "./tui/wizard/wizardController.js";

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
        verify: "exit 1  # TODO: set a real verify command (build/test)",
      },
    ],
  };
}

// EVERY prd.json write (finalize + non-TTY fallback) routes through this one
// validatePrd gate — an invalid PRD is never written to disk.
function writePrdFile(prdPath: string, prd: PRD): void {
  const v = validatePrd(prd);
  if (!v.ok) throw new Error(t("wizard.err.invalidPrd", { errors: v.errors.join("; ") }));
  writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n");
}

interface InitOptions {
  prd: string;
  config: string;
  force?: boolean;
  fromRootFallback?: boolean;
}

export async function initWizard(opts: InitOptions): Promise<string | null> {
  const prdPathNew = resolve(opts.prd);
  const cfgPathNew = resolve(opts.config);
  const newPrdExists = existsSync(prdPathNew);
  const newCfgExists = existsSync(cfgPathNew);

  // ponytail: no TTY -> Ink can't grab raw mode. Write DEFAULTS config + a
  // minimal scaffold (no picker/studio possible) and skip the app entirely.
  if (!process.stdout.isTTY) {
    if ((newPrdExists || newCfgExists) && !opts.force) {
      console.error(t("wizard.nontty.exists"));
      return null;
    }
    writePrdFile(prdPathNew, defaultScaffold());
    writeFileSync(cfgPathNew, JSON.stringify(DEFAULTS, null, 2) + "\n");
    console.error(t("wizard.nontty.skipped"));
    return prdPathNew;
  }

  const cfgPathFor = (prdPath: string): string => resolve(dirname(prdPath), "ralph.config.json");

  const loadSeed = (prdPath: string): PRD => {
    const seed = JSON.parse(readFileSync(prdPath, "utf8")) as PRD;
    recoverAndNormalize(seed);
    return seed;
  };

  const finalize = (state: WizardState, prd: PRD): string => {
    const prdPath = state.prdPath!;
    const cfgPath = state.actionChoice === "CREATE_NEW" ? state.ctx.cfgPathNew : cfgPathFor(prdPath);
    const cfg = {
      ...structuredClone(DEFAULTS),
      executor: parseAgent(`${state.executorSpec!.cli}:${state.executorSpec!.model}`)!,
      advisor:
        state.advisorSpec!.cli === "none"
          ? null
          : parseAgent(`${state.advisorSpec!.cli}:${state.advisorSpec!.model}`),
      commit_per_task: state.commit!,
    };
    writePrdFile(prdPath, prd);
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    // merge-save the choices as global defaults so the next init prefills them.
    // language is NOT saved here: the language screen saves it on pick, and a
    // --lang override must stay one-run-only (never persisted).
    saveUserConfig({
      default_planner: state.plannerSpec,
      default_executor: state.executorSpec,
      default_advisor: state.advisorSpec!.cli === "none" ? null : state.advisorSpec,
    });
    return prdPath;
  };

  const saved = loadUserConfig();
  const result = await mountWizard({
    init: {
      prdPathNew,
      cfgPathNew,
      newPrdExists,
      newCfgExists,
      force: !!opts.force,
      fromRootFallback: !!opts.fromRootFallback,
      cwd: process.cwd(),
      // language screen shows only when NO global config exists, so
      // resolveLocale() here IS the system locale (nothing saved to prefer).
      hasUserConfig: userConfigExists(),
      systemLocale: resolveLocale(),
      saved: {
        planner: saved.default_planner,
        executor: saved.default_executor,
        advisor: saved.default_advisor,
      },
    },
    checkAgents: checkAllAgents,
    cfgExistsFor: (prdPath) => existsSync(cfgPathFor(prdPath)),
    loadSeed,
    finalize,
  });

  // post-restore so it's visible outside the alt buffer.
  if (result) console.log(opts.fromRootFallback ? t("wizard.usingPrd", { path: result }) : t("wizard.done"));
  return result;
}
