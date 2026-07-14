import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '{"project":"x","stack":"s","architecture_notes":"a","tasks":[{"id":"t1","title":"t","description":"d"}]}'),
}));

vi.mock("./diagnostics.js", () => ({ checkAllAgents: vi.fn(() => []) }));
vi.mock("./tui/wizard/mount.js", () => ({ mountWizard: vi.fn() }));
vi.mock("./userconfig.js", () => ({
  userConfigExists: vi.fn(() => false),
  loadUserConfig: vi.fn(() => ({ version: 1 })),
  saveUserConfig: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkAllAgents } from "./diagnostics.js";
import { browserStatusAsync } from "./browser.js";
import { mountWizard, type MountWizardArgs } from "./tui/wizard/mount.js";
import type { WizardState } from "./tui/wizard/wizardController.js";
import { loadUserConfig, saveUserConfig, userConfigExists } from "./userconfig.js";
import { initWizard, defaultScaffold, readCwdConfig } from "./wizard.js";

const mExists = vi.mocked(existsSync);
const mWrite = vi.mocked(writeFileSync);
const mRead = vi.mocked(readFileSync);
const mMount = vi.mocked(mountWizard);
const mUserExists = vi.mocked(userConfigExists);
const mUserLoad = vi.mocked(loadUserConfig);
const mUserSave = vi.mocked(saveUserConfig);

const origTTY = process.stdout.isTTY;

beforeEach(() => {
  vi.clearAllMocks();
  (process.stdout as any).isTTY = true;
  mExists.mockReturnValue(false);
  mMount.mockResolvedValue(null);
  mUserExists.mockReturnValue(false);
  mUserLoad.mockReturnValue({ version: 1 });
  // systemLocale comes from resolveLocale() → Intl; pin it so the suite is
  // deterministic on pt-BR machines.
  vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
    resolvedOptions: () => ({ locale: "en-US" }),
  } as unknown as Intl.DateTimeFormat);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  (process.stdout as any).isTTY = origTTY;
  vi.restoreAllMocks();
});

// no config key: absent --config = "config lives next to the PRD"
const opts = (o: Partial<Parameters<typeof initWizard>[0]> = {}) => ({
  prd: "prd.json",
  ...o,
});

const mountArgs = (): MountWizardArgs => mMount.mock.calls[0][0];

// a save-ready state as the studio would leave it on [s]/CONSTRUIR
const doneState = (over: Partial<WizardState> = {}): WizardState => ({
  ctx: {
    prdPathNew: resolve("prd.json"),
    cfgPathNew: resolve("ralph.config.json"),
    force: false,
    fromRootFallback: false,
    cwd: process.cwd(),
    hasUserConfig: false,
    systemLocale: "en" as const,
    saved: { planner: undefined, executor: undefined, commit_per_task: undefined },
    cwdConfig: null,
  },
  screen: "studio" as const,
  language: null,
  stack: [],
  cursor: 0,
  diagnostics: [],
  prdPath: null,
  filepickQuery: "",
  plannerSpec: { cli: "claude", model: "opus" },
  executorSpec: { cli: "claude", model: "sonnet" },
  advisorSpec: null,
  commit: true,
  agentRole: null,
  savedPath: "prd.json",
  prdErrors: null,
  saveAsInput: "",
  pendingBuild: false,
  done: null,
  ...over,
});

describe("readCwdConfig", () => {
  const read = (json: string) => {
    mExists.mockReturnValue(true);
    mRead.mockReturnValue(json);
    return readCwdConfig("/repo/ralph.config.json");
  };

  it("missing file → null (no read)", () => {
    expect(readCwdConfig("/repo/ralph.config.json")).toBeNull();
    expect(mRead).not.toHaveBeenCalled();
  });

  it("malformed JSON → null", () => {
    expect(read("not json")).toBeNull();
  });

  it("non-object JSON → null (number and null)", () => {
    expect(read("42")).toBeNull();
    expect(read("null")).toBeNull();
  });

  it("keeps executor, explicit advisor:null and commit_per_task", () => {
    expect(read('{"executor":{"cli":"grok","model":"grok-4.5"},"advisor":null,"commit_per_task":false}')).toEqual({
      executor: { cli: "grok", model: "grok-4.5" },
      advisor: null,
      commit_per_task: false,
    });
  });

  it("keeps an advisor spec, drops wrong-shaped fields (key absent, not null)", () => {
    expect(read('{"executor":{"cli":1,"model":"m"},"advisor":{"cli":"claude","model":"fable"},"commit_per_task":"yes"}')).toEqual({
      advisor: { cli: "claude", model: "fable" },
    });
  });

  it("drops null executor, non-object advisor and bad model types", () => {
    expect(read('{"executor":null,"advisor":"x"}')).toEqual({});
    expect(read('{"executor":{"cli":"c","model":2}}')).toEqual({});
  });
});

describe("initWizard TTY path", () => {
  it("computes init flags from fs and passes checkAllAgents through", async () => {
    await initWizard(opts({ force: true, fromRootFallback: true }));
    const a = mountArgs();
    expect(a.init).toEqual({
      prdPathNew: resolve("prd.json"),
      cfgPathNew: resolve("ralph.config.json"),
      force: true,
      fromRootFallback: true,
      cwd: process.cwd(),
      hasUserConfig: false,
      systemLocale: "en",
      // no global advisor default → NO advisor key (seeding falls to recommended)
      saved: { planner: undefined, executor: undefined, commit_per_task: undefined },
      cwdConfig: null,
    });
    expect("advisor" in a.init.saved).toBe(false);
    expect(a.checkAgents).toBe(checkAllAgents);
    expect(a.checkBrowser).toBe(browserStatusAsync);
  });

  it("passes hasUserConfig + saved defaults (advisor null = disabled) through", async () => {
    mUserExists.mockReturnValue(true);
    mUserLoad.mockReturnValue({
      version: 1,
      language: "pt-br",
      default_planner: { cli: "claude", model: "opus" },
      default_executor: { cli: "grok", model: "grok-4.5" },
      default_advisor: null,
      commit_per_task: false,
    });
    await initWizard(opts());
    const a = mountArgs();
    expect(a.init.hasUserConfig).toBe(true);
    expect(a.init.systemLocale).toBe("pt-br"); // resolveLocale prefers the saved language
    expect(a.init.saved).toEqual({
      planner: { cli: "claude", model: "opus" },
      executor: { cli: "grok", model: "grok-4.5" },
      advisor: null,
      commit_per_task: false,
    });
  });

  it("reads ./ralph.config.json into init.cwdConfig", async () => {
    mExists.mockImplementation((p: any) => String(p).endsWith("ralph.config.json"));
    mRead.mockReturnValue('{"executor":{"cli":"cursor","model":"sonnet-5"}}');
    await initWizard(opts());
    expect(mRead).toHaveBeenCalledWith(resolve("ralph.config.json"), "utf8");
    expect(mountArgs().init.cwdConfig).toEqual({ executor: { cli: "cursor", model: "sonnet-5" } });
  });

  it("returns null on quit, writes nothing, no outro", async () => {
    const res = await initWizard(opts());
    expect(res).toBeNull();
    expect(mWrite).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("run:true result prints the Using PRD line and passes the result through", async () => {
    mMount.mockResolvedValue({ prdPath: "/repo/prd.json", run: true });
    const res = await initWizard(opts());
    expect(res).toEqual({ prdPath: "/repo/prd.json", run: true });
    expect(console.log).toHaveBeenCalledWith("Using PRD: /repo/prd.json");
  });

  it("run:false result prints nothing (cli owns the hint)", async () => {
    mMount.mockResolvedValue({ prdPath: "/repo/prd.json", run: false });
    const res = await initWizard(opts());
    expect(res).toEqual({ prdPath: "/repo/prd.json", run: false });
    expect(console.log).not.toHaveBeenCalled();
  });

  it("loadSeed runs the pipeline: parse + normalize + validate", async () => {
    await initWizard(opts());
    const r = mountArgs().loadSeed("/repo/my.json");
    expect(mRead).toHaveBeenCalledWith("/repo/my.json", "utf8");
    // the pipeline fills status/retries/deps/acceptance and flags the cleanup
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toBe(true);
      expect(r.prd.tasks[0]).toMatchObject({ id: "t1", status: "todo", retries: 0, deps: [], acceptance: [] });
    }
    expect(mWrite).not.toHaveBeenCalled(); // seed never writes
  });

  it("loadSeed surfaces parse/validation failures instead of throwing", async () => {
    await initWizard(opts());
    mRead.mockReturnValue("{oops");
    const r = mountArgs().loadSeed("/repo/my.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain("invalid JSON");
      expect(r.prd).toBeUndefined();
    }
  });

  it("loadForRun writes the normalized file back on ok+normalized", async () => {
    await initWizard(opts());
    const r = mountArgs().loadForRun("/repo/my.json");
    expect(r.ok).toBe(true);
    expect(mWrite).toHaveBeenCalledTimes(1);
    const [path, raw] = mWrite.mock.calls[0];
    expect(path).toBe("/repo/my.json");
    expect(JSON.parse(String(raw)).tasks[0]).toMatchObject({ status: "todo", retries: 0 });
    expect(String(raw).endsWith("\n")).toBe(true);
  });

  it("loadForRun does not write when nothing was normalized, nor when invalid", async () => {
    await initWizard(opts());
    mRead.mockReturnValue(JSON.stringify(defaultScaffold()));
    expect(mountArgs().loadForRun("/repo/my.json").ok).toBe(true);
    expect(mWrite).not.toHaveBeenCalled(); // already clean → no write
    mRead.mockReturnValue('{"project":1}');
    const r = mountArgs().loadForRun("/repo/my.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.prd).toBeDefined(); // parseable-but-invalid seeds the studio
    expect(mWrite).not.toHaveBeenCalled(); // invalid → never written
  });

  it("savePrd writes prd + config next to it (advisor disabled → null)", async () => {
    await initWizard(opts());
    const prd = defaultScaffold();
    mountArgs().savePrd(doneState(), prd, "/repo/sub/my.json");
    expect(mWrite).toHaveBeenNthCalledWith(1, "/repo/sub/my.json", JSON.stringify(prd, null, 2) + "\n");
    const [cfgPath, cfgRaw] = mWrite.mock.calls[1];
    expect(cfgPath).toBe(resolve("/repo/sub", "ralph.config.json"));
    const cfg = JSON.parse(String(cfgRaw));
    expect(cfg.executor).toMatchObject({ cli: "claude", model: "sonnet" });
    expect(cfg.advisor).toBeNull();
    expect(cfg.commit_per_task).toBe(true);
    // choices merge-saved into the global config for the next init's prefill
    // (no language: a --lang override must never persist via savePrd)
    expect(mUserSave).toHaveBeenCalledWith({
      default_planner: { cli: "claude", model: "opus" },
      default_executor: { cli: "claude", model: "sonnet" },
      default_advisor: null,
    });
  });

  it("savePrd refuses to write an invalid PRD (validatePrd gate)", async () => {
    await initWizard(opts());
    const invalid = { ...defaultScaffold(), tasks: [] };
    expect(() => mountArgs().savePrd(doneState(), invalid, "/repo/my.json")).toThrow(
      "refusing to write invalid PRD",
    );
    expect(mWrite).not.toHaveBeenCalled();
    expect(mUserSave).not.toHaveBeenCalled();
  });

  it("savePrd with an advisor set and commit off", async () => {
    await initWizard(opts());
    const state = doneState({ advisorSpec: { cli: "grok", model: "grok-4.5" }, commit: false });
    mountArgs().savePrd(state, defaultScaffold(), "/repo/my.json");
    const cfg = JSON.parse(String(mWrite.mock.calls[1][1]));
    expect(cfg.advisor).toMatchObject({ cli: "grok", model: "grok-4.5" });
    expect(cfg.commit_per_task).toBe(false);
    expect(mUserSave).toHaveBeenCalledWith(
      expect.objectContaining({ default_advisor: { cli: "grok", model: "grok-4.5" } }),
    );
  });

  it("saveConfig (run-it-now) writes ONLY the config next to the prd + global defaults", async () => {
    await initWizard(opts());
    mountArgs().saveConfig(doneState(), "/repo/sub/my.json");
    expect(mWrite).toHaveBeenCalledTimes(1); // no prd write
    const [cfgPath, cfgRaw] = mWrite.mock.calls[0];
    expect(cfgPath).toBe(resolve("/repo/sub", "ralph.config.json"));
    expect(JSON.parse(String(cfgRaw)).executor).toMatchObject({ cli: "claude", model: "sonnet" });
    expect(mUserSave).toHaveBeenCalledWith(
      expect.objectContaining({ default_executor: { cli: "claude", model: "sonnet" } }),
    );
  });

  it("--config: seeding reads the explicit path and saves write to it", async () => {
    mExists.mockImplementation((p: any) => String(p) === resolve("custom.json"));
    mRead.mockReturnValue('{"commit_per_task":false}');
    await initWizard(opts({ config: "custom.json" }));
    expect(mRead).toHaveBeenCalledWith(resolve("custom.json"), "utf8");
    expect(mountArgs().init.cfgPathNew).toBe(resolve("custom.json"));
    expect(mountArgs().init.cwdConfig).toEqual({ commit_per_task: false });
    mountArgs().saveConfig(doneState(), "/repo/sub/my.json");
    expect(mWrite.mock.calls[0][0]).toBe(resolve("custom.json")); // NOT next to the prd
  });
});

describe("initWizard non-TTY fallback", () => {
  beforeEach(() => {
    (process.stdout as any).isTTY = false;
  });

  it("writes default scaffold + DEFAULTS config, skips the app; init → run:false", async () => {
    const res = await initWizard(opts());
    expect(res).toEqual({ prdPath: resolve("prd.json"), run: false });
    expect(mMount).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
    const prd = JSON.parse(String(mWrite.mock.calls[0][1]));
    expect(prd).toEqual(defaultScaffold());
    const cfg = JSON.parse(String(mWrite.mock.calls[1][1]));
    expect(cfg.executor).toBeTruthy(); // DEFAULTS-based
  });

  it("root fallback → run:true (bare `ralphrun` still runs the scaffold)", async () => {
    const res = await initWizard(opts({ fromRootFallback: true }));
    expect(res).toEqual({ prdPath: resolve("prd.json"), run: true });
  });

  it("existing files without --force -> warn + null, writes nothing", async () => {
    mExists.mockReturnValue(true);
    const res = await initWizard(opts());
    expect(res).toBeNull();
    expect(mWrite).not.toHaveBeenCalled();
  });

  it("existing files with --force -> overwrites", async () => {
    mExists.mockReturnValue(true);
    const res = await initWizard(opts({ force: true }));
    expect(res).toEqual({ prdPath: resolve("prd.json"), run: false });
    expect(mWrite).toHaveBeenCalledTimes(2);
  });
});
