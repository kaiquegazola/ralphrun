// appsettings.test.ts — the desktop-only prefs file. node:fs and the core's
// configDir are mocked: the point is the merge decisions, not the disk.

import { describe, it, expect, vi, beforeEach } from "vitest";

const fs = {
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  // the file lands through a tmp + rename: interrupted mid-write, a truncated
  // app.json reads as defaults and the next save persists those over the
  // user's real settings
  renameSync: vi.fn(),
};

// `default` too: the module graph pulls node:fs in as a default import as well
vi.mock("node:fs", () => ({ ...fs, default: fs }));
vi.mock("../../../src/userconfig.js", () => ({ configDir: () => "/cfg" }));

const { loadAppSettings, saveAppSettings, APP_DEFAULTS } = await import("./appsettings.ts");

// what the last saveAppSettings actually serialised
function written(): Record<string, unknown> {
  const call = fs.writeFileSync.mock.calls.at(-1);
  return JSON.parse(call![1] as string);
}

// pretend app.json exists holding `stored`
function onDisk(stored: unknown): void {
  fs.existsSync.mockReturnValue(true);
  fs.readFileSync.mockReturnValue(JSON.stringify(stored));
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.existsSync.mockReturnValue(false);
});

describe("loadAppSettings", () => {
  it("hands back the defaults when the file was never written", () => {
    expect(loadAppSettings()).toEqual(APP_DEFAULTS);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it("does not hand back the shared defaults object, so a caller cannot mutate them", () => {
    const first = loadAppSettings();
    first.stallMinutes = 999;
    expect(loadAppSettings().stallMinutes).toBe(APP_DEFAULTS.stallMinutes);
  });

  it("layers the stored values over the defaults, keeping the keys the file omits", () => {
    onDisk({ theme: "light", notifyMerge: "sound" });
    const s = loadAppSettings();
    expect(s.theme).toBe("light");
    expect(s.notifyMerge).toBe("sound");
    expect(s.stallMinutes).toBe(APP_DEFAULTS.stallMinutes);
    expect(s.runDetailMode).toBe(APP_DEFAULTS.runDetailMode);
  });

  it("reads app.json out of the core's config dir", () => {
    onDisk({});
    loadAppSettings();
    expect(fs.readFileSync).toHaveBeenCalledWith("/cfg/app.json", "utf8");
  });

  it("pins version to 1 even when the file claims another one", () => {
    onDisk({ version: 7, theme: "light" });
    expect(loadAppSettings().version).toBe(1);
  });

  it("reads a corrupt file as the defaults instead of throwing — a half-written app.json must not brick the app", () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue("{ not json");
    expect(() => loadAppSettings()).not.toThrow();
    expect(loadAppSettings()).toEqual(APP_DEFAULTS);
  });

  it("survives fs throwing outright (permissions, a vanished dir)", () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(loadAppSettings()).toEqual(APP_DEFAULTS);
  });
});

describe("saveAppSettings", () => {
  it("keeps every stored value the patch does not name — callers patch one section at a time", () => {
    onDisk({ theme: "light", stallMinutes: 42, maxConcurrentRuns: 5 });
    const next = saveAppSettings({ notifyDecision: "silent" });
    expect(next.theme).toBe("light");
    expect(next.stallMinutes).toBe(42);
    expect(next.maxConcurrentRuns).toBe(5);
    expect(next.notifyDecision).toBe("silent");
  });

  it("does NOT let an explicitly undefined key erase the stored value", () => {
    onDisk({ theme: "light", stallMinutes: 42 });
    // this is the shape a caller produces when it spreads a partial form state
    const next = saveAppSettings({ theme: undefined, stallMinutes: 0 });
    expect(next.theme).toBe("light");
    expect(next.stallMinutes).toBe(0); // 0 is a real value (never escalate), not an absence
    expect(written().theme).toBe("light");
  });

  it("writes the merged settings, not just the patch", () => {
    onDisk({ theme: "light" });
    saveAppSettings({ runDetailMode: "surgical" });
    expect(written()).toEqual({ ...APP_DEFAULTS, theme: "light", runDetailMode: "surgical" });
  });

  it("lands through a rename so an interrupted save cannot truncate the file", () => {
    saveAppSettings({ theme: "light" });
    const [tmp] = fs.writeFileSync.mock.calls.at(-1)!;
    expect(String(tmp)).toContain(".tmp");
    expect(fs.renameSync).toHaveBeenCalledWith(tmp, "/cfg/app.json");
  });

  it("creates the config dir before writing, so a first save on a clean machine works", () => {
    saveAppSettings({ theme: "system" });
    expect(fs.mkdirSync).toHaveBeenCalledWith("/cfg", { recursive: true });
    // written to a tmp INSIDE that dir, then renamed over the real path
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("/cfg/app.json."), expect.any(String));
    expect(fs.renameSync).toHaveBeenCalledWith(expect.any(String), "/cfg/app.json");
  });

  it("refuses a version downgrade smuggled in through the patch", () => {
    onDisk({});
    expect(saveAppSettings({ version: 0 as never }).version).toBe(1);
  });

  it("starts from the defaults when there is nothing on disk yet", () => {
    const next = saveAppSettings({ theme: "light" });
    expect(next).toEqual({ ...APP_DEFAULTS, theme: "light" });
  });
});
