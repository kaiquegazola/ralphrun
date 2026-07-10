// wizardController.ts — PURE reducer + initial state + selectors for the
// fullscreen init wizard (screen state machine: preflight → … → studio).
// NO Ink/React/fs/child_process; exhaustive switch (no default) mirrors
// prdController.ts for branch coverage. CLI_OPTIONS / MODELS /
// getModelOptions live here (duplicated from wizard.ts for now — the
// integrate step removes the originals and this module becomes the source).

import type { AgentDiagnostic } from "../../diagnostics.js";
import { t, type Locale } from "../../i18n.js";

export type Screen =
  | "language"
  | "preflight"
  | "action"
  | "filepick"
  | "overwrite"
  | "plannerCli"
  | "plannerModel"
  | "executorCli"
  | "executorModel"
  | "advisorCli"
  | "advisorModel"
  | "commit"
  | "studio";

export interface CliSpec {
  cli: string;
  model: string; // advisor "none" => { cli: "none", model: "" }
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

// computed by wizard.ts (fs at the edge), frozen into state
export interface WizardInit {
  prdPathNew: string;
  cfgPathNew: string;
  newPrdExists: boolean;
  newCfgExists: boolean;
  force: boolean;
  fromRootFallback: boolean;
  cwd: string;
  hasUserConfig: boolean; // global config file exists → skip the language screen
  systemLocale: Locale; // resolveLocale() at the edge — initial cursor on the language screen
  saved: { planner?: CliSpec | null; executor?: CliSpec | null; advisor?: CliSpec | null }; // prefill
}

export interface WizardState {
  ctx: WizardInit;
  screen: Screen;
  stack: Screen[]; // history for Esc/back: push on forward, pop on back
  cursor: number;
  language: Locale | null; // set on the language screen; mount observes null→value for side effects
  diagnostics: AgentDiagnostic[];
  actionChoice: "CREATE_NEW" | "SELECT_EXISTING" | null;
  prdPath: string | null;
  filepickQuery: string;
  plannerSpec: CliSpec | null;
  executorSpec: CliSpec | null;
  advisorSpec: CliSpec | null;
  commit: boolean | null;
  needsOverwrite: { prd: boolean; cfg: boolean } | null;
  done:
    | null
    | { type: "quit" }
    | { type: "proceed" }
    | { type: "useExisting"; prdPath: string };
}

export type WizardAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "select" }
  | { type: "pickFile"; path: string; cfgExists: boolean }
  | { type: "back" }
  | { type: "refresh"; diagnostics: AgentDiagnostic[] }
  | { type: "setQuery"; query: string }
  | { type: "confirm" }
  | { type: "deny" }
  | { type: "quit" };

export const CLI_OPTIONS: Option[] = [
  { value: "claude", label: "Claude Code CLI" },
  { value: "grok", label: "Grok CLI" },
  { value: "cursor", label: "Cursor CLI" },
];

export const MODELS: Record<string, Option[]> = {
  claude: [
    { value: "sonnet", label: "sonnet" },
    { value: "opus", label: "opus" },
    { value: "fable", label: "fable" },
    { value: "haiku", label: "haiku" },
  ],
  grok: [{ value: "grok-4.5", label: "grok-4.5" }],
  cursor: [
    { value: "cursor-grok-4.5", label: "Cursor Grok 4.5" },
    { value: "composer-2.5", label: "Composer 2.5" },
    { value: "opus-4.8", label: "Opus 4.8" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "fable-5", label: "Fable 5" },
    { value: "sonnet-5", label: "Sonnet 5" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "sonnet-4.6", label: "Sonnet 4.6" },
  ],
};

export function getModelOptions(role: "planner" | "executor" | "advisor", cli: string): Option[] {
  const models = MODELS[cli] || [];
  let recommended = "";

  if (cli === "claude") {
    if (role === "planner") recommended = "opus";
    if (role === "executor") recommended = "sonnet";
    if (role === "advisor") recommended = "fable";
  } else if (cli === "cursor") {
    recommended = role === "executor" ? "sonnet-5" : "opus-4.8";
  } else if (cli === "grok") {
    recommended = "grok-4.5";
  }

  return models
    .map((m) => (m.value === recommended ? { ...m, hint: t("wizard.model.recommended") } : { ...m }))
    .sort((a, b) => {
      if (a.value === recommended) return -1;
      if (b.value === recommended) return 1;
      return 0;
    });
}

// language options are self-labeled (locale not chosen yet) — hardcoded, no t()
const LANGUAGE_OPTIONS: Option[] = [
  { value: "en", label: "English" },
  { value: "pt-br", label: "Português (Brasil)" },
];

// per-call builders (NOT module consts): module-level t() would freeze English
// before the first-run language screen sets the locale.
const actionOptions = (): Option[] => [
  { value: "CREATE_NEW", label: t("wizard.action.createNew") },
  { value: "SELECT_EXISTING", label: t("wizard.action.selectExisting") },
];

const overwriteOptions = (): Option[] => [
  { value: "yes", label: t("common.yesOverwrite") },
  { value: "no", label: t("common.noCancel") },
];

const commitOptions = (): Option[] => [
  { value: "yes", label: t("common.yes") },
  { value: "no", label: t("common.no") },
];

// setup step per screen; filepick/overwrite inherit step 2, studio is labeled.
const SCREEN_STEP: Record<Screen, number> = {
  language: 1,
  preflight: 1,
  action: 2,
  filepick: 2,
  overwrite: 2,
  plannerCli: 3,
  plannerModel: 3,
  executorCli: 4,
  executorModel: 4,
  advisorCli: 5,
  advisorModel: 5,
  commit: 6,
  studio: 7,
};

export function initialWizardState(init: WizardInit, diagnostics: AgentDiagnostic[]): WizardState {
  return {
    ctx: init,
    // first run (no global config yet): ask the language first, cursor on the system locale
    screen: init.hasUserConfig ? "preflight" : "language",
    stack: [],
    cursor: init.hasUserConfig ? 0 : init.systemLocale === "pt-br" ? 1 : 0,
    language: null,
    diagnostics,
    actionChoice: null,
    prdPath: null,
    filepickQuery: "",
    plannerSpec: null,
    executorSpec: null,
    advisorSpec: null,
    commit: null,
    needsOverwrite: null,
    done: null,
  };
}

function availableClis(diagnostics: AgentDiagnostic[]): Option[] {
  const byCli = new Map(diagnostics.map((d) => [d.cli, d]));
  return CLI_OPTIONS.filter((o) => {
    const d = byCli.get(o.value);
    return !!d && d.installed && d.loggedIn !== false;
  });
}

export function visibleOptions(s: WizardState): Option[] {
  switch (s.screen) {
    case "preflight": // table rendered from diagnostics; Enter just advances
    case "filepick": // component-owned list (searchFiles in the view)
    case "studio":
      return [];
    case "language":
      return LANGUAGE_OPTIONS;
    case "action":
      return actionOptions();
    case "overwrite":
      return overwriteOptions();
    case "plannerCli":
    case "executorCli":
      return availableClis(s.diagnostics);
    case "advisorCli":
      return [{ value: "none", label: t("wizard.advisor.none") }, ...availableClis(s.diagnostics)];
    case "plannerModel":
      return getModelOptions("planner", s.plannerSpec!.cli);
    case "executorModel":
      return getModelOptions("executor", s.executorSpec!.cli);
    case "advisorModel":
      return getModelOptions("advisor", s.advisorSpec!.cli);
    case "commit":
      return commitOptions();
  }
}

export function canProceed(s: WizardState): boolean {
  return visibleOptions(s).length > 0;
}

export function headerLabel(s: WizardState): string {
  return s.screen === "studio" ? t("wizard.header.studio") : t("wizard.header.setup", { n: SCREEN_STEP[s.screen] });
}

// initial cursor for a screen: index of the saved global-config preference in
// its option list (advisor null → "none"); model screens only when the chosen
// cli matches the saved one. Not found / nothing saved → 0 (recommended first).
function prefillCursor(s: WizardState, screen: Screen): number {
  const { saved } = s.ctx;
  let want: string | undefined;
  switch (screen) {
    case "plannerCli":
      want = saved.planner?.cli;
      break;
    case "executorCli":
      want = saved.executor?.cli;
      break;
    case "advisorCli":
      want = saved.advisor === null ? "none" : saved.advisor?.cli;
      break;
    case "plannerModel":
      want = saved.planner?.cli === s.plannerSpec!.cli ? saved.planner!.model : undefined;
      break;
    case "executorModel":
      want = saved.executor?.cli === s.executorSpec!.cli ? saved.executor!.model : undefined;
      break;
    case "advisorModel":
      want = saved.advisor?.cli === s.advisorSpec!.cli ? saved.advisor!.model : undefined;
      break;
    default:
      return 0;
  }
  if (want === undefined) return 0;
  const idx = visibleOptions({ ...s, screen }).findIndex((o) => o.value === want);
  return Math.max(0, idx);
}

// forward transition: push current screen for Esc/back, cursor on the prefill.
function forward(s: WizardState, screen: Screen): WizardState {
  const next: WizardState = { ...s, stack: [...s.stack, s.screen], screen, cursor: 0 };
  return { ...next, cursor: prefillCursor(next, screen) };
}

function applySelect(s: WizardState): WizardState {
  switch (s.screen) {
    case "language": {
      const opt = visibleOptions(s)[s.cursor];
      // side effects (setLocale + saveUserConfig) live in mount.ts's dispatch
      // wrapper, which observes the null → value transition on `language`.
      return forward({ ...s, language: opt.value as Locale }, "preflight");
    }
    case "preflight":
      return forward(s, "action");
    case "action": {
      const opt = visibleOptions(s)[s.cursor];
      if (opt.value === "CREATE_NEW") {
        const next: WizardState = { ...s, actionChoice: "CREATE_NEW", prdPath: s.ctx.prdPathNew };
        const { newPrdExists, newCfgExists, force } = s.ctx;
        if ((newPrdExists || newCfgExists) && !force) {
          return forward(
            { ...next, needsOverwrite: { prd: newPrdExists, cfg: newCfgExists } },
            "overwrite",
          );
        }
        return forward(next, "plannerCli");
      }
      return forward({ ...s, actionChoice: "SELECT_EXISTING", filepickQuery: "" }, "filepick");
    }
    case "overwrite": {
      const opt = visibleOptions(s)[s.cursor];
      return reducer(s, { type: opt.value === "yes" ? "confirm" : "deny" });
    }
    case "plannerCli": {
      const opt = visibleOptions(s)[s.cursor];
      if (!opt) return s; // no CLI installed+logged in: Enter no-ops
      return forward({ ...s, plannerSpec: { cli: opt.value, model: "" } }, "plannerModel");
    }
    case "plannerModel": {
      const opt = visibleOptions(s)[s.cursor];
      return forward({ ...s, plannerSpec: { cli: s.plannerSpec!.cli, model: opt.value } }, "executorCli");
    }
    case "executorCli": {
      const opt = visibleOptions(s)[s.cursor];
      if (!opt) return s;
      return forward({ ...s, executorSpec: { cli: opt.value, model: "" } }, "executorModel");
    }
    case "executorModel": {
      const opt = visibleOptions(s)[s.cursor];
      return forward({ ...s, executorSpec: { cli: s.executorSpec!.cli, model: opt.value } }, "advisorCli");
    }
    case "advisorCli": {
      const opt = visibleOptions(s)[s.cursor];
      if (opt.value === "none") {
        return forward({ ...s, advisorSpec: { cli: "none", model: "" } }, "commit");
      }
      return forward({ ...s, advisorSpec: { cli: opt.value, model: "" } }, "advisorModel");
    }
    case "advisorModel": {
      const opt = visibleOptions(s)[s.cursor];
      return forward({ ...s, advisorSpec: { cli: s.advisorSpec!.cli, model: opt.value } }, "commit");
    }
    case "commit": {
      const opt = visibleOptions(s)[s.cursor];
      return { ...forward(s, "studio"), commit: opt.value === "yes", done: { type: "proceed" } };
    }
    case "filepick": // Enter on filepick is the pickFile action, not select
    case "studio": // PrdApp owns studio input
      return s;
  }
}

export function reducer(s: WizardState, a: WizardAction): WizardState {
  switch (a.type) {
    case "up":
      return { ...s, cursor: Math.max(0, s.cursor - 1) };
    case "down": {
      // filepick's list is component-owned (searchFiles); the view clamps.
      if (s.screen === "filepick") return { ...s, cursor: s.cursor + 1 };
      return { ...s, cursor: Math.min(Math.max(0, visibleOptions(s).length - 1), s.cursor + 1) };
    }
    case "select":
      return applySelect(s);
    case "pickFile": {
      if (s.screen !== "filepick") return s;
      if (s.ctx.fromRootFallback && a.cfgExists) {
        return { ...s, prdPath: a.path, done: { type: "useExisting", prdPath: a.path } };
      }
      const next: WizardState = { ...s, prdPath: a.path };
      if (a.cfgExists && !s.ctx.force) {
        return forward({ ...next, needsOverwrite: { prd: false, cfg: true } }, "overwrite");
      }
      return forward(next, "plannerCli");
    }
    case "back": {
      if (s.stack.length === 0 || s.screen === "studio") return s;
      const stack = s.stack.slice();
      const screen = stack.pop()!;
      return { ...s, stack, screen, cursor: 0 };
    }
    case "refresh": {
      const next: WizardState = { ...s, diagnostics: a.diagnostics };
      // clamp the cursor in case the fresh list shrank under it.
      return { ...next, cursor: Math.min(s.cursor, Math.max(0, visibleOptions(next).length - 1)) };
    }
    case "setQuery":
      return { ...s, filepickQuery: a.query, cursor: 0 };
    case "confirm":
      return s.screen === "overwrite" ? forward(s, "plannerCli") : s;
    case "deny":
      return s.screen === "overwrite" ? { ...s, done: { type: "quit" } } : s;
    case "quit":
      return { ...s, done: { type: "quit" } };
  }
}
