// wizardController.ts — PURE reducer + initial state + selectors for the
// fullscreen init wizard (screen state machine: preflight → settings →
// action → studio). NO Ink/React/fs/child_process; exhaustive switch (no
// default) mirrors prdController.ts for branch coverage.

import { relative } from "node:path";
import type { AgentDiagnostic } from "../../diagnostics.js";
import { t, type Locale } from "../../i18n.js";

export type Screen =
  | "language"
  | "preflight"
  | "settings"
  | "agentPick"
  | "action"
  | "filepick"
  | "refineOrRun"
  | "studio"
  | "saveAs";

export type AgentRole = "planner" | "executor" | "advisor";

export interface CliSpec {
  cli: string;
  model: string;
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
  force: boolean;
  fromRootFallback: boolean;
  cwd: string;
  hasUserConfig: boolean; // global config file exists → skip the language screen
  systemLocale: Locale; // resolveLocale() at the edge — initial cursor on the language screen
  // global user config defaults (advisor null = explicitly disabled)
  saved: {
    planner?: CliSpec | null;
    executor?: CliSpec | null;
    advisor?: CliSpec | null;
    commit_per_task?: boolean;
  };
  // parsed+sanitized ./ralph.config.json (read at the edge; parse failure → null).
  // "advisor" key present with null = explicitly disabled in the project config.
  cwdConfig: { executor?: CliSpec; advisor?: CliSpec | null; commit_per_task?: boolean } | null;
}

export interface WizardState {
  ctx: WizardInit;
  screen: Screen;
  stack: Screen[]; // history for Esc/back: push on forward, pop on back
  cursor: number;
  language: Locale | null; // set on the language screen; mount observes null→value for side effects
  diagnostics: AgentDiagnostic[];
  prdPath: string | null;
  filepickQuery: string;
  plannerSpec: CliSpec | null;
  executorSpec: CliSpec | null;
  advisorSpec: CliSpec | null; // null = advisor disabled
  commit: boolean;
  agentRole: AgentRole | null; // which settings row opened agentPick
  savedPath: string | null; // raw relative save-as input as confirmed; mount resolves vs cwd
  prdErrors: string[] | null; // non-null = invalid-PRD error state (refineOrRun/filepick render it)
  saveAsInput: string;
  pendingBuild: boolean; // saveAs was opened by CONSTRUIR → confirm also resolves run:true
  done: null | { type: "quit" } | { type: "result"; prdPath: string; run: boolean };
}

export type WizardAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "select" }
  | { type: "pickFile"; path: string }
  | { type: "back" }
  | { type: "refresh"; diagnostics: AgentDiagnostic[] }
  | { type: "setQuery"; query: string }
  | { type: "openSaveAs"; build: boolean }
  | { type: "saveAsInput"; value: string }
  | { type: "saveAsConfirm" }
  | { type: "saveAsCancel" }
  | { type: "saveFailed" }
  | { type: "prdInvalid"; errors: string[]; parseable: boolean }
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

export function getModelOptions(role: AgentRole, cli: string): Option[] {
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

// error state (prdErrors set): "run" is removed — refine (or esc) are the exits
const refineOrRunOptions = (s: WizardState): Option[] =>
  s.prdErrors
    ? [{ value: "refine", label: t("wizard.refine.studio") }]
    : [
        { value: "refine", label: t("wizard.refine.studio") },
        { value: "run", label: t("wizard.refine.run") },
      ];

const SETTINGS_ROW: Record<AgentRole, number> = { planner: 0, executor: 1, advisor: 2 };

const fmtSpec = (spec: CliSpec): string => `${spec.cli}:${spec.model}`;

export function settingsOptions(s: WizardState): Option[] {
  const agent = (spec: CliSpec | null): string =>
    spec ? fmtSpec(spec) : t("wizard.settings.disabled");
  return [
    { value: "planner", label: `${t("wizard.settings.planner").padEnd(10)}${agent(s.plannerSpec)}` },
    { value: "executor", label: `${t("wizard.settings.executor").padEnd(10)}${agent(s.executorSpec)}` },
    { value: "advisor", label: `${t("wizard.settings.advisor").padEnd(10)}${agent(s.advisorSpec)}` },
    { value: "commit", label: t("wizard.settings.commit", { v: t(s.commit ? "common.yes" : "common.no") }) },
    { value: "continue", label: t("wizard.settings.continue") },
  ];
}

// "ready" = installed with VERIFIED auth. loggedIn "unknown" is excluded:
// offering an unverifiable CLI lets the user pick one that fails at run time.
const isReady = (d: AgentDiagnostic | undefined): boolean =>
  !!d && d.installed && d.loggedIn === true;

function availableClis(diagnostics: AgentDiagnostic[]): Option[] {
  const byCli = new Map(diagnostics.map((d) => [d.cli, d]));
  return CLI_OPTIONS.filter((o) => isReady(byCli.get(o.value)));
}

// first available CLI in CLI_OPTIONS order + its recommended model; none → null
export function recommendedSpec(role: AgentRole, diagnostics: AgentDiagnostic[]): CliSpec | null {
  const cli = availableClis(diagnostics)[0];
  if (!cli) return null;
  return { cli: cli.value, model: getModelOptions(role, cli.value)[0].value };
}

// flat cli:model combos (recommended combo is first by construction: availableClis
// preserves CLI_OPTIONS order and getModelOptions sorts recommended-first);
// advisor additionally gets "disable" (last).
export function agentPickOptions(role: AgentRole, diagnostics: AgentDiagnostic[]): Option[] {
  const out: Option[] = [];
  for (const c of availableClis(diagnostics)) {
    for (const m of getModelOptions(role, c.value)) {
      const value = `${c.value}:${m.value}`;
      out.push({ value, label: value });
    }
  }
  if (out.length > 0) out[0] = { ...out[0], hint: t("wizard.model.recommended") };
  if (role === "advisor") out.push({ value: "disable", label: t("wizard.agent.disable") });
  return out;
}

// per-field precedence: ./ralph.config.json (key present) > saved global
// default > recommended. Advisor null is "explicitly disabled" at BOTH layers,
// so key-presence (`in`) — not truthiness — decides whether a layer applies.
// A layer's spec only applies when its CLI is READY (installed + verified
// auth) — a stale seed would sail through canContinue into a runLoop
// preflight exit(1).
export function seedSettings(
  init: WizardInit,
  diagnostics: AgentDiagnostic[],
): { planner: CliSpec | null; executor: CliSpec | null; advisor: CliSpec | null; commit: boolean } {
  const ready = (spec: CliSpec | null | undefined): CliSpec | undefined =>
    spec && isReady(diagnostics.find((d) => d.cli === spec.cli)) ? spec : undefined;
  const cwd = init.cwdConfig;
  const saved = init.saved;
  // ralph.config.json has no planner key → saved > recommended
  const planner = ready(saved.planner) ?? recommendedSpec("planner", diagnostics);
  const executor =
    ready(cwd?.executor) ?? ready(saved.executor) ?? recommendedSpec("executor", diagnostics);
  const adv =
    cwd && "advisor" in cwd
      ? cwd.advisor ?? null
      : "advisor" in saved
        ? saved.advisor ?? null
        : recommendedSpec("advisor", diagnostics);
  // explicit null stays "disabled"; a non-ready spec falls back to recommended
  const advisor = adv === null ? null : ready(adv) ?? recommendedSpec("advisor", diagnostics);
  const commit = cwd?.commit_per_task ?? saved.commit_per_task ?? true;
  return { planner, executor, advisor, commit };
}

// setup step per screen; studio/saveAs are labeled "studio" in headerLabel.
const SCREEN_STEP: Record<Exclude<Screen, "studio" | "saveAs">, number> = {
  language: 1,
  preflight: 1,
  settings: 2,
  agentPick: 2,
  action: 3,
  filepick: 3,
  refineOrRun: 3,
};

export function initialWizardState(init: WizardInit, diagnostics: AgentDiagnostic[]): WizardState {
  const seeded = seedSettings(init, diagnostics);
  return {
    ctx: init,
    // first run (no global config yet): ask the language first, cursor on the system locale
    screen: init.hasUserConfig ? "preflight" : "language",
    stack: [],
    cursor: init.hasUserConfig ? 0 : init.systemLocale === "pt-br" ? 1 : 0,
    language: null,
    diagnostics,
    prdPath: null,
    filepickQuery: "",
    plannerSpec: seeded.planner,
    executorSpec: seeded.executor,
    advisorSpec: seeded.advisor,
    commit: seeded.commit,
    agentRole: null,
    savedPath: null,
    prdErrors: null,
    saveAsInput: "",
    pendingBuild: false,
    done: null,
  };
}

export function visibleOptions(s: WizardState): Option[] {
  switch (s.screen) {
    case "preflight": // table rendered from diagnostics; Enter just advances
    case "filepick": // component-owned list (searchFiles in the view)
    case "studio": // PrdApp owns input
    case "saveAs": // text input, not a list
      return [];
    case "language":
      return LANGUAGE_OPTIONS;
    case "settings":
      return settingsOptions(s);
    case "agentPick":
      return agentPickOptions(s.agentRole!, s.diagnostics);
    case "action":
      return actionOptions();
    case "refineOrRun":
      return refineOrRunOptions(s);
  }
}

export function canProceed(s: WizardState): boolean {
  return visibleOptions(s).length > 0;
}

// Continue on the settings screen needs a planner + executor (advisor optional)
export function canContinue(s: WizardState): boolean {
  return s.plannerSpec !== null && s.executorSpec !== null;
}

export function headerLabel(s: WizardState): string {
  return s.screen === "studio" || s.screen === "saveAs"
    ? t("wizard.header.studio")
    : t("wizard.header.setup", { n: SCREEN_STEP[s.screen] });
}

// initial cursor when landing on a screen (forward push or back pop):
// agentPick → the row's current combo ("disable" when advisor is off);
// settings → the row that opened agentPick (back pop). Not found → 0.
// saveAs never lands via forward/back (openSaveAs/saveAsCancel set it directly).
function prefillCursor(s: WizardState, screen: Exclude<Screen, "saveAs">): number {
  switch (screen) {
    case "agentPick": {
      const role = s.agentRole!;
      const spec =
        role === "planner" ? s.plannerSpec : role === "executor" ? s.executorSpec : s.advisorSpec;
      const want = spec ? fmtSpec(spec) : role === "advisor" ? "disable" : undefined;
      if (want === undefined) return 0;
      const idx = agentPickOptions(role, s.diagnostics).findIndex((o) => o.value === want);
      return Math.max(0, idx);
    }
    case "settings":
      return s.agentRole === null ? 0 : SETTINGS_ROW[s.agentRole];
    case "language":
    case "preflight":
    case "action":
    case "filepick":
    case "refineOrRun":
    case "studio":
      return 0;
  }
}

// forward transition: push current screen for Esc/back, cursor on the prefill.
function forward(s: WizardState, screen: Exclude<Screen, "saveAs">): WizardState {
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
      return forward(s, "settings");
    case "settings": {
      const opt = settingsOptions(s)[s.cursor];
      if (opt.value === "commit") return { ...s, commit: !s.commit }; // toggle in place, no nav
      if (opt.value === "continue") return canContinue(s) ? forward(s, "action") : s;
      return forward({ ...s, agentRole: opt.value as AgentRole }, "agentPick");
    }
    case "agentPick": {
      const opt = visibleOptions(s)[s.cursor];
      if (!opt) return s; // no CLI installed+logged in: Enter no-ops
      const role = s.agentRole!;
      let next: WizardState;
      if (opt.value === "disable") {
        next = { ...s, advisorSpec: null };
      } else {
        const i = opt.value.indexOf(":");
        const spec: CliSpec = { cli: opt.value.slice(0, i), model: opt.value.slice(i + 1) };
        next =
          role === "planner"
            ? { ...s, plannerSpec: spec }
            : role === "executor"
              ? { ...s, executorSpec: spec }
              : { ...s, advisorSpec: spec };
      }
      return reducer(next, { type: "back" }); // pop to settings, cursor on the role's row
    }
    case "action": {
      const opt = visibleOptions(s)[s.cursor];
      if (opt.value === "CREATE_NEW") return forward({ ...s, prdPath: null }, "studio");
      return forward({ ...s, filepickQuery: "" }, "filepick");
    }
    case "refineOrRun": {
      const opt = visibleOptions(s)[s.cursor];
      // forward to the studio clears the invalid-PRD error state (chat fixes it)
      if (opt.value === "refine") return forward({ ...s, prdErrors: null }, "studio");
      return { ...s, done: { type: "result", prdPath: s.prdPath!, run: true } };
    }
    case "filepick": // Enter on filepick is the pickFile action, not select
    case "studio": // PrdApp owns studio input
    case "saveAs": // saveAs uses its own actions
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
      // a fresh file clears any lingering invalid-PRD error state
      return forward({ ...s, prdPath: a.path, prdErrors: null }, "refineOrRun");
    }
    case "back": {
      if (s.stack.length === 0 || s.screen === "studio" || s.screen === "saveAs") return s;
      const stack = s.stack.slice();
      const screen = stack.pop() as Exclude<Screen, "saveAs">; // studio/saveAs are never pushed
      const next: WizardState = { ...s, stack, screen, cursor: 0, prdErrors: null };
      return { ...next, cursor: prefillCursor(next, screen) };
    }
    case "refresh": {
      const next: WizardState = { ...s, diagnostics: a.diagnostics };
      // clamp the cursor in case the fresh list shrank under it.
      return { ...next, cursor: Math.min(s.cursor, Math.max(0, visibleOptions(next).length - 1)) };
    }
    case "setQuery":
      // typing in filepick dismisses the invalid-PRD error line(s)
      return { ...s, filepickQuery: a.query, cursor: 0, prdErrors: null };
    case "openSaveAs": {
      // dispatched by mount from PrdApp's onSave/onBuild when savedPath===null
      if (s.screen !== "studio") return s;
      const def = s.prdPath ? relative(s.ctx.cwd, s.prdPath) : "prd.json";
      return { ...s, screen: "saveAs", saveAsInput: def, pendingBuild: a.build };
    }
    case "saveAsInput":
      return s.screen === "saveAs" ? { ...s, saveAsInput: a.value } : s;
    case "saveAsConfirm": {
      if (s.screen !== "saveAs") return s;
      const path = s.saveAsInput.trim();
      if (path === "") return s;
      // mount observes savedPath null→value and writes BEFORE resolving done.
      return {
        ...s,
        savedPath: path,
        screen: "studio",
        pendingBuild: false,
        done: s.pendingBuild ? { type: "result", prdPath: path, run: true } : s.done,
      };
    }
    case "saveAsCancel":
      return s.screen === "saveAs"
        ? { ...s, screen: "studio", pendingBuild: false, saveAsInput: "" }
        : s;
    case "saveFailed":
      // the write threw: forget the bad path and any pending done, so the
      // wizard never resolves (or silently re-saves to) an unwritten file.
      return { ...s, savedPath: null, done: null };
    case "prdInvalid": {
      // run-it-now hit an invalid PRD: cancel the pending run:true result and
      // show the errors. Parseable → stay on refineOrRun (error state renders
      // there, "run" disappears); unparseable JSON → unwind to filepick.
      const base: WizardState = { ...s, done: null, prdErrors: a.errors, cursor: 0 };
      if (a.parseable) return base;
      const stack = base.stack.slice();
      let screen = base.screen;
      // filepick is always beneath refineOrRun today; stop at stack empty if a
      // future entry path reaches refineOrRun without it.
      while (screen !== "filepick" && stack.length > 0) screen = stack.pop() as Screen;
      return { ...base, stack, screen };
    }
    case "quit":
      // quitting the studio after a save keeps the file usable: resolve run:false
      if (s.screen === "studio" && s.savedPath !== null) {
        return { ...s, done: { type: "result", prdPath: s.savedPath, run: false } };
      }
      return { ...s, done: { type: "quit" } };
  }
}
