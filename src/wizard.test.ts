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
import { mountWizard, type MountWizardArgs } from "./tui/wizard/mount.js";
import type { WizardState } from "./tui/wizard/wizardController.js";
import { loadUserConfig, saveUserConfig, userConfigExists } from "./userconfig.js";
import { initWizard, defaultScaffold } from "./wizard.js";

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

const opts = (o: Partial<Parameters<typeof initWizard>[0]> = {}) => ({
  prd: "prd.json",
  config: "ralph.config.json",
  ...o,
});

const mountArgs = (): MountWizardArgs => mMount.mock.calls[0][0];

// a finalize-ready state as the reducer would leave it on `proceed`
const doneState = (over: Partial<WizardState> = {}): WizardState => ({
  ctx: {
    prdPathNew: resolve("prd.json"),
    cfgPathNew: resolve("ralph.config.json"),
    newPrdExists: false,
    newCfgExists: false,
    force: false,
    fromRootFallback: false,
    cwd: process.cwd(),
    hasUserConfig: false,
    systemLocale: "en" as const,
    saved: { planner: undefined, executor: undefined, advisor: undefined },
  },
  screen: "studio" as const,
  language: null,
  stack: [],
  cursor: 0,
  diagnostics: [],
  actionChoice: "CREATE_NEW",
  prdPath: resolve("prd.json"),
  filepickQuery: "",
  plannerSpec: { cli: "claude", model: "opus" },
  executorSpec: { cli: "claude", model: "sonnet" },
  advisorSpec: { cli: "none", model: "" },
  commit: true,
  needsOverwrite: null,
  done: { type: "proceed" },
  ...over,
});

describe("initWizard TTY path", () => {
  it("computes init flags from fs and passes checkAllAgents through", async () => {
    mExists.mockImplementation((p: any) => String(p).endsWith("prd.json"));
    await initWizard(opts({ force: true, fromRootFallback: true }));
    const a = mountArgs();
    expect(a.init).toEqual({
      prdPathNew: resolve("prd.json"),
      cfgPathNew: resolve("ralph.config.json"),
      newPrdExists: true,
      newCfgExists: false,
      force: true,
      fromRootFallback: true,
      cwd: process.cwd(),
      hasUserConfig: false,
      systemLocale: "en",
      saved: { planner: undefined, executor: undefined, advisor: undefined },
    });
    expect(a.checkAgents).toBe(checkAllAgents);
  });

  it("passes hasUserConfig + saved defaults from the global config through", async () => {
    mUserExists.mockReturnValue(true);
    mUserLoad.mockReturnValue({
      version: 1,
      language: "pt-br",
      default_planner: { cli: "claude", model: "opus" },
      default_executor: { cli: "grok", model: "grok-4.5" },
      default_advisor: null,
    });
    await initWizard(opts());
    const a = mountArgs();
    expect(a.init.hasUserConfig).toBe(true);
    expect(a.init.systemLocale).toBe("pt-br"); // resolveLocale prefers the saved language
    expect(a.init.saved).toEqual({
      planner: { cli: "claude", model: "opus" },
      executor: { cli: "grok", model: "grok-4.5" },
      advisor: null,
    });
  });

  it("returns null on quit, writes nothing, no outro", async () => {
    const res = await initWizard(opts());
    expect(res).toBeNull();
    expect(mWrite).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("returns the finalized path and prints done ✓", async () => {
    mMount.mockResolvedValue(resolve("prd.json"));
    const res = await initWizard(opts());
    expect(res).toBe(resolve("prd.json"));
    expect(console.log).toHaveBeenCalledWith("done ✓");
  });

  it("fromRootFallback result prints the Using PRD line", async () => {
    mMount.mockResolvedValue("/repo/prd.json");
    await initWizard(opts({ fromRootFallback: true }));
    expect(console.log).toHaveBeenCalledWith("Using PRD: /repo/prd.json");
  });

  it("cfgExistsFor checks ralph.config.json next to the prd", async () => {
    await initWizard(opts());
    mExists.mockReturnValue(true);
    expect(mountArgs().cfgExistsFor("/repo/sub/my.json")).toBe(true);
    expect(mExists).toHaveBeenLastCalledWith(resolve("/repo/sub", "ralph.config.json"));
    mExists.mockReturnValue(false);
    expect(mountArgs().cfgExistsFor("/repo/sub/my.json")).toBe(false);
  });

  it("loadSeed reads + normalizes the picked prd", async () => {
    await initWizard(opts());
    const seed = mountArgs().loadSeed("/repo/my.json");
    expect(mRead).toHaveBeenCalledWith("/repo/my.json", "utf8");
    // recoverAndNormalize fills status/retries/deps/acceptance
    expect(seed!.tasks[0]).toMatchObject({ id: "t1", status: "todo", retries: 0, deps: [], acceptance: [] });
  });

  it("finalize CREATE_NEW writes prd + config at the new paths (advisor none)", async () => {
    await initWizard(opts());
    const prd = defaultScaffold();
    const path = mountArgs().finalize(doneState(), prd);
    expect(path).toBe(resolve("prd.json"));
    expect(mWrite).toHaveBeenNthCalledWith(1, resolve("prd.json"), JSON.stringify(prd, null, 2) + "\n");
    const [cfgPath, cfgRaw] = mWrite.mock.calls[1];
    expect(cfgPath).toBe(resolve("ralph.config.json"));
    const cfg = JSON.parse(String(cfgRaw));
    expect(cfg.executor).toMatchObject({ cli: "claude", model: "sonnet" });
    expect(cfg.advisor).toBeNull();
    expect(cfg.commit_per_task).toBe(true);
    // choices merge-saved into the global config for the next init's prefill
    // (no language: a --lang override must never persist via finalize)
    expect(mUserSave).toHaveBeenCalledWith({
      default_planner: { cli: "claude", model: "opus" },
      default_executor: { cli: "claude", model: "sonnet" },
      default_advisor: null, // "none" sentinel → explicit null
    });
  });

  it("finalize refuses to write an invalid PRD (validatePrd gate)", async () => {
    await initWizard(opts());
    const invalid = { ...defaultScaffold(), tasks: [] };
    expect(() => mountArgs().finalize(doneState(), invalid)).toThrow("refusing to write invalid PRD");
    expect(mWrite).not.toHaveBeenCalled();
  });

  it("finalize SELECT_EXISTING writes config next to the picked prd (advisor set)", async () => {
    await initWizard(opts());
    const state = doneState({
      actionChoice: "SELECT_EXISTING",
      prdPath: "/repo/sub/my.json",
      advisorSpec: { cli: "grok", model: "grok-4.5" },
      commit: false,
    });
    const path = mountArgs().finalize(state, defaultScaffold());
    expect(path).toBe("/repo/sub/my.json");
    const [cfgPath, cfgRaw] = mWrite.mock.calls[1];
    expect(cfgPath).toBe(resolve("/repo/sub", "ralph.config.json"));
    const cfg = JSON.parse(String(cfgRaw));
    expect(cfg.advisor).toMatchObject({ cli: "grok", model: "grok-4.5" });
    expect(cfg.commit_per_task).toBe(false);
    expect(mUserSave).toHaveBeenCalledWith(
      expect.objectContaining({ default_advisor: { cli: "grok", model: "grok-4.5" } }),
    );
  });
});

describe("initWizard non-TTY fallback", () => {
  beforeEach(() => {
    (process.stdout as any).isTTY = false;
  });

  it("writes default scaffold + DEFAULTS config, skips the app", async () => {
    const res = await initWizard(opts());
    expect(res).toBe(resolve("prd.json"));
    expect(mMount).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
    const prd = JSON.parse(String(mWrite.mock.calls[0][1]));
    expect(prd).toEqual(defaultScaffold());
    const cfg = JSON.parse(String(mWrite.mock.calls[1][1]));
    expect(cfg.executor).toBeTruthy(); // DEFAULTS-based
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
    expect(res).toBe(resolve("prd.json"));
    expect(mWrite).toHaveBeenCalledTimes(2);
  });
});
