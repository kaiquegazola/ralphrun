// wizardController.test.ts — every screen transition (forward/back/quit),
// refresh payloads, filepick trio, overwrite confirm/deny, cursor clamping,
// selectors, and the CLI_OPTIONS/MODELS/getModelOptions tables moved in
// from wizard.ts.
import { describe, it, expect } from "vitest";
import type { AgentDiagnostic } from "../../diagnostics.js";
import { t } from "../../i18n.js";
import {
  CLI_OPTIONS,
  MODELS,
  getModelOptions,
  initialWizardState,
  reducer,
  visibleOptions,
  canProceed,
  headerLabel,
  type Screen,
  type WizardAction,
  type WizardInit,
  type WizardState,
} from "./wizardController.js";

function mkInit(over: Partial<WizardInit> = {}): WizardInit {
  return {
    prdPathNew: "/w/prd.json",
    cfgPathNew: "/w/ralph.config.json",
    newPrdExists: false,
    newCfgExists: false,
    force: false,
    fromRootFallback: false,
    cwd: "/w",
    hasUserConfig: true, // most tests start on preflight; language tests flip this
    systemLocale: "en",
    saved: {},
    ...over,
  };
}

function diag(cli: string, installed = true, loggedIn: boolean | "unknown" = true): AgentDiagnostic {
  return { cli, installed, loggedIn, loginCommand: `${cli} login` };
}

const ALL_OK = [diag("claude"), diag("grok", true, "unknown"), diag("cursor")];

function state(over: Partial<WizardInit> = {}, diags = ALL_OK): WizardState {
  return initialWizardState(mkInit(over), diags);
}

function walk(s: WizardState, ...actions: WizardAction[]): WizardState {
  return actions.reduce(reducer, s);
}

// select → action → CREATE_NEW → cli/model screens up to `upTo`.
function atScreen(upTo: Screen, over: Partial<WizardInit> = {}): WizardState {
  const path: Record<string, WizardAction[]> = {
    preflight: [],
    action: [{ type: "select" }],
    plannerCli: [{ type: "select" }, { type: "select" }],
    plannerModel: [{ type: "select" }, { type: "select" }, { type: "select" }],
    executorCli: [{ type: "select" }, { type: "select" }, { type: "select" }, { type: "select" }],
    executorModel: Array(5).fill({ type: "select" }),
    advisorCli: Array(6).fill({ type: "select" }),
    advisorModel: [...Array(6).fill({ type: "select" }), { type: "down" }, { type: "select" }],
    commit: Array(7).fill({ type: "select" }), // advisorCli cursor 0 = "none" → commit
  };
  return walk(state(over), ...path[upTo]);
}

describe("moved tables", () => {
  it("CLI_OPTIONS lists claude/grok/cursor", () => {
    expect(CLI_OPTIONS.map((o) => o.value)).toEqual(["claude", "grok", "cursor"]);
  });

  it("MODELS covers every CLI in CLI_OPTIONS", () => {
    for (const o of CLI_OPTIONS) expect(MODELS[o.value].length).toBeGreaterThan(0);
  });

  it("getModelOptions puts the recommended model first with a hint", () => {
    const cases: [Parameters<typeof getModelOptions>[0], string, string][] = [
      ["planner", "claude", "opus"],
      ["executor", "claude", "sonnet"],
      ["advisor", "claude", "fable"],
      ["planner", "cursor", "opus-4.8"],
      ["executor", "cursor", "sonnet-5"],
      ["advisor", "cursor", "opus-4.8"],
      ["planner", "grok", "grok-4.5"],
    ];
    for (const [role, cli, recommended] of cases) {
      const opts = getModelOptions(role, cli);
      expect(opts[0].value).toBe(recommended);
      expect(opts[0].hint).toBe(t("wizard.model.recommended"));
      expect(opts.slice(1).every((o) => o.hint === undefined)).toBe(true);
      expect(opts.length).toBe(MODELS[cli].length);
    }
  });

  it("getModelOptions returns [] for an unknown cli", () => {
    expect(getModelOptions("planner", "nope")).toEqual([]);
  });
});

describe("initial state + selectors", () => {
  it("starts on preflight with everything null", () => {
    const s = state();
    expect(s.screen).toBe("preflight");
    expect(s.stack).toEqual([]);
    expect(s.cursor).toBe(0);
    expect(s.language).toBeNull();
    expect(s.diagnostics).toBe(ALL_OK);
    expect(s.actionChoice).toBeNull();
    expect(s.prdPath).toBeNull();
    expect(s.filepickQuery).toBe("");
    expect(s.plannerSpec).toBeNull();
    expect(s.executorSpec).toBeNull();
    expect(s.advisorSpec).toBeNull();
    expect(s.commit).toBeNull();
    expect(s.needsOverwrite).toBeNull();
    expect(s.done).toBeNull();
  });

  it("visibleOptions per screen", () => {
    expect(visibleOptions(state())).toEqual([]); // preflight
    const action = atScreen("action");
    expect(visibleOptions(action).map((o) => o.value)).toEqual(["CREATE_NEW", "SELECT_EXISTING"]);
    const filepick = walk(action, { type: "down" }, { type: "select" });
    expect(visibleOptions(filepick)).toEqual([]); // filepick is component-owned
    const overwrite = walk(state({ newPrdExists: true }), { type: "select" }, { type: "select" });
    expect(visibleOptions(overwrite).map((o) => o.value)).toEqual(["yes", "no"]);
    expect(visibleOptions(atScreen("plannerCli")).map((o) => o.value)).toEqual(["claude", "grok", "cursor"]);
    expect(visibleOptions(atScreen("plannerModel"))).toEqual(getModelOptions("planner", "claude"));
    expect(visibleOptions(atScreen("executorModel"))).toEqual(getModelOptions("executor", "claude"));
    expect(visibleOptions(atScreen("advisorCli"))[0]).toEqual({ value: "none", label: t("wizard.advisor.none") });
    expect(visibleOptions(atScreen("advisorModel"))).toEqual(getModelOptions("advisor", "claude"));
    expect(visibleOptions(atScreen("commit")).map((o) => o.value)).toEqual(["yes", "no"]);
    const studio = walk(atScreen("commit"), { type: "select" });
    expect(visibleOptions(studio)).toEqual([]);
  });

  it("cli screens filter out not-installed and not-logged-in CLIs, keep 'unknown'", () => {
    const diags = [diag("claude", false), diag("grok", true, "unknown"), diag("cursor", true, false)];
    const s = { ...atScreen("plannerCli"), diagnostics: diags };
    expect(visibleOptions(s).map((o) => o.value)).toEqual(["grok"]);
    const adv = { ...atScreen("advisorCli"), diagnostics: diags };
    expect(visibleOptions(adv).map((o) => o.value)).toEqual(["none", "grok"]);
  });

  it("canProceed reflects visibleOptions", () => {
    expect(canProceed(state())).toBe(false); // preflight
    expect(canProceed(atScreen("action"))).toBe(true);
    expect(canProceed({ ...atScreen("plannerCli"), diagnostics: [] })).toBe(false);
  });

  it("headerLabel maps screens to setup steps and studio", () => {
    expect(headerLabel(state())).toBe("setup 1/7");
    expect(headerLabel(atScreen("action"))).toBe("setup 2/7");
    const filepick = walk(atScreen("action"), { type: "down" }, { type: "select" });
    expect(headerLabel(filepick)).toBe("setup 2/7"); // inherits step 2
    const overwrite = walk(state({ newCfgExists: true }), { type: "select" }, { type: "select" });
    expect(headerLabel(overwrite)).toBe("setup 2/7");
    expect(headerLabel(atScreen("plannerCli"))).toBe("setup 3/7");
    expect(headerLabel(atScreen("plannerModel"))).toBe("setup 3/7");
    expect(headerLabel(atScreen("executorCli"))).toBe("setup 4/7");
    expect(headerLabel(atScreen("executorModel"))).toBe("setup 4/7");
    expect(headerLabel(atScreen("advisorCli"))).toBe("setup 5/7");
    expect(headerLabel(atScreen("advisorModel"))).toBe("setup 5/7");
    expect(headerLabel(atScreen("commit"))).toBe("setup 6/7");
    expect(headerLabel(walk(atScreen("commit"), { type: "select" }))).toBe("studio");
  });
});

describe("cursor movement", () => {
  it("up/down clamp at list edges", () => {
    let s = atScreen("action"); // 2 options
    expect(reducer(s, { type: "up" }).cursor).toBe(0); // clamp at top
    s = walk(s, { type: "down" }, { type: "down" }, { type: "down" });
    expect(s.cursor).toBe(1); // clamp at bottom
    expect(reducer(s, { type: "up" }).cursor).toBe(0);
  });

  it("down on filepick is unclamped (the view owns the file list)", () => {
    const s = walk(atScreen("action"), { type: "down" }, { type: "select" });
    expect(walk(s, { type: "down" }, { type: "down" }, { type: "down" }).cursor).toBe(3);
    expect(reducer(s, { type: "up" }).cursor).toBe(0);
  });
});

describe("preflight", () => {
  it("select advances to action and pushes the stack", () => {
    const s = reducer(state(), { type: "select" });
    expect(s.screen).toBe("action");
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

describe("action", () => {
  it("CREATE_NEW with nothing on disk goes straight to plannerCli", () => {
    const s = reducer(atScreen("action"), { type: "select" });
    expect(s.screen).toBe("plannerCli");
    expect(s.actionChoice).toBe("CREATE_NEW");
    expect(s.prdPath).toBe("/w/prd.json");
    expect(s.needsOverwrite).toBeNull();
    expect(s.stack).toEqual(["preflight", "action"]);
  });

  it("CREATE_NEW with existing files routes through overwrite naming them", () => {
    const both = walk(state({ newPrdExists: true, newCfgExists: true }), { type: "select" }, { type: "select" });
    expect(both.screen).toBe("overwrite");
    expect(both.needsOverwrite).toEqual({ prd: true, cfg: true });
    const prdOnly = walk(state({ newPrdExists: true }), { type: "select" }, { type: "select" });
    expect(prdOnly.needsOverwrite).toEqual({ prd: true, cfg: false });
    const cfgOnly = walk(state({ newCfgExists: true }), { type: "select" }, { type: "select" });
    expect(cfgOnly.needsOverwrite).toEqual({ prd: false, cfg: true });
  });

  it("CREATE_NEW with force skips the overwrite screen", () => {
    const s = walk(state({ newPrdExists: true, newCfgExists: true, force: true }), { type: "select" }, { type: "select" });
    expect(s.screen).toBe("plannerCli");
  });

  it("SELECT_EXISTING opens filepick with a fresh query", () => {
    const s = walk({ ...atScreen("action"), filepickQuery: "stale" }, { type: "down" }, { type: "select" });
    expect(s.screen).toBe("filepick");
    expect(s.actionChoice).toBe("SELECT_EXISTING");
    expect(s.filepickQuery).toBe("");
    expect(s.cursor).toBe(0);
  });
});

describe("filepick", () => {
  const filepick = (over: Partial<WizardInit> = {}) =>
    walk(state(over), { type: "select" }, { type: "down" }, { type: "select" });

  it("setQuery updates the query and resets the cursor", () => {
    const s = walk(filepick(), { type: "down" }, { type: "setQuery", query: "prd" });
    expect(s.filepickQuery).toBe("prd");
    expect(s.cursor).toBe(0);
  });

  it("select is a no-op (Enter dispatches pickFile instead)", () => {
    const s = filepick();
    expect(reducer(s, { type: "select" })).toBe(s);
  });

  it("pickFile + fromRootFallback + existing cfg resolves useExisting immediately", () => {
    const s = reducer(filepick({ fromRootFallback: true }), { type: "pickFile", path: "/x/prd.json", cfgExists: true });
    expect(s.done).toEqual({ type: "useExisting", prdPath: "/x/prd.json" });
    expect(s.prdPath).toBe("/x/prd.json");
    expect(s.screen).toBe("filepick"); // no further transition
  });

  it("pickFile + fromRootFallback but no cfg continues the normal setup", () => {
    const s = reducer(filepick({ fromRootFallback: true }), { type: "pickFile", path: "/x/prd.json", cfgExists: false });
    expect(s.screen).toBe("plannerCli");
    expect(s.done).toBeNull();
  });

  it("pickFile with existing cfg (no force) routes through overwrite", () => {
    const s = reducer(filepick(), { type: "pickFile", path: "/x/prd.json", cfgExists: true });
    expect(s.screen).toBe("overwrite");
    expect(s.prdPath).toBe("/x/prd.json");
    expect(s.needsOverwrite).toEqual({ prd: false, cfg: true });
    expect(s.done).toBeNull();
  });

  it("pickFile with existing cfg + force goes straight to plannerCli", () => {
    const s = reducer(filepick({ force: true }), { type: "pickFile", path: "/x/prd.json", cfgExists: true });
    expect(s.screen).toBe("plannerCli");
  });

  it("pickFile with no cfg goes straight to plannerCli", () => {
    const s = reducer(filepick(), { type: "pickFile", path: "/x/prd.json", cfgExists: false });
    expect(s.screen).toBe("plannerCli");
    expect(s.prdPath).toBe("/x/prd.json");
  });

  it("pickFile is ignored off the filepick screen", () => {
    const s = atScreen("action");
    expect(reducer(s, { type: "pickFile", path: "/x", cfgExists: false })).toBe(s);
  });

  it("back returns to action", () => {
    const s = reducer(filepick(), { type: "back" });
    expect(s.screen).toBe("action");
    expect(s.stack).toEqual(["preflight"]);
  });
});

describe("overwrite", () => {
  const overwrite = () => walk(state({ newPrdExists: true }), { type: "select" }, { type: "select" });

  it("confirm proceeds to plannerCli", () => {
    const s = reducer(overwrite(), { type: "confirm" });
    expect(s.screen).toBe("plannerCli");
    expect(s.stack).toEqual(["preflight", "action", "overwrite"]);
  });

  it("deny quits without writing", () => {
    expect(reducer(overwrite(), { type: "deny" }).done).toEqual({ type: "quit" });
  });

  it("select maps cursor 0/1 onto confirm/deny", () => {
    expect(reducer(overwrite(), { type: "select" }).screen).toBe("plannerCli");
    expect(walk(overwrite(), { type: "down" }, { type: "select" }).done).toEqual({ type: "quit" });
  });

  it("confirm/deny are no-ops off the overwrite screen", () => {
    const s = atScreen("action");
    expect(reducer(s, { type: "confirm" })).toBe(s);
    expect(reducer(s, { type: "deny" })).toBe(s);
  });

  it("back pops to where the overwrite came from (action or filepick)", () => {
    expect(reducer(overwrite(), { type: "back" }).screen).toBe("action");
    const viaPick = walk(
      state(),
      { type: "select" },
      { type: "down" },
      { type: "select" },
      { type: "pickFile", path: "/x/prd.json", cfgExists: true },
    );
    expect(reducer(viaPick, { type: "back" }).screen).toBe("filepick");
  });
});

describe("cli + model screens", () => {
  it("plannerCli select stores the cli and opens plannerModel", () => {
    const s = walk(atScreen("plannerCli"), { type: "down" }, { type: "select" });
    expect(s.screen).toBe("plannerModel");
    expect(s.plannerSpec).toEqual({ cli: "grok", model: "" });
    expect(s.cursor).toBe(0);
  });

  it("plannerModel select completes plannerSpec and opens executorCli", () => {
    const s = reducer(atScreen("plannerModel"), { type: "select" });
    expect(s.screen).toBe("executorCli");
    expect(s.plannerSpec).toEqual({ cli: "claude", model: "opus" }); // recommended is first
  });

  it("executorCli/executorModel mirror the planner flow", () => {
    let s = reducer(atScreen("executorCli"), { type: "select" });
    expect(s.screen).toBe("executorModel");
    expect(s.executorSpec).toEqual({ cli: "claude", model: "" });
    s = walk(s, { type: "down" }, { type: "select" });
    expect(s.screen).toBe("advisorCli");
    expect(s.executorSpec).toEqual({ cli: "claude", model: "opus" }); // sonnet first, opus second
  });

  it("Enter no-ops on an empty cli list (planner and executor)", () => {
    const planner = { ...atScreen("plannerCli"), diagnostics: [] };
    expect(reducer(planner, { type: "select" })).toBe(planner);
    const executor = { ...atScreen("executorCli"), diagnostics: [] };
    expect(reducer(executor, { type: "select" })).toBe(executor);
  });

  it("advisorCli 'none' skips advisorModel and sets the sentinel spec", () => {
    const s = reducer(atScreen("advisorCli"), { type: "select" }); // cursor 0 = none
    expect(s.screen).toBe("commit");
    expect(s.advisorSpec).toEqual({ cli: "none", model: "" });
  });

  it("advisorCli with a real cli opens advisorModel, then select completes the spec", () => {
    let s = walk(atScreen("advisorCli"), { type: "down" }, { type: "select" });
    expect(s.screen).toBe("advisorModel");
    expect(s.advisorSpec).toEqual({ cli: "claude", model: "" });
    s = reducer(s, { type: "select" });
    expect(s.screen).toBe("commit");
    expect(s.advisorSpec).toEqual({ cli: "claude", model: "fable" });
  });

  it("refresh on a cli screen clamps the cursor when the list shrinks", () => {
    const s = walk(atScreen("plannerCli"), { type: "down" }, { type: "down" }); // cursor 2
    const shrunk = reducer(s, { type: "refresh", diagnostics: [diag("claude")] });
    expect(shrunk.diagnostics).toEqual([diag("claude")]);
    expect(shrunk.cursor).toBe(0);
    const gone = reducer(s, { type: "refresh", diagnostics: [] });
    expect(gone.cursor).toBe(0); // empty list still clamps to 0
  });

  it("back walks model → cli → previous screen", () => {
    let s = atScreen("plannerModel");
    s = reducer(s, { type: "back" });
    expect(s.screen).toBe("plannerCli");
    s = reducer(s, { type: "back" });
    expect(s.screen).toBe("action");
  });
});

describe("commit + studio", () => {
  it("commit yes proceeds to studio with done=proceed", () => {
    const s = reducer(atScreen("commit"), { type: "select" });
    expect(s.commit).toBe(true);
    expect(s.screen).toBe("studio");
    expect(s.done).toEqual({ type: "proceed" });
  });

  it("commit no still proceeds, with commit=false", () => {
    const s = walk(atScreen("commit"), { type: "down" }, { type: "select" });
    expect(s.commit).toBe(false);
    expect(s.done).toEqual({ type: "proceed" });
  });

  it("studio has no back and select no-ops (PrdApp owns input)", () => {
    const studio = reducer(atScreen("commit"), { type: "select" });
    expect(reducer(studio, { type: "back" })).toBe(studio);
    expect(reducer(studio, { type: "select" })).toBe(studio);
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
    expect(headerLabel(first())).toBe(t("wizard.header.setup", { n: 1 }));
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

describe("prefill from saved global defaults", () => {
  it("plannerCli + plannerModel land the cursor on the saved spec", () => {
    const over = { saved: { planner: { cli: "claude", model: "fable" } } };
    let s = walk(state(over), { type: "select" }, { type: "select" }); // → plannerCli
    expect(s.cursor).toBe(0); // claude
    s = reducer(s, { type: "select" }); // → plannerModel (claude)
    expect(s.cursor).toBe(2); // [opus, sonnet, fable, haiku]
    expect(visibleOptions(s)[s.cursor].value).toBe("fable");
  });

  it("saved model not in the list falls back to cursor 0", () => {
    const over = { saved: { planner: { cli: "claude", model: "zzz" } } };
    const s = walk(state(over), { type: "select" }, { type: "select" }, { type: "select" });
    expect(s.screen).toBe("plannerModel");
    expect(s.cursor).toBe(0);
  });

  it("executorCli pre-selects the saved cli; mismatched cli skips the model prefill", () => {
    const over = { saved: { executor: { cli: "cursor", model: "gpt-5.5" } } };
    let s = walk(state(over), ...Array<WizardAction>(4).fill({ type: "select" })); // → executorCli
    expect(s.cursor).toBe(2); // cursor cli
    // follow the prefill: select cursor → executorModel prefilled on gpt-5.5
    const followed = reducer(s, { type: "select" });
    expect(visibleOptions(followed)[followed.cursor].value).toBe("gpt-5.5");
    // ignore the prefill: pick claude instead → saved cursor model doesn't apply
    s = walk(s, { type: "up" }, { type: "up" }, { type: "select" });
    expect(s.screen).toBe("executorModel");
    expect(s.executorSpec).toEqual({ cli: "claude", model: "" });
    expect(s.cursor).toBe(0);
  });

  it("advisorCli pre-selects the saved cli, saved null pre-selects 'none'", () => {
    const withSpec = { saved: { advisor: { cli: "cursor", model: "opus-4.8" } } };
    let s = walk(state(withSpec), ...Array<WizardAction>(6).fill({ type: "select" })); // → advisorCli
    expect(s.cursor).toBe(3); // [none, claude, grok, cursor]
    s = reducer(s, { type: "select" }); // → advisorModel prefilled
    expect(visibleOptions(s)[s.cursor].value).toBe("opus-4.8");

    const withNull = walk(
      state({ saved: { advisor: null } }),
      ...Array<WizardAction>(6).fill({ type: "select" }),
    );
    expect(withNull.screen).toBe("advisorCli");
    expect(withNull.cursor).toBe(0); // "none"
  });

  it("advisorModel prefill is skipped when the chosen cli differs from the saved one", () => {
    const over = { saved: { advisor: { cli: "cursor", model: "opus-4.8" } } };
    let s = walk(state(over), ...Array<WizardAction>(6).fill({ type: "select" })); // advisorCli, cursor 3
    s = walk(s, { type: "up" }, { type: "up" }, { type: "select" }); // pick claude instead
    expect(s.screen).toBe("advisorModel");
    expect(s.advisorSpec).toEqual({ cli: "claude", model: "" });
    expect(s.cursor).toBe(0);
  });
});

describe("quit", () => {
  it("sets done=quit from every screen", () => {
    const screens: WizardState[] = [
      state(),
      atScreen("action"),
      walk(atScreen("action"), { type: "down" }, { type: "select" }), // filepick
      walk(state({ newCfgExists: true }), { type: "select" }, { type: "select" }), // overwrite
      atScreen("plannerCli"),
      atScreen("plannerModel"),
      atScreen("executorCli"),
      atScreen("executorModel"),
      atScreen("advisorCli"),
      atScreen("advisorModel"),
      atScreen("commit"),
      walk(atScreen("commit"), { type: "select" }), // studio
    ];
    for (const s of screens) {
      expect(reducer(s, { type: "quit" }).done).toEqual({ type: "quit" });
    }
  });
});
