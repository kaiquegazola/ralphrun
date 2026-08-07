// config.ts — defaults, CLI adapters metadata, parse_agent, load_config

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultModelOf } from "./agents.js";
import { t } from "./i18n.js";
import { DEFAULT_ADVISOR_PLAN_THRESHOLD } from "./plan-cache.js";
import { loadUserConfig } from "./userconfig.js";

export interface AgentSpec {
  cli: string;
  model: string;
}

/**
 * What a headless run does with a task the reviewer refused. "block" is what
 * ralphrun has always done; "accept" is the policy form of the TUI's approve
 * key. See review_blocked_policy.
 */
export type ReviewBlockedPolicy = "block" | "accept";

export interface Config {
  executor: AgentSpec;
  advisor: AgentSpec | null;
  task_timeout: number;
  advisor_timeout: number;
  max_retries_per_task: number;
  review_after: boolean;
  max_review_rounds: number;
  max_stalled_review_rounds: number;
  /**
   * Raise it to buy fewer advisor plans, lower it to plan everything (see
   * routeAdvisorPlan). Optional like stream_output: DEFAULTS always fills it, and
   * a config object hand-built without it still routes on the same default.
   */
  advisor_plan_threshold?: number;
  heartbeat_secs: number;
  /** false = do not turn on the cli event stream (plain buffered output) */
  stream_output?: boolean;
  commit_per_task: boolean;
  commit_message_template: string;
  stop_on_blocked: boolean;
  /**
   * Stop the run once the measured spend reaches this many USD. 0 (the default)
   * or absent = no ceiling, so every existing setup keeps running exactly as it
   * did. Only spend that a cli actually REPORTED counts — claude does, nothing
   * else does yet — so this is a ceiling on what we can see, never on what an
   * unmetered agent can bill. See README.
   */
  max_cost_usd?: number;
  /**
   * The approval gate for a review-blocked task, for runs with no TUI to ask.
   * A headless run cannot wait on a human, so the gate is a policy rather than a
   * prompt. "accept" is bounded by the SAME safety property as the TUI's approve
   * key — verification must have passed — so no policy can ever accept a task
   * whose tests failed. Default "block" = today's behaviour, so no existing
   * setup silently starts auto-accepting.
   */
  review_blocked_policy?: ReviewBlockedPolicy;
  /**
   * Let the reviewer RUN its own checks instead of only reading the diff — the
   * acceptance scenario end to end, the edge case the suite never passes. OFF by
   * default, and it must stay that way: it is the largest per-round cost
   * multiplier there is, since every review round becomes a second agent doing
   * real work rather than a single read-and-answer turn. See README.
   *
   * The commands it may run are decided by reviewexec.ts and enforced by the
   * target cli's own allowlist; a cli with no execution grant ignores this and
   * reviews read-only.
   */
  review_runs_commands?: boolean;
  /**
   * Wall clock for the review call, in seconds — used ONLY when
   * review_runs_commands is on. A reviewer running a suite needs the budget of a
   * test run, not of an answer, but a read-only reviewer that hangs must still
   * die at advisor_timeout: raising that ceiling for every review would triple
   * the cost of a hung one for no gain.
   */
  review_timeout?: number;
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
  advisor_plan_threshold: DEFAULT_ADVISOR_PLAN_THRESHOLD,
  heartbeat_secs: 30,
  stream_output: true,
  commit_per_task: true,
  commit_message_template: "{id}: {title}",
  stop_on_blocked: false,
  max_cost_usd: 0,
  review_blocked_policy: "block",
  review_runs_commands: false,
  review_timeout: 900,
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

// Pick, not a hand-written shape: mergeDefined infers its T from here, so a key
// that is optional in Config has to stay optional here or Config stops matching.
type Overrides = Partial<Pick<Config, "executor" | "advisor" | "review_after" | "review_blocked_policy">>;

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
