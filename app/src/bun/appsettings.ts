// appsettings.ts — preferences that belong to the DESKTOP app and to nothing
// else (notification routing, theme, the run-detail default mode, the stall
// threshold). They live in their own file rather than in the core's
// UserConfig, which is a contract the CLI validates and would drop them from.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { configDir } from "../../../src/userconfig.js";

export type NotifyMode = "silent" | "system" | "sound";

export interface AppSettings {
  version: 1;
  stallMinutes: number; // 0 = never escalate a silent task
  maxConcurrentRuns: number;
  notifyDecision: NotifyMode;
  notifyMerge: NotifyMode;
  notifyRunEnd: NotifyMode;
  theme: "dark" | "light" | "system";
  runDetailMode: "calm" | "surgical";
}

export const APP_DEFAULTS: AppSettings = {
  version: 1,
  stallMinutes: 10,
  maxConcurrentRuns: 2,
  notifyDecision: "system",
  notifyMerge: "silent",
  notifyRunEnd: "sound",
  theme: "dark",
  runDetailMode: "calm",
};

function path(): string {
  return join(configDir(), "app.json");
}

const MODES: NotifyMode[] = ["silent", "system", "sound"];

/**
 * Every field is checked, not just parsed. A hand-edited app.json with
 * `maxConcurrentRuns: "no"` used to reach the run queue as NaN, where
 * `slots <= 0` is false forever and every queued run starts at once — a
 * preference file must never be able to lift a safety limit.
 */
function sanitize(raw: Partial<AppSettings>): AppSettings {
  const int = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
  const mode = (v: unknown, fallback: NotifyMode): NotifyMode =>
    MODES.includes(v as NotifyMode) ? (v as NotifyMode) : fallback;
  const oneOf = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;

  return {
    version: 1,
    stallMinutes: int(raw.stallMinutes, APP_DEFAULTS.stallMinutes, 0, 24 * 60), // 0 = never escalate
    // capped, not just floored: this is a SAFETY limit on how many agent
    // processes the machine may host, and a hand-edited 100000 would let the
    // queue spawn one child per backlog at once.
    maxConcurrentRuns: int(raw.maxConcurrentRuns, APP_DEFAULTS.maxConcurrentRuns, 1, 8),
    notifyDecision: mode(raw.notifyDecision, APP_DEFAULTS.notifyDecision),
    notifyMerge: mode(raw.notifyMerge, APP_DEFAULTS.notifyMerge),
    notifyRunEnd: mode(raw.notifyRunEnd, APP_DEFAULTS.notifyRunEnd),
    theme: oneOf(raw.theme, ["dark", "light", "system"], APP_DEFAULTS.theme),
    runDetailMode: oneOf(raw.runDetailMode, ["calm", "surgical"], APP_DEFAULTS.runDetailMode),
  };
}

export function loadAppSettings(): AppSettings {
  try {
    if (!existsSync(path())) return { ...APP_DEFAULTS };
    const parsed: unknown = JSON.parse(readFileSync(path(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { ...APP_DEFAULTS };
    return sanitize(parsed as Partial<AppSettings>);
  } catch {
    return { ...APP_DEFAULTS };
  }
}

export function saveAppSettings(patch: Partial<AppSettings>): AppSettings {
  // a spread would let an ABSENT key in the patch (undefined) erase the stored
  // value — every caller here patches one section and leaves the rest alone.
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = sanitize({ ...loadAppSettings(), ...defined });
  mkdirSync(configDir(), { recursive: true });
  // atomic: interrupted mid-write, app.json reads as defaults on the next load
  // and the following unrelated change would persist those defaults over the
  // user's actual settings
  const p = path();
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, p);
  return next;
}
