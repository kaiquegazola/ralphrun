import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("which", () => ({ default: { sync: vi.fn() } }));
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));
// the optional @cursor/sdk is deliberately not installed here, so the real
// resolve() would answer "no" for every case
vi.mock("./cursor-sdk.js", () => ({ cursorSdkInstalled: vi.fn(() => true) }));

import which from "which";
import { execSync } from "node:child_process";
import { cursorSdkInstalled } from "./cursor-sdk.js";
import { checkAgent, checkAllAgents } from "./diagnostics.js";

const whichSync = vi.mocked(which.sync);
const exec = vi.mocked(execSync);
const sdkInstalled = vi.mocked(cursorSdkInstalled);

const origKey = process.env.CURSOR_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  sdkInstalled.mockReturnValue(true);
});

afterEach(() => {
  if (origKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = origKey;
});

describe("checkAgent", () => {
  it("returns not-installed when binary is missing", () => {
    whichSync.mockReturnValue(null as any);
    const d = checkAgent("claude");
    expect(d).toEqual({ cli: "claude", installed: false, loggedIn: "unknown" });
  });

  it("non-string cli (shape-corrupt config) -> not-installed, never throws", () => {
    // which.sync would throw a TypeError on a non-string — must never be reached
    whichSync.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'match')");
    });
    const d = checkAgent(undefined as unknown as string);
    expect(d).toEqual({ cli: undefined, installed: false, loggedIn: "unknown" });
    expect(whichSync).not.toHaveBeenCalled();
  });

  it("falls back to the cli name when no BINARIES entry exists", () => {
    whichSync.mockReturnValue(null as any);
    const d = checkAgent("mystery");
    // BINARIES["mystery"] is undefined -> `?? cli` fallback
    expect(whichSync).toHaveBeenCalledWith("mystery", { nothrow: true });
    expect(d.installed).toBe(false);
  });

  it("claude: logged in when `auth status` exits 0", () => {
    whichSync.mockReturnValue("/bin/claude" as any);
    exec.mockReturnValue("" as any);
    const d = checkAgent("claude");
    expect(d).toEqual({
      cli: "claude",
      installed: true,
      loggedIn: true,
      loginCommand: "claude auth login",
    });
  });

  it("claude: not logged in when `auth status` throws", () => {
    whichSync.mockReturnValue("/bin/claude" as any);
    exec.mockImplementation(() => {
      throw new Error("nonzero");
    });
    const d = checkAgent("claude");
    expect(d.loggedIn).toBe(false);
    expect(d.loginCommand).toBe("claude auth login");
  });

  it("cursor: logged in when status output has no 'Not logged in'", () => {
    whichSync.mockReturnValue("/bin/cursor-agent" as any);
    exec.mockReturnValue("Logged in as ada\n" as any);
    const d = checkAgent("cursor");
    expect(d.loggedIn).toBe(true);
    expect(d.loginCommand).toBe("cursor agent login");
  });

  it("cursor: not logged in when status output says 'Not logged in'", () => {
    whichSync.mockReturnValue("/bin/cursor-agent" as any);
    exec.mockReturnValue("Not logged in\n" as any);
    const d = checkAgent("cursor");
    expect(d.loggedIn).toBe(false);
  });

  // an in-process backend has no binary: probing PATH for it would report every
  // install as broken
  it("cursorsdk: installed without any binary on PATH", () => {
    whichSync.mockReturnValue(null as any);
    process.env.CURSOR_API_KEY = "k";
    expect(checkAgent("cursorsdk")).toEqual({
      cli: "cursorsdk",
      installed: true,
      loggedIn: true,
      loginCommand: "export CURSOR_API_KEY=<key from cursor.com/dashboard>",
    });
    expect(whichSync).not.toHaveBeenCalled();
  });

  it("cursorsdk: not logged in without CURSOR_API_KEY", () => {
    delete process.env.CURSOR_API_KEY;
    expect(checkAgent("cursorsdk").loggedIn).toBe(false);
  });

  // preflight has to fail here, or every task in the PRD burns its full retry
  // budget on the same missing import
  it("cursorsdk: not installed when the optional package is missing", () => {
    sdkInstalled.mockReturnValue(false);
    process.env.CURSOR_API_KEY = "k";
    expect(checkAgent("cursorsdk")).toEqual({ cli: "cursorsdk", installed: false, loggedIn: "unknown" });
  });

  it("codex: logged in when `login status` exits 0", () => {
    whichSync.mockReturnValue("/bin/codex" as any);
    exec.mockReturnValue("" as any);
    const d = checkAgent("codex");
    expect(d).toEqual({
      cli: "codex",
      installed: true,
      loggedIn: true,
      loginCommand: "codex login",
    });
  });

  it("codex: not logged in when `login status` exits nonzero", () => {
    whichSync.mockReturnValue("/bin/codex" as any);
    exec.mockImplementation(() => {
      throw new Error("nonzero"); // real cli prints "Not logged in" and exits 1
    });
    const d = checkAgent("codex");
    expect(d.loggedIn).toBe(false);
    expect(d.loginCommand).toBe("codex login");
  });

  it("opencode: logged in when `auth list` reports credentials", () => {
    whichSync.mockReturnValue("/bin/opencode" as any);
    exec.mockReturnValue("└  2 credentials\n" as any);
    const d = checkAgent("opencode");
    expect(d).toEqual({
      cli: "opencode",
      installed: true,
      loggedIn: true,
      loginCommand: "opencode auth login",
    });
  });

  it("opencode: not logged in with zero credentials", () => {
    whichSync.mockReturnValue("/bin/opencode" as any);
    exec.mockReturnValue("└  0 credentials\n" as any);
    expect(checkAgent("opencode").loggedIn).toBe(false);
  });

  it("opencode: not logged in when the count line never arrives (output drift)", () => {
    whichSync.mockReturnValue("/bin/opencode" as any);
    exec.mockReturnValue("something unexpected\n" as any);
    expect(checkAgent("opencode").loggedIn).toBe(false);
  });

  it("grok: installed but auth unknown (no status probe)", () => {
    whichSync.mockReturnValue("/bin/grok" as any);
    const d = checkAgent("grok");
    expect(d.loggedIn).toBe("unknown");
    expect(d.loginCommand).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("checkAllAgents", () => {
  it("maps over every supported CLI in preflight order", () => {
    whichSync.mockReturnValue("/bin/x" as any);
    exec.mockReturnValue("" as any);
    const all = checkAllAgents();
    expect(all.map((a) => a.cli)).toEqual([
      "agy", "claude", "grok", "cursor", "cursorsdk", "codex", "opencode",
    ]);
  });
});
