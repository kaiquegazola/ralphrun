// userconfig.ts — global preferences (~/.config/ralphrun/config.json or
// %APPDATA%\ralphrun\config.json). Preferences ONLY — never secrets.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "./config.js";

export interface UserConfig {
  version: number;
  language?: "en" | "pt-br";
  default_planner?: AgentSpec | null;
  default_executor?: AgentSpec | null;
  default_advisor?: AgentSpec | null; // null = explicitly "none"
  review_after?: boolean;
  max_review_rounds?: number;
  max_retries_per_task?: number;
  commit_per_task?: boolean;
}

const USER_DEFAULTS: UserConfig = { version: 1 };

export function configDir(): string {
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || join(homedir(), ".config") // APPDATA missing → posix fallback
      : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "ralphrun");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

// powers the wizard's first-run language screen
export function userConfigExists(): boolean {
  return existsSync(configPath());
}

function isAgent(v: unknown): v is AgentSpec {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as AgentSpec).cli === "string" &&
    typeof (v as AgentSpec).model === "string"
  );
}

// field-wise sanitize: only known keys with the right shape survive, so a
// valid-JSON-but-wrong-shape file (or any future `version`) can never leak a
// bad value into loadConfig's merge — it degrades to defaults instead.
function sanitize(raw: unknown): UserConfig {
  const cfg: UserConfig = { ...USER_DEFAULTS };
  if (typeof raw !== "object" || raw === null) return cfg;
  const r = raw as Record<string, unknown>;
  if (r.language === "en" || r.language === "pt-br") cfg.language = r.language;
  for (const k of ["default_planner", "default_executor", "default_advisor"] as const) {
    const v = r[k];
    if (isAgent(v)) cfg[k] = { cli: v.cli, model: v.model };
    else if (v === null) cfg[k] = null;
  }
  for (const k of ["review_after", "commit_per_task"] as const) {
    if (typeof r[k] === "boolean") cfg[k] = r[k] as boolean;
  }
  for (const k of ["max_review_rounds", "max_retries_per_task"] as const) {
    if (typeof r[k] === "number") cfg[k] = r[k] as number;
  }
  return cfg;
}

export function loadUserConfig(): UserConfig {
  try {
    return sanitize(JSON.parse(readFileSync(configPath(), "utf8")));
  } catch {
    return { ...USER_DEFAULTS }; // missing/corrupt/partial NEVER throws
  }
}

// merge-save: callers pass only what changed, so two writers can't clobber each other's keys
export function saveUserConfig(patch: Partial<UserConfig>): void {
  const cfg = { ...loadUserConfig(), ...patch };
  mkdirSync(configDir(), { recursive: true });
  const p = configPath();
  // pid-unique tmp in the same dir — rename stays atomic AND two concurrent
  // saves can't rename-steal each other's tmp file (fixed name → ENOENT race).
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, p);
}

export function resetUserConfig(): void {
  rmSync(configPath(), { force: true });
}
