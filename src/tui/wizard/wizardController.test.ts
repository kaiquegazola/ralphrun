// wizardController.test.ts — the new screen flow: language → preflight →
// settings (rows + agentPick sub-screen + commit toggle + gated continue) →
// action → filepick/refineOrRun → studio (+ saveAs mini-screen), seeding
// precedence (cwd config > saved global > recommended), esc/back/quit at
// every screen, refresh clamps, and the CLI_OPTIONS/MODELS tables.
import { describe, it, expect } from "vitest";
import { AGENTS, agentClis } from "../../agents.js";
import type { AgentDiagnostic } from "../../diagnostics.js";
import { t } from "../../i18n.js";
import {
  CLI_OPTIONS,
  MODELS,
  getModelOptions,
  recommendedSpec,
  seedSettings,
  settingsOptions,
  agentPickOptions,
  initialWizardState,
  reducer,
  visibleOptions,
  canProceed,
  canContinue,
  headerLabel,
  type AgentRole,
  type WizardAction,
  type WizardInit,
  type WizardState,
} from "./wizardController.js";

function mkInit(over: Partial<WizardInit> = {}): WizardInit {
  return {
    prdPathNew: "/w/prd.json",
    cfgPathNew: "/w/ralph.config.json",
    force: false,
    fromRootFallback: false,
    cwd: "/w",
    hasUserConfig: true, // most tests start on preflight; language tests flip this
    systemLocale: "en",
    saved: {},
    cwdConfig: null,
    ...over,
  };
}

function diag(cli: string, installed = true, loggedIn: boolean | "unknown" = true): AgentDiagnostic {
  return { cli, installed, loggedIn, loginCommand: `${cli} login` };
}

const ALL_OK = [diag("claude"), diag("grok"), diag("cursor")];

function state(over: Partial<WizardInit> = {}, diags = ALL_OK): WizardState {
  return initialWizardState(mkInit(over), diags);
}

function walk(s: WizardState, ...actions: WizardAction[]): WizardState {
  return actions.reduce(reducer, s);
}

const downs = (n: number): WizardAction[] => Array<WizardAction>(n).fill({ type: "down" });

// preflight ⏎ → settings
const settings = (over: Partial<WizardInit> = {}, diags = ALL_OK): WizardState =>
  reducer(state(over, diags), { type: "select" });
// settings row (0 planner, 1 executor, 2 advisor) ⏎ → agentPick
const agentPick = (row: number, over: Partial<WizardInit> = {}, diags = ALL_OK): WizardState =>
  walk(settings(over, diags), ...downs(row), { type: "select" });
// settings Continue → action
const action = (over: Partial<WizardInit> = {}): WizardState =>
  walk(settings(over), ...downs(4), { type: "select" });
const filepick = (over: Partial<WizardInit> = {}): WizardState =>
  walk(action(over), { type: "down" }, { type: "select" });
const refineOrRun = (path = "/w/sub/x.json", over: Partial<WizardInit> = {}): WizardState =>
  reducer(filepick(over), { type: "pickFile", path });
// action → Create a new PRD → studio
const studioNew = (over: Partial<WizardInit> = {}): WizardState =>
  reducer(action(over), { type: "select" });

// The pickers DERIVE from the agent registry (src/agents.ts) — they hold no cli
// list of their own. So these assert the WIRING, not the model names: the values
// live in exactly one place, and agents.test.ts guards their shape there.
describe("tables", () => {
  const ROLES: AgentRole[] = ["planner", "executor", "advisor"];

  it("CLI_OPTIONS lists every registered CLI, in registry order, with its label", () => {
    expect(CLI_OPTIONS.map((o) => o.value)).toEqual(agentClis);
    for (const o of CLI_OPTIONS) expect(o.label).toBe(AGENTS[o.value].label);
  });

  it("MODELS mirrors each CLI's registry models", () => {
    for (const cli of agentClis) {
      expect(MODELS[cli].map((m) => m.value)).toEqual(AGENTS[cli].models.map((m) => m.value));
    }
  });

  it("getModelOptions puts the registry's recommended model first, hinted, for every cli+role", () => {
    for (const cli of agentClis) {
      for (const role of ROLES) {
        const opts = getModelOptions(role, cli);
        expect(opts[0].value).toBe(AGENTS[cli].recommended[role]);
        expect(opts[0].hint).toBe(t("wizard.model.recommended"));
        expect(opts.slice(1).every((o) => o.hint === undefined)).toBe(true);
        expect(opts.length).toBe(MODELS[cli].length); // recommended is sorted first, never dropped
      }
    }
  });

  it("getModelOptions returns [] for an unknown cli", () => {
    expect(getModelOptions("planner", "nope")).toEqual([]);
  });
});

describe("recommendedSpec", () => {
  it("first available CLI in CLI_OPTIONS order + its recommended model", () => {
    expect(recommendedSpec("planner", ALL_OK)).toEqual({ cli: "claude", model: "opus" });
    expect(recommendedSpec("executor", ALL_OK)).toEqual({ cli: "claude", model: "sonnet" });
    expect(recommendedSpec("advisor", ALL_OK)).toEqual({ cli: "claude", model: "fable" });
  });

  it("skips not-installed / not-logged-in / auth-unknown CLIs", () => {
    const diags = [diag("claude", false), diag("grok", true, "unknown"), diag("cursor", true, false)];
    expect(recommendedSpec("planner", diags)).toBeNull(); // unknown auth is NOT ready
    expect(recommendedSpec("planner", [diag("claude", false), diag("grok")])).toEqual({
      cli: "grok",
      model: "grok-4.5",
    });
  });

  it("no CLI available → null", () => {
    expect(recommendedSpec("executor", [])).toBeNull();
  });
});

describe("seedSettings precedence (cwd config > saved global > recommended)", () => {
  it("nothing saved anywhere → recommended trio + commit true", () => {
    expect(seedSettings(mkInit(), ALL_OK)).toEqual({
      planner: { cli: "claude", model: "opus" },
      executor: { cli: "claude", model: "sonnet" },
      advisor: { cli: "claude", model: "fable" },
      commit: true,
    });
  });

  it("planner: saved wins over recommended; saved null falls back", () => {
    const saved = { planner: { cli: "grok", model: "grok-4.5" } };
    expect(seedSettings(mkInit({ saved }), ALL_OK).planner).toEqual(saved.planner);
    expect(seedSettings(mkInit({ saved: { planner: null } }), ALL_OK).planner).toEqual({
      cli: "claude",
      model: "opus",
    });
  });

  it("executor: cwd config > saved > recommended", () => {
    const cwdSpec = { cli: "cursor", model: "gpt-5.5" };
    const savedSpec = { cli: "grok", model: "grok-4.5" };
    const both = mkInit({ cwdConfig: { executor: cwdSpec }, saved: { executor: savedSpec } });
    expect(seedSettings(both, ALL_OK).executor).toEqual(cwdSpec);
    expect(seedSettings(mkInit({ saved: { executor: savedSpec } }), ALL_OK).executor).toEqual(savedSpec);
    expect(seedSettings(mkInit({ saved: { executor: null } }), ALL_OK).executor).toEqual({
      cli: "claude",
      model: "sonnet",
    });
  });

  it("advisor: cwd key present wins (null = explicitly disabled)", () => {
    const savedSpec = { cli: "grok", model: "grok-4.5" };
    const cwdSpec = { cli: "cursor", model: "opus-4.8" };
    expect(
      seedSettings(mkInit({ cwdConfig: { advisor: cwdSpec }, saved: { advisor: savedSpec } }), ALL_OK)
        .advisor,
    ).toEqual(cwdSpec);
    expect(
      seedSettings(mkInit({ cwdConfig: { advisor: null }, saved: { advisor: savedSpec } }), ALL_OK)
        .advisor,
    ).toBeNull();
  });

  it("advisor: cwd key absent → saved (null = disabled) → recommended", () => {
    const savedSpec = { cli: "grok", model: "grok-4.5" };
    // cwd file exists but has no advisor key — must NOT mask the global default
    const noKey = mkInit({ cwdConfig: {}, saved: { advisor: savedSpec } });
    expect(seedSettings(noKey, ALL_OK).advisor).toEqual(savedSpec);
    expect(seedSettings(mkInit({ saved: { advisor: null } }), ALL_OK).advisor).toBeNull();
    expect(seedSettings(mkInit(), ALL_OK).advisor).toEqual({ cli: "claude", model: "fable" });
  });

  it("commit: cwd > saved > true; false is preserved", () => {
    const both = mkInit({ cwdConfig: { commit_per_task: false }, saved: { commit_per_task: true } });
    expect(seedSettings(both, ALL_OK).commit).toBe(false);
    expect(seedSettings(mkInit({ saved: { commit_per_task: false } }), ALL_OK).commit).toBe(false);
    expect(seedSettings(mkInit(), ALL_OK).commit).toBe(true);
  });

  it("no CLI available and nothing saved → null specs", () => {
    const seeded = seedSettings(mkInit(), []);
    expect(seeded).toEqual({ planner: null, executor: null, advisor: null, commit: true });
  });

  it("a non-ready seeded spec falls through (cwd → saved → recommended)", () => {
    const cursorSpec = { cli: "cursor", model: "opus-4.8" };
    const grokSpec = { cli: "grok", model: "grok-4.5" };
    const diags = [diag("claude"), diag("grok"), diag("cursor", true, false)]; // cursor logged out
    const both = mkInit({ cwdConfig: { executor: cursorSpec }, saved: { executor: grokSpec } });
    expect(seedSettings(both, diags).executor).toEqual(grokSpec); // cwd not ready → saved
    expect(seedSettings(mkInit({ cwdConfig: { executor: cursorSpec } }), diags).executor).toEqual({
      cli: "claude",
      model: "sonnet",
    });
    expect(seedSettings(mkInit({ saved: { planner: cursorSpec } }), diags).planner).toEqual({
      cli: "claude",
      model: "opus",
    });
    // a spec for a CLI missing from diagnostics entirely is not ready either
    expect(
      seedSettings(mkInit({ saved: { executor: { cli: "nope", model: "x" } } }), diags).executor,
    ).toEqual({ cli: "claude", model: "sonnet" });
  });

  it("advisor: non-ready spec → recommended; explicit null stays disabled", () => {
    const cursorSpec = { cli: "cursor", model: "opus-4.8" };
    const diags = [diag("claude"), diag("grok"), diag("cursor", true, "unknown")]; // cursor auth unknown
    expect(seedSettings(mkInit({ cwdConfig: { advisor: cursorSpec } }), diags).advisor).toEqual({
      cli: "claude",
      model: "fable",
    });
    expect(seedSettings(mkInit({ cwdConfig: { advisor: null } }), diags).advisor).toBeNull();
  });
});

describe("initial state + selectors", () => {
  it("starts on preflight with seeded specs", () => {
    const s = state();
    expect(s.screen).toBe("preflight");
    expect(s.stack).toEqual([]);
    expect(s.cursor).toBe(0);
    expect(s.language).toBeNull();
    expect(s.diagnostics).toBe(ALL_OK);
    expect(s.prdPath).toBeNull();
    expect(s.filepickQuery).toBe("");
    expect(s.plannerSpec).toEqual({ cli: "claude", model: "opus" });
    expect(s.executorSpec).toEqual({ cli: "claude", model: "sonnet" });
    expect(s.advisorSpec).toEqual({ cli: "claude", model: "fable" });
    expect(s.commit).toBe(true);
    expect(s.agentRole).toBeNull();
    expect(s.savedPath).toBeNull();
    expect(s.saveAsInput).toBe("");
    expect(s.pendingBuild).toBe(false);
    expect(s.done).toBeNull();
  });

  it("visibleOptions per screen", () => {
    expect(visibleOptions(state())).toEqual([]); // preflight
    expect(visibleOptions(settings()).map((o) => o.value)).toEqual([
      "planner",
      "executor",
      "advisor",
      "commit",
      "continue",
    ]);
    expect(visibleOptions(action()).map((o) => o.value)).toEqual(["CREATE_NEW", "SELECT_EXISTING"]);
    expect(visibleOptions(filepick())).toEqual([]); // component-owned
    expect(visibleOptions(refineOrRun()).map((o) => o.value)).toEqual(["refine", "run"]);
    expect(visibleOptions(refineOrRun()).map((o) => o.label)).toEqual([
      t("wizard.refine.studio"),
      t("wizard.refine.run"),
    ]);
    expect(visibleOptions(studioNew())).toEqual([]);
    expect(visibleOptions(reducer(studioNew(), { type: "openSaveAs", build: false }))).toEqual([]);
  });

  it("canProceed reflects visibleOptions", () => {
    expect(canProceed(state())).toBe(false); // preflight
    expect(canProceed(settings())).toBe(true);
  });

  it("canContinue needs planner AND executor", () => {
    expect(canContinue(state())).toBe(true);
    expect(canContinue(state({}, []))).toBe(false); // both null
    const plannerOnly = state({ saved: { planner: { cli: "claude", model: "opus" } } }, []);
    expect(canContinue(plannerOnly)).toBe(false);
    const executorOnly = state({ saved: { executor: { cli: "claude", model: "sonnet" } } }, []);
    expect(canContinue(executorOnly)).toBe(false);
  });

  it("headerLabel: setup {n}/3 per screen; studio/saveAs are labeled studio", () => {
    expect(headerLabel(state())).toBe("setup 1/3");
    expect(headerLabel(state({ hasUserConfig: false }))).toBe("setup 1/3"); // language
    expect(headerLabel(settings())).toBe("setup 2/3");
    expect(headerLabel(agentPick(0))).toBe("setup 2/3");
    expect(headerLabel(action())).toBe("setup 3/3");
    expect(headerLabel(filepick())).toBe("setup 3/3");
    expect(headerLabel(refineOrRun())).toBe("setup 3/3");
    expect(headerLabel(studioNew())).toBe(t("wizard.header.studio"));
    expect(headerLabel(reducer(studioNew(), { type: "openSaveAs", build: false }))).toBe(
      t("wizard.header.studio"),
    );
  });
});

describe("cursor movement", () => {
  it("up/down clamp at list edges (settings: 5 rows)", () => {
    let s = settings();
    expect(reducer(s, { type: "up" }).cursor).toBe(0); // clamp at top
    s = walk(s, ...downs(6));
    expect(s.cursor).toBe(4); // clamp at bottom
    expect(reducer(s, { type: "up" }).cursor).toBe(3);
  });

  it("down on filepick is unclamped (the view owns the file list)", () => {
    const s = filepick();
    expect(walk(s, ...downs(3)).cursor).toBe(3);
    expect(reducer(s, { type: "up" }).cursor).toBe(0);
  });
});

describe("preflight", () => {
  it("select advances to settings and pushes the stack", () => {
    const s = settings();
    expect(s.screen).toBe("settings");
    expect(s.stack).toEqual(["preflight"]);
    expect(s.cursor).toBe(0);
  });

  it("back is a no-op on the first screen", () => {
    const s = state();
    expect(reducer(s, { type: "back" })).toBe(s);
  });

  it("refresh replaces diagnostics", () => {
    const fresh = [diag("claude", false)];
    const s = reducer(state(), { type: "refresh", diagnostics: fresh });
    expect(s.diagnostics).toBe(fresh);
    expect(s.cursor).toBe(0);
  });
});

describe("settings", () => {
  it("rows show role, cli:model, commit value and continue", () => {
    const rows = settingsOptions(settings());
    expect(rows[0].label).toContain(t("wizard.settings.planner"));
    expect(rows[0].label).toContain("claude:opus");
    expect(rows[1].label).toContain("claude:sonnet");
    expect(rows[2].label).toContain("claude:fable");
    expect(rows[3].label).toBe(t("wizard.settings.commit", { v: t("common.yes") }));
    expect(rows[4].label).toBe(t("wizard.settings.continue"));
  });

  it("advisor row shows 'disabled' when advisorSpec is null", () => {
    const s = settings({ cwdConfig: { advisor: null } });
    expect(settingsOptions(s)[2].label).toContain(t("wizard.settings.disabled"));
  });

  it("⏎ on an agent row opens agentPick with that role", () => {
    const planner = agentPick(0);
    expect(planner.screen).toBe("agentPick");
    expect(planner.agentRole).toBe("planner");
    expect(planner.stack).toEqual(["preflight", "settings"]);
    expect(agentPick(1).agentRole).toBe("executor");
    expect(agentPick(2).agentRole).toBe("advisor");
  });

  it("⏎ on the commit row toggles in place (no nav, cursor kept)", () => {
    let s = walk(settings(), ...downs(3), { type: "select" });
    expect(s.screen).toBe("settings");
    expect(s.commit).toBe(false);
    expect(s.cursor).toBe(3);
    expect(settingsOptions(s)[3].label).toBe(t("wizard.settings.commit", { v: t("common.no") }));
    s = reducer(s, { type: "select" });
    expect(s.commit).toBe(true);
  });

  it("Continue advances to action; gated when planner/executor missing", () => {
    const ok = action();
    expect(ok.screen).toBe("action");
    expect(ok.stack).toEqual(["preflight", "settings"]);
    const gated = walk(settings({}, []), ...downs(4));
    expect(reducer(gated, { type: "select" })).toBe(gated); // no CLIs → specs null
  });

  it("back returns to preflight", () => {
    expect(reducer(settings(), { type: "back" }).screen).toBe("preflight");
  });

  it("refresh on settings keeps the cursor (5 rows always)", () => {
    const s = walk(settings(), ...downs(4));
    expect(reducer(s, { type: "refresh", diagnostics: [] }).cursor).toBe(4);
  });
});

describe("agentPick", () => {
  it("lists flat cli:model combos, recommended first with a hint", () => {
    const opts = agentPickOptions("planner", ALL_OK);
    expect(opts[0]).toEqual({
      value: "claude:opus",
      label: "claude:opus",
      hint: t("wizard.model.recommended"),
    });
    expect(opts.map((o) => o.value)).toContain("grok:grok-4.5");
    expect(opts.map((o) => o.value)).toContain("cursor:composer-2.5");
    expect(opts.slice(1).every((o) => o.hint === undefined)).toBe(true);
    expect(opts.some((o) => o.value === "disable")).toBe(false);
  });

  it("advisor gets a 'disable' option last; unavailable CLIs are filtered", () => {
    const diags = [diag("claude", false), diag("grok"), diag("cursor", true, false)];
    const opts = agentPickOptions("advisor", diags);
    expect(opts.map((o) => o.value)).toEqual(["grok:grok-4.5", "disable"]);
    expect(opts[1].label).toBe(t("wizard.agent.disable"));
    expect(agentPickOptions("advisor", []).map((o) => o.value)).toEqual(["disable"]);
    expect(agentPickOptions("executor", [])).toEqual([]);
  });

  it("select sets the role's spec and pops back to settings on that row", () => {
    const s = walk(agentPick(0), ...downs(4), { type: "select" }); // grok:grok-4.5
    expect(s.screen).toBe("settings");
    expect(s.plannerSpec).toEqual({ cli: "grok", model: "grok-4.5" });
    expect(s.cursor).toBe(0); // planner row
    expect(s.stack).toEqual(["preflight"]);
  });

  it("executor select parses cli:model with dots/dashes in the model", () => {
    let s = agentPick(1);
    const idx = visibleOptions(s).findIndex((o) => o.value === "cursor:gpt-5.5-high");
    s = reducer({ ...s, cursor: idx }, { type: "select" });
    expect(s.executorSpec).toEqual({ cli: "cursor", model: "gpt-5.5-high" });
    expect(s.screen).toBe("settings");
    expect(s.cursor).toBe(1); // executor row
  });

  it("advisor: select a combo sets the spec; 'disable' clears it", () => {
    let s = agentPick(2);
    s = reducer({ ...s, cursor: visibleOptions(s).length - 1 }, { type: "select" }); // disable
    expect(s.advisorSpec).toBeNull();
    expect(s.screen).toBe("settings");
    expect(s.cursor).toBe(2); // advisor row
    // reopen: cursor prefilled on "disable"
    const reopened = reducer(s, { type: "select" });
    expect(reopened.screen).toBe("agentPick");
    expect(visibleOptions(reopened)[reopened.cursor].value).toBe("disable");
    // pick a real combo again
    const back = reducer({ ...reopened, cursor: 0 }, { type: "select" });
    expect(back.advisorSpec).toEqual({ cli: "claude", model: "fable" });
  });

  it("cursor prefills on the row's current combo", () => {
    // seeded executor grok:grok-4.5 → index 4 (after claude's 4 models)
    const s = agentPick(1, { saved: { executor: { cli: "grok", model: "grok-4.5" } } });
    expect(visibleOptions(s)[s.cursor].value).toBe("grok:grok-4.5");
    expect(s.cursor).toBe(4);
  });

  it("prefill falls back to 0 when the spec is not in the list or is null", () => {
    const stale = agentPick(0, { saved: { planner: { cli: "claude", model: "zzz" } } });
    expect(stale.cursor).toBe(0);
    const empty = agentPick(0, {}, []); // seeded planner null, no combos
    expect(empty.cursor).toBe(0);
    expect(reducer(empty, { type: "select" })).toBe(empty); // Enter no-ops on an empty list
  });

  it("esc backs out to settings unchanged, cursor on the role's row", () => {
    const s = reducer(agentPick(1), { type: "back" });
    expect(s.screen).toBe("settings");
    expect(s.executorSpec).toEqual({ cli: "claude", model: "sonnet" });
    expect(s.cursor).toBe(1);
    expect(s.stack).toEqual(["preflight"]);
  });

  it("refresh clamps the cursor when the list shrinks", () => {
    const s = { ...agentPick(0), cursor: 10 };
    const shrunk = reducer(s, { type: "refresh", diagnostics: [diag("claude")] });
    expect(shrunk.cursor).toBe(3); // claude's 4 planner models
    expect(reducer(s, { type: "refresh", diagnostics: [] }).cursor).toBe(0);
  });
});

describe("action", () => {
  it("CREATE_NEW opens the studio with a null prdPath", () => {
    const s = studioNew();
    expect(s.screen).toBe("studio");
    expect(s.prdPath).toBeNull();
    expect(s.done).toBeNull();
  });

  it("CREATE_NEW clears a stale prdPath from an abandoned filepick", () => {
    const back2 = walk(refineOrRun(), { type: "back" }, { type: "back" }); // → action
    expect(back2.screen).toBe("action");
    expect(back2.prdPath).toBe("/w/sub/x.json");
    expect(reducer(back2, { type: "select" }).prdPath).toBeNull();
  });

  it("SELECT_EXISTING opens filepick with a fresh query", () => {
    const s = walk({ ...action(), filepickQuery: "stale" }, { type: "down" }, { type: "select" });
    expect(s.screen).toBe("filepick");
    expect(s.filepickQuery).toBe("");
    expect(s.cursor).toBe(0);
  });

  it("back returns to settings", () => {
    expect(reducer(action(), { type: "back" }).screen).toBe("settings");
  });
});

describe("filepick", () => {
  it("setQuery updates the query and resets the cursor", () => {
    const s = walk(filepick(), { type: "down" }, { type: "setQuery", query: "prd" });
    expect(s.filepickQuery).toBe("prd");
    expect(s.cursor).toBe(0);
  });

  it("select is a no-op (Enter dispatches pickFile instead)", () => {
    const s = filepick();
    expect(reducer(s, { type: "select" })).toBe(s);
  });

  it("pickFile sets prdPath and opens refineOrRun", () => {
    const s = refineOrRun("/x/prd.json");
    expect(s.screen).toBe("refineOrRun");
    expect(s.prdPath).toBe("/x/prd.json");
    expect(s.done).toBeNull();
    expect(s.stack).toEqual(["preflight", "settings", "action", "filepick"]);
  });

  it("pickFile is ignored off the filepick screen", () => {
    const s = action();
    expect(reducer(s, { type: "pickFile", path: "/x" })).toBe(s);
  });

  it("back returns to action", () => {
    expect(reducer(filepick(), { type: "back" }).screen).toBe("action");
  });
});

describe("refineOrRun", () => {
  it("refine opens the studio keeping prdPath", () => {
    const s = reducer(refineOrRun("/x/prd.json"), { type: "select" });
    expect(s.screen).toBe("studio");
    expect(s.prdPath).toBe("/x/prd.json");
    expect(s.done).toBeNull();
  });

  it("run resolves immediately with run:true", () => {
    const s = walk(refineOrRun("/x/prd.json"), { type: "down" }, { type: "select" });
    expect(s.done).toEqual({ type: "result", prdPath: "/x/prd.json", run: true });
  });

  it("back returns to filepick", () => {
    expect(reducer(refineOrRun(), { type: "back" }).screen).toBe("filepick");
  });
});

describe("prdInvalid (run-it-now validation failure)", () => {
  // run selected → done pending, then the mount gate rejects the file
  const ran = (): WizardState => walk(refineOrRun("/w/sub/x.json"), { type: "down" }, { type: "select" });

  it("parseable: stays on refineOrRun, cancels done, records the errors", () => {
    const s = reducer(ran(), { type: "prdInvalid", errors: ["e1", "e2"], parseable: true });
    expect(s.screen).toBe("refineOrRun");
    expect(s.done).toBeNull();
    expect(s.prdErrors).toEqual(["e1", "e2"]);
    expect(s.cursor).toBe(0);
  });

  it("error state collapses the options to refine only (run removed)", () => {
    const s = reducer(ran(), { type: "prdInvalid", errors: ["e"], parseable: true });
    expect(visibleOptions(s).map((o) => o.value)).toEqual(["refine"]);
    expect(visibleOptions(s)[0].label).toBe(t("wizard.refine.studio"));
  });

  it("unparseable: pops the stack back to filepick with the error kept", () => {
    const s = reducer(ran(), { type: "prdInvalid", errors: ["bad json"], parseable: false });
    expect(s.screen).toBe("filepick");
    expect(s.stack).toEqual(["preflight", "settings", "action"]);
    expect(s.prdErrors).toEqual(["bad json"]);
    expect(s.done).toBeNull();
  });

  it("unparseable without filepick in the stack bottoms out at the last screen", () => {
    const odd = { ...ran(), stack: ["preflight" as const] };
    const s = reducer(odd, { type: "prdInvalid", errors: ["e"], parseable: false });
    expect(s.screen).toBe("preflight");
    expect(s.stack).toEqual([]);
  });

  it("refine from the error state clears it and opens the studio", () => {
    const err = reducer(ran(), { type: "prdInvalid", errors: ["e"], parseable: true });
    const s = reducer(err, { type: "select" }); // cursor 0 = refine (only option)
    expect(s.screen).toBe("studio");
    expect(s.prdErrors).toBeNull();
    expect(s.prdPath).toBe("/w/sub/x.json");
  });

  it("back clears the error state", () => {
    const err = reducer(ran(), { type: "prdInvalid", errors: ["e"], parseable: true });
    const s = reducer(err, { type: "back" });
    expect(s.screen).toBe("filepick");
    expect(s.prdErrors).toBeNull();
  });

  it("pickFile of a fresh file clears the error state", () => {
    const err = reducer(ran(), { type: "prdInvalid", errors: ["bad json"], parseable: false });
    const s = reducer(err, { type: "pickFile", path: "/w/other.json" });
    expect(s.screen).toBe("refineOrRun");
    expect(s.prdErrors).toBeNull();
    expect(s.prdPath).toBe("/w/other.json");
  });

  it("typing in filepick clears the error state", () => {
    const err = reducer(ran(), { type: "prdInvalid", errors: ["bad json"], parseable: false });
    const s = reducer(err, { type: "setQuery", query: "p" });
    expect(s.prdErrors).toBeNull();
    expect(s.filepickQuery).toBe("p");
  });
});

describe("studio + saveAs", () => {
  it("studio: select and back are no-ops (PrdApp owns input)", () => {
    const s = studioNew();
    expect(reducer(s, { type: "select" })).toBe(s);
    expect(reducer(s, { type: "back" })).toBe(s);
  });

  it("openSaveAs defaults to prd.json for a new PRD", () => {
    const s = reducer(studioNew(), { type: "openSaveAs", build: false });
    expect(s.screen).toBe("saveAs");
    expect(s.saveAsInput).toBe("prd.json");
    expect(s.pendingBuild).toBe(false);
  });

  it("openSaveAs defaults to the existing PRD's cwd-relative path", () => {
    const refined = reducer(refineOrRun("/w/sub/x.json"), { type: "select" });
    const s = reducer(refined, { type: "openSaveAs", build: true });
    expect(s.saveAsInput).toBe("sub/x.json");
    expect(s.pendingBuild).toBe(true);
  });

  it("openSaveAs is a no-op off the studio screen", () => {
    const s = settings();
    expect(reducer(s, { type: "openSaveAs", build: false })).toBe(s);
  });

  it("saveAsInput edits the buffer only on the saveAs screen", () => {
    const saveAs = reducer(studioNew(), { type: "openSaveAs", build: false });
    expect(reducer(saveAs, { type: "saveAsInput", value: "my.json" }).saveAsInput).toBe("my.json");
    const studio = studioNew();
    expect(reducer(studio, { type: "saveAsInput", value: "x" })).toBe(studio);
  });

  it("saveAsConfirm trims, remembers savedPath and returns to the studio", () => {
    const saveAs = reducer(studioNew(), { type: "openSaveAs", build: false });
    const s = walk(saveAs, { type: "saveAsInput", value: "  my.json  " }, { type: "saveAsConfirm" });
    expect(s.savedPath).toBe("my.json");
    expect(s.screen).toBe("studio");
    expect(s.pendingBuild).toBe(false);
    expect(s.done).toBeNull(); // plain save: no resolution
  });

  it("saveAsConfirm with pendingBuild resolves run:true (CONSTRUIR)", () => {
    const saveAs = reducer(studioNew(), { type: "openSaveAs", build: true });
    const s = reducer(saveAs, { type: "saveAsConfirm" }); // default "prd.json"
    expect(s.savedPath).toBe("prd.json");
    expect(s.done).toEqual({ type: "result", prdPath: "prd.json", run: true });
    expect(s.pendingBuild).toBe(false);
  });

  it("saveAsConfirm with an empty/whitespace buffer is a no-op", () => {
    const saveAs = reducer(studioNew(), { type: "openSaveAs", build: true });
    const blank = reducer(saveAs, { type: "saveAsInput", value: "   " });
    expect(reducer(blank, { type: "saveAsConfirm" })).toBe(blank);
  });

  it("saveAsConfirm/saveAsCancel are no-ops off the saveAs screen", () => {
    const studio = studioNew();
    expect(reducer(studio, { type: "saveAsConfirm" })).toBe(studio);
    expect(reducer(studio, { type: "saveAsCancel" })).toBe(studio);
  });

  it("saveAsCancel discards the buffer and pendingBuild", () => {
    const saveAs = walk(
      reducer(studioNew(), { type: "openSaveAs", build: true }),
      { type: "saveAsInput", value: "typed.json" },
    );
    const s = reducer(saveAs, { type: "saveAsCancel" });
    expect(s.screen).toBe("studio");
    expect(s.pendingBuild).toBe(false);
    expect(s.saveAsInput).toBe("");
    expect(s.savedPath).toBeNull();
  });

  it("back is a no-op on saveAs (esc dispatches saveAsCancel)", () => {
    const saveAs = reducer(studioNew(), { type: "openSaveAs", build: false });
    expect(reducer(saveAs, { type: "back" })).toBe(saveAs);
  });

  it("saveFailed forgets the bad savedPath and a pending done (CONSTRUIR write threw)", () => {
    const confirmed = walk(
      studioNew(),
      { type: "openSaveAs", build: true },
      { type: "saveAsConfirm" }, // savedPath + done run:true set together
    );
    const s = reducer(confirmed, { type: "saveFailed" });
    expect(s.savedPath).toBeNull();
    expect(s.done).toBeNull();
    expect(s.screen).toBe("studio"); // studio session survives
  });
});

describe("first-run language screen", () => {
  const first = (systemLocale: "en" | "pt-br" = "en") => state({ hasUserConfig: false, systemLocale });

  it("shows when no global config exists, cursor on the system locale", () => {
    expect(first().screen).toBe("language");
    expect(first().cursor).toBe(0);
    expect(first("pt-br").cursor).toBe(1);
    expect(visibleOptions(first()).map((o) => o.value)).toEqual(["en", "pt-br"]);
    expect(visibleOptions(first()).map((o) => o.label)).toEqual(["English", "Português (Brasil)"]);
    expect(canProceed(first())).toBe(true);
  });

  it("select stores the language and advances to preflight", () => {
    const s = walk(first(), { type: "down" }, { type: "select" });
    expect(s.language).toBe("pt-br");
    expect(s.screen).toBe("preflight");
    expect(s.stack).toEqual(["language"]);
  });

  it("back from preflight returns to language; quit works from language", () => {
    const s = reducer(first(), { type: "select" });
    expect(s.language).toBe("en");
    expect(reducer(s, { type: "back" }).screen).toBe("language");
    expect(reducer(first(), { type: "quit" }).done).toEqual({ type: "quit" });
  });
});

describe("quit", () => {
  it("sets done=quit from every screen", () => {
    const screens: WizardState[] = [
      state(),
      settings(),
      agentPick(2),
      action(),
      filepick(),
      refineOrRun(),
      studioNew(), // studio without a savedPath
      reducer(studioNew(), { type: "openSaveAs", build: false }), // saveAs
    ];
    for (const s of screens) {
      expect(reducer(s, { type: "quit" }).done).toEqual({ type: "quit" });
    }
  });

  it("quit from the studio AFTER a save resolves run:false with the saved path", () => {
    const saved = walk(
      studioNew(),
      { type: "openSaveAs", build: false },
      { type: "saveAsConfirm" }, // default prd.json
    );
    const s = reducer(saved, { type: "quit" });
    expect(s.done).toEqual({ type: "result", prdPath: "prd.json", run: false });
  });
});
