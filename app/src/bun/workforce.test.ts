// workforce.test.ts — the roster is a to-do list when something is wrong, so
// what matters is the triage: who is actually usable, who needs one command,
// and in which order the rows land. The core's probes are mocked; the
// decisions on top of them are the subject.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentDiagnostic } from "../../../src/diagnostics.js";

const checkAgent = vi.fn<(cli: string) => AgentDiagnostic>();
const browserStatus = vi.fn<() => "ok" | "broken" | "missing">();
const activeRuns = vi.fn<() => unknown[]>();
const agentClis: string[] = [];
const defs = new Map<string, unknown>();

vi.mock("../../../src/agents.js", () => ({
  AGENTS: { claude: {}, codex: {} },
  agentClis,
  agentDef: (cli: string) => defs.get(cli),
  binOf: (cli: string) => `${cli}-bin`,
  defaultModelOf: () => "fallback-model",
}));
vi.mock("../../../src/browser.js", () => ({
  BROWSER_INSTALL_HINT: "instale o dev-browser",
  browserStatus,
}));
vi.mock("../../../src/diagnostics.js", () => ({ checkAgent }));
vi.mock("./runs.ts", () => ({ activeRuns }));

const { workforce } = await import("./workforce.ts");

/** the shape agentDef hands back, trimmed to what workforce.ts reads */
function def(label: string, models: string[] = [], recommended = models[0] ?? "") {
  return { label, models: models.map((value) => ({ value })), recommended: { executor: recommended } };
}

function diag(cli: string, over: Partial<AgentDiagnostic> = {}): AgentDiagnostic {
  return { cli, installed: true, loggedIn: true, ...over };
}

function roster(clis: string[]) {
  agentClis.length = 0;
  agentClis.push(...clis);
}

beforeEach(() => {
  vi.clearAllMocks();
  defs.clear();
  roster(["claude"]);
  defs.set("claude", def("Claude Code", ["sonnet", "opus"]));
  checkAgent.mockImplementation((cli) => diag(cli));
  activeRuns.mockReturnValue([]);
  browserStatus.mockReturnValue("ok");
});

describe("workforce", () => {
  it("treats an unknown auth probe as logged in", () => {
    // codex, grok, agy and opencode have no headless auth check; reading
    // "unknown" as logged-out would red-flag a perfectly working setup.
    checkAgent.mockImplementation((cli) => diag(cli, { loggedIn: "unknown" }));
    const [agent] = workforce().agents;
    expect(agent.loggedIn).toBe(true);
    expect(agent.hint).toBeNull();
  });

  it("hands a not-installed cli its install command", () => {
    roster(["claude", "cursor"]);
    checkAgent.mockImplementation((cli) => diag(cli, { installed: false, loggedIn: "unknown" }));
    const hints = Object.fromEntries(workforce().agents.map((a) => [a.cli, a.hint]));
    expect(hints.claude).toBe("npm i -g @anthropic-ai/claude-code");
    expect(hints.cursor).toContain("cursor.com/install");
  });

  it("falls back to a generic install line for a cli the hint table never heard of", () => {
    // agent manifests can add clis at runtime; a row with no next step at all
    // is the one state the design refuses to render.
    roster(["homemade"]);
    checkAgent.mockImplementation((cli) => diag(cli, { installed: false, loggedIn: "unknown" }));
    expect(workforce().agents[0].hint).toBe("install homemade-bin");
  });

  it("prefers the login command the probe reported for a logged-out cli", () => {
    checkAgent.mockImplementation((cli) => diag(cli, { loggedIn: false, loginCommand: "claude setup-token" }));
    const [agent] = workforce().agents;
    expect(agent.installed).toBe(true);
    expect(agent.loggedIn).toBe(false);
    expect(agent.hint).toBe("claude setup-token");
  });

  it("invents a login line when the probe reported none", () => {
    checkAgent.mockImplementation((cli) => diag(cli, { loggedIn: false }));
    expect(workforce().agents[0].hint).toBe("claude-bin login");
  });

  it("sorts usable first, broken second, absent last", () => {
    roster(["absent", "broken", "usable", "alsoUsable"]);
    checkAgent.mockImplementation((cli) => {
      if (cli === "absent") return diag(cli, { installed: false, loggedIn: "unknown" });
      if (cli === "broken") return diag(cli, { loggedIn: false });
      return diag(cli);
    });
    // ties break alphabetically so the roster does not reshuffle between polls
    expect(workforce().agents.map((a) => a.cli)).toEqual(["alsoUsable", "usable", "broken", "absent"]);
  });

  it("carries the shared per-cli identity so every screen draws the same badge", () => {
    const [agent] = workforce().agents;
    expect(agent.initials).toBe("cl");
    expect(agent.color).toBe("#f08a63");
    expect(agent.label).toBe("Claude Code");
  });

  it("names the cli itself when no definition supplies a label", () => {
    roster(["homemade"]);
    expect(workforce().agents[0].label).toBe("homemade");
  });

  it("puts the recommended model first and caps the picker at six", () => {
    const many = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    // the recommended one sits LAST in the registry, so slicing before sorting
    // would drop exactly the model the picker is supposed to preselect.
    defs.set("claude", def("Claude Code", many, "m7"));
    const { models } = workforce().agents[0];
    expect(models).toHaveLength(6);
    expect(models[0]).toEqual({ name: "m7", recommended: true });
    // the rest keep their registry order behind it
    expect(models.slice(1).map((m) => m.name)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("falls back to the cli's default model when the def recommends nothing", () => {
    defs.set("claude", { label: "Claude Code", models: [{ value: "fallback-model" }], recommended: {} });
    expect(workforce().agents[0].models[0].recommended).toBe(true);
  });
});

describe("workforce busy counting", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    executor: { cli: "claude", model: "sonnet" },
    advisor: null,
    status: "running",
    doing: 2,
    ...over,
  });

  it("counts the tasks each executor cli is running right now", () => {
    roster(["claude", "codex"]);
    defs.set("codex", def("Codex"));
    activeRuns.mockReturnValue([run(), run({ executor: { cli: "codex" }, doing: 3 })]);
    const busy = Object.fromEntries(workforce().agents.map((a) => [a.cli, a.activeTasks]));
    expect(busy).toEqual({ claude: 2, codex: 3 });
  });

  it("counts a run that reports no task in flight as one — the cli is still occupied", () => {
    activeRuns.mockReturnValue([run({ doing: 0 })]);
    expect(workforce().agents[0].activeTasks).toBe(1);
  });

  it("does not count a QUEUED run — it has no child, so no agent is occupied", () => {
    activeRuns.mockReturnValue([run({ status: "queued" })]);
    expect(workforce().agents[0].activeTasks).toBe(0);
  });

  it("lists an advisor-only cli as present but idle", () => {
    // an advisor reviews, it does not hold a task slot, so it must not inflate
    // the busy count that gates new runs.
    roster(["claude", "codex"]);
    defs.set("codex", def("Codex"));
    activeRuns.mockReturnValue([run({ advisor: { cli: "codex" } })]);
    const busy = Object.fromEntries(workforce().agents.map((a) => [a.cli, a.activeTasks]));
    expect(busy).toEqual({ claude: 2, codex: 0 });
  });
});

describe("workforce browser probe", () => {
  it("reports the browser as ready when the launcher runs", () => {
    expect(workforce().browser).toEqual({
      ok: true,
      label: "browser de teste presente — verify de UI habilitado",
    });
  });

  it("distinguishes an installed-but-dead launcher from a missing one", () => {
    // both block UI verify, but only one is fixed by installing anything.
    browserStatus.mockReturnValue("broken");
    expect(workforce().browser).toEqual({ ok: false, label: "dev-browser instalado mas não executa" });
    browserStatus.mockReturnValue("missing");
    expect(workforce().browser).toEqual({ ok: false, label: "instale o dev-browser" });
  });
});

