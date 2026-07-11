// config.test.ts — parseAgent, loadConfig (incl. global-user-config layering)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { loadUserConfig, type UserConfig } from "./userconfig.js";
import { parseAgent, loadConfig, DEFAULTS } from "./config.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("./userconfig.js", () => ({
  loadUserConfig: vi.fn(),
}));

const mUser = vi.mocked(loadUserConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mUser.mockReturnValue({ version: 1 });
});

describe("parseAgent", () => {
  it("undefined -> null", () => {
    expect(parseAgent(undefined)).toBeNull();
  });
  it("'none' (any case) -> null", () => {
    expect(parseAgent("None")).toBeNull();
  });
  it("cli only uses default model", () => {
    expect(parseAgent("claude")).toEqual({ cli: "claude", model: "sonnet" });
  });
  it("cli only with no default model -> empty", () => {
    expect(parseAgent("cursor")).toEqual({ cli: "cursor", model: "" });
  });
  it("cli:model", () => {
    expect(parseAgent("grok:grok-4.5")).toEqual({ cli: "grok", model: "grok-4.5" });
  });
  it("cli: with empty model falls back to default", () => {
    expect(parseAgent("grok:")).toEqual({ cli: "grok", model: "grok-4.5" });
  });
  it("cli: with empty model and no default -> empty", () => {
    expect(parseAgent("cursor:")).toEqual({ cli: "cursor", model: "" });
  });
});

describe("loadConfig", () => {
  it("returns defaults when no config file and no overrides", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const cfg = loadConfig("/x/prd.json", undefined, {});
    expect(cfg).toEqual(DEFAULTS);
    // structuredClone isolation — mutating result does not touch DEFAULTS
    cfg.task_timeout = 1;
    expect(DEFAULTS.task_timeout).toBe(1800);
    cfg.executor.model = "changed";
    expect(DEFAULTS.executor.model).toBe("sonnet");
  });

  it("merges file config, using configFlag path", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ task_timeout: 999 }) as unknown as string);
    const cfg = loadConfig("/x/prd.json", "/custom/ralph.config.json", {});
    expect(cfg.task_timeout).toBe(999);
    expect(vi.mocked(readFileSync).mock.calls[0][0]).toContain("/custom/ralph.config.json");
  });

  it("uses prd dir default config path when no flag", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ review_after: false }) as unknown as string);
    loadConfig("/proj/prd.json", undefined, {});
    expect(vi.mocked(existsSync).mock.calls[0][0]).toContain("/proj/ralph.config.json");
  });

  it("malformed config file throws a clean one-line error (no raw stack)", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{oops" as unknown as string);
    expect(() => loadConfig("/x/prd.json", "/custom/ralph.config.json", {})).toThrow(
      /invalid JSON in .*\/custom\/ralph\.config\.json/,
    );
  });

  it("non-Error read failure is stringified into the same message", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw "raw-failure";
    });
    expect(() => loadConfig("/x/prd.json", undefined, {})).toThrow("raw-failure");
  });

  it("overrides win over file and defaults", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ review_after: true }) as unknown as string);
    const cfg = loadConfig("/x/prd.json", undefined, {
      review_after: false,
      executor: { cli: "grok", model: "grok-4.5" },
    });
    expect(cfg.review_after).toBe(false);
    expect(cfg.executor).toEqual({ cli: "grok", model: "grok-4.5" });
  });

  it("undefined override keys never clobber lower layers", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const cfg = loadConfig("/x/prd.json", undefined, { review_after: undefined });
    expect(cfg.review_after).toBe(true); // DEFAULTS survives
  });
});

describe("loadConfig global-user-config layering", () => {
  const user = (over: Partial<UserConfig>): void => {
    mUser.mockReturnValue({ version: 1, ...over });
  };

  it("global knobs override DEFAULTS when no project file", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    user({
      review_after: false,
      max_review_rounds: 9,
      max_stalled_review_rounds: 4,
      max_retries_per_task: 7,
      commit_per_task: false,
      default_executor: { cli: "grok", model: "grok-4.5" },
      default_advisor: { cli: "claude", model: "opus" },
    });
    const cfg = loadConfig("/x/prd.json", undefined, {});
    expect(cfg.review_after).toBe(false);
    expect(cfg.max_review_rounds).toBe(9);
    expect(cfg.max_stalled_review_rounds).toBe(4);
    expect(cfg.max_retries_per_task).toBe(7);
    expect(cfg.commit_per_task).toBe(false);
    expect(cfg.executor).toEqual({ cli: "grok", model: "grok-4.5" });
    expect(cfg.advisor).toEqual({ cli: "claude", model: "opus" });
  });

  it("default_advisor null means advisor none; default_executor null is skipped", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    user({ default_executor: null, default_advisor: null });
    const cfg = loadConfig("/x/prd.json", undefined, {});
    expect(cfg.executor).toEqual(DEFAULTS.executor); // null executor pref skipped
    expect(cfg.advisor).toBeNull(); // null advisor applied
  });

  it("project file wins over global", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ review_after: true, max_review_rounds: 2 }) as unknown as string,
    );
    user({ review_after: false, max_review_rounds: 9 });
    const cfg = loadConfig("/x/prd.json", undefined, {});
    expect(cfg.review_after).toBe(true);
    expect(cfg.max_review_rounds).toBe(2);
  });

  it("flags win over global and project; --advisor none applies null", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ review_after: true, advisor: { cli: "grok", model: "grok-4.5" } }) as unknown as string,
    );
    user({ review_after: false, default_advisor: { cli: "claude", model: "opus" } });
    const cfg = loadConfig("/x/prd.json", undefined, { review_after: false, advisor: null });
    expect(cfg.review_after).toBe(false);
    expect(cfg.advisor).toBeNull(); // defined null from --advisor none applies
  });
});
