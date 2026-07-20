// config.ts — defaults, CLI adapters metadata, parse_agent, load_config

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultModelOf } from "./agents.js";
import { t } from "./i18n.js";
import { loadUserConfig } from "./userconfig.js";

export interface AgentSpec {
  cli: string;
  model: string;
}

export interface Config {
  executor: AgentSpec;
  advisor: AgentSpec | null;
  task_timeout: number;
  advisor_timeout: number;
  max_retries_per_task: number;
  review_after: boolean;
  max_review_rounds: number;
  max_stalled_review_rounds: number;
  heartbeat_secs: number;
  /** false = do not turn on the cli event stream (plain buffered output) */
  stream_output?: boolean;
  commit_per_task: boolean;
  commit_message_template: string;
  stop_on_blocked: boolean;
  extra_executor_args: string[];
}

export const DEFAULTS: Config = {
  executor: { cli: "claude", model: "sonnet" },
  advisor: { cli: "claude", model: "fable" },
  task_timeout: 1800,
  advisor_timeout: 300,
  max_retries_per_task: 3,
  review_after: true,
  max_review_rounds: 3,
  max_stalled_review_rounds: 2,
  heartbeat_secs: 30,
  stream_output: true,
  commit_per_task: true,
  commit_message_template: "{id}: {title}",
  stop_on_blocked: false,
  extra_executor_args: [],
};

export function parseAgent(spec: string | undefined): AgentSpec | null {
  if (!spec || spec.toLowerCase() === "none") return null;
  const idx = spec.indexOf(":");
  let cli: string;
  let model: string;
  if (idx === -1) {
    cli = spec;
    model = defaultModelOf(spec);
  } else {
    cli = spec.slice(0, idx);
    model = spec.slice(idx + 1) || defaultModelOf(cli);
  }
  return { cli, model };
}

type Overrides = Partial<{
  executor: AgentSpec;
  advisor: AgentSpec | null;
  review_after: boolean;
}>;

// merge only DEFINED keys — undefined must never clobber a lower layer
function mergeDefined<T extends object>(dst: T, src: Partial<T>): void {
  for (const [k, v] of Object.entries(src)) if (v !== undefined) (dst as Record<string, unknown>)[k] = v;
}

// layering: DEFAULTS < global user config knobs < project ralph.config.json < CLI-flag overrides
export function loadConfig(
  prdPath: string,
  configFlag: string | undefined,
  overrides: Overrides,
): Config {
  const cfg: Config = structuredClone(DEFAULTS);
  const u = loadUserConfig();
  mergeDefined(cfg, {
    review_after: u.review_after,
    max_review_rounds: u.max_review_rounds,
    max_stalled_review_rounds: u.max_stalled_review_rounds,
    max_retries_per_task: u.max_retries_per_task,
    commit_per_task: u.commit_per_task,
    executor: u.default_executor ?? undefined, // null = "no preference", NOT a null executor
    advisor: u.default_advisor, // null IS meaningful for advisor ("none") — pass through
  });
  const cfgFile = configFlag
    ? resolve(configFlag)
    : resolve(dirname(prdPath), "ralph.config.json");
  if (existsSync(cfgFile)) {
    let file: unknown;
    try {
      file = JSON.parse(readFileSync(cfgFile, "utf8"));
    } catch (e) {
      // loop.ts catches this and exits(1) with the one-line message — no raw stack
      throw new Error(t("loop.err.badConfig", { path: cfgFile, msg: e instanceof Error ? e.message : String(e) }));
    }
    Object.assign(cfg, file); // JSON.parse never yields undefined values
  }
  mergeDefined(cfg, overrides);
  return cfg;
}
