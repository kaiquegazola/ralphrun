// userconfig.test.ts — configDir/configPath, userConfigExists, load/save/reset
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  configDir,
  configPath,
  userConfigExists,
  loadUserConfig,
  saveUserConfig,
  resetUserConfig,
} from "./userconfig.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:os", () => ({ homedir: vi.fn(() => "/home/u") }));

const REAL_PLATFORM = process.platform;
function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  setPlatform(REAL_PLATFORM);
  vi.unstubAllEnvs();
});

// Expectations are BUILT with join, never hand-typed with "/": the product
// joins with the platform separator, so a literal "a/b" only ever matched on
// POSIX and made the whole file fail on Windows for no real reason.
describe("configDir / configPath", () => {
  it("win32 with APPDATA set", () => {
    setPlatform("win32");
    vi.stubEnv("APPDATA", "C:\\Users\\u\\AppData\\Roaming");
    expect(configDir()).toBe(join("C:\\Users\\u\\AppData\\Roaming", "ralphrun"));
  });

  it("win32 without APPDATA falls back to ~/.config", () => {
    setPlatform("win32");
    vi.stubEnv("APPDATA", "");
    expect(configDir()).toBe(join("/home/u", ".config", "ralphrun"));
  });

  it("unix with XDG_CONFIG_HOME set", () => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg");
    expect(configDir()).toBe(join("/xdg", "ralphrun"));
  });

  it("unix without XDG_CONFIG_HOME falls back to ~/.config", () => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(configDir()).toBe(join("/home/u", ".config", "ralphrun"));
  });

  it("configPath appends config.json", () => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg");
    expect(configPath()).toBe(join("/xdg", "ralphrun", "config.json"));
  });
});

describe("userConfigExists", () => {
  it("true when file exists", () => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg");
    vi.mocked(existsSync).mockReturnValue(true);
    expect(userConfigExists()).toBe(true);
    expect(vi.mocked(existsSync)).toHaveBeenCalledWith(join("/xdg", "ralphrun", "config.json"));
  });

  it("false when missing", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(userConfigExists()).toBe(false);
  });
});

describe("loadUserConfig", () => {
  beforeEach(() => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg");
  });

  it("merges file over defaults", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, language: "pt-br" }) as unknown as string,
    );
    expect(loadUserConfig()).toEqual({ version: 1, language: "pt-br" });
  });

  it("partial file fills defaults (version from defaults)", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ commit_per_task: false }) as unknown as string,
    );
    expect(loadUserConfig()).toEqual({ version: 1, commit_per_task: false });
  });

  it("missing file -> defaults, never throws", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadUserConfig()).toEqual({ version: 1 });
  });

  it("corrupt json -> defaults, never throws", () => {
    vi.mocked(readFileSync).mockReturnValue("{not json" as unknown as string);
    expect(loadUserConfig()).toEqual({ version: 1 });
  });

  it("valid JSON but non-object (number/string/null) -> defaults", () => {
    for (const raw of ["42", '"hi"', "null", "[1,2]"]) {
      vi.mocked(readFileSync).mockReturnValue(raw as unknown as string);
      expect(loadUserConfig()).toEqual({ version: 1 });
    }
  });

  it("shape-corrupt fields are dropped, valid siblings survive", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        version: "9", // wrong type — ignored, defaults' version wins
        language: "fr", // not a supported locale — dropped
        default_executor: "claude:sonnet", // string instead of {cli,model} — dropped
        default_planner: {}, // partial agent — dropped
        default_advisor: null, // explicit "none" — kept
        review_after: "yes", // wrong type — dropped
        commit_per_task: false, // kept
        max_review_rounds: "3", // wrong type — dropped
        max_stalled_review_rounds: 2, // kept
        max_retries_per_task: 5, // kept
        unknown_key: true, // never copied
      }) as unknown as string,
    );
    expect(loadUserConfig()).toEqual({
      version: 1,
      default_advisor: null,
      commit_per_task: false,
      max_stalled_review_rounds: 2,
      max_retries_per_task: 5,
    });
  });

  it("valid agent specs pass through (extra agent keys stripped)", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        default_executor: { cli: "grok", model: "grok-4.5", extra: 1 },
        review_after: true,
        max_review_rounds: 2,
        max_stalled_review_rounds: 1,
      }) as unknown as string,
    );
    expect(loadUserConfig()).toEqual({
      version: 1,
      default_executor: { cli: "grok", model: "grok-4.5" },
      review_after: true,
      max_review_rounds: 2,
      max_stalled_review_rounds: 1,
    });
  });

  it("returns a fresh object each call (defaults not shared)", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const a = loadUserConfig();
    a.language = "en";
    expect(loadUserConfig().language).toBeUndefined();
  });
});

describe("saveUserConfig", () => {
  beforeEach(() => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg");
  });

  it("merge-saves patch over existing file, atomically via .tmp + rename", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, language: "en", review_after: false }) as unknown as string,
    );
    const order: string[] = [];
    vi.mocked(mkdirSync).mockImplementation((() => {
      order.push("mkdir");
    }) as never);
    vi.mocked(writeFileSync).mockImplementation((() => {
      order.push("write");
    }) as never);
    vi.mocked(renameSync).mockImplementation((() => {
      order.push("rename");
    }) as never);

    saveUserConfig({ language: "pt-br" });

    expect(order).toEqual(["mkdir", "write", "rename"]);
    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(join("/xdg", "ralphrun"), { recursive: true });
    const [tmpPath, body] = vi.mocked(writeFileSync).mock.calls[0];
    // pid-unique tmp: two concurrent saves can't rename-steal each other's file
    expect(tmpPath).toBe(join("/xdg", "ralphrun", `config.json.${process.pid}.tmp`));
    expect(JSON.parse(body as string)).toEqual({
      version: 1,
      language: "pt-br",
      review_after: false, // untouched key survives merge-save
    });
    expect(body).toMatch(/\n$/);
    expect(vi.mocked(renameSync)).toHaveBeenCalledWith(
      join("/xdg", "ralphrun", `config.json.${process.pid}.tmp`),
      join("/xdg", "ralphrun", "config.json"),
    );
  });

  it("works when no file exists yet (patch over defaults)", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    saveUserConfig({ default_advisor: null });
    const body = vi.mocked(writeFileSync).mock.calls[0][1];
    expect(JSON.parse(body as string)).toEqual({ version: 1, default_advisor: null });
  });
});

describe("resetUserConfig", () => {
  it("rm -f the config file (missing file no-throw via force)", () => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg");
    resetUserConfig();
    expect(vi.mocked(rmSync)).toHaveBeenCalledWith(join("/xdg", "ralphrun", "config.json"), { force: true });
  });
});
