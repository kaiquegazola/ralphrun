import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("which", () => ({ default: { sync: vi.fn() } }));
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

import which from "which";
import { execSync } from "node:child_process";
import { checkAgent, checkAllAgents } from "./diagnostics.js";

const whichSync = vi.mocked(which.sync);
const exec = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
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

  it("grok: installed but auth unknown (no status probe)", () => {
    whichSync.mockReturnValue("/bin/grok" as any);
    const d = checkAgent("grok");
    expect(d.loggedIn).toBe("unknown");
    expect(d.loginCommand).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("checkAllAgents", () => {
  it("maps over claude, grok, cursor", () => {
    whichSync.mockReturnValue("/bin/x" as any);
    exec.mockReturnValue("" as any);
    const all = checkAllAgents();
    expect(all.map((a) => a.cli)).toEqual(["claude", "grok", "cursor"]);
  });
});
