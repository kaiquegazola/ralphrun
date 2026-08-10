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
  /**
   * false = do not turn on the cli event stream (plain buffered output). Only
   * the SPAWN backends with a parser read this — the in-process cursorsdk one
   * always streams, through its own. NOT only a display knob: max_cost_usd is
   * metered off the same stream, so turning it off unmeters claude too.
   */
  stream_output?: boolean;
  commit_per_task: boolean;
  commit_message_template: string;
  stop_on_blocked: boolean;
  /**
   * Stop the run once the measured spend reaches this many USD. 0 (the default)
   * or absent = no ceiling, so every existing setup keeps running exactly as it
   * did. Only spend that a cli actually REPORTED counts, which today is claude
   * WITH stream_output on — the figure rides on the event stream and nowhere
   * else, so turning the stream off unmeters the one metered spawn backend. No
   * other cli reports USD at all. This is a ceiling on what we can see, never on
   * what an unmetered agent can bill. See README.
   */
  max_cost_usd?: number;
  /**
   * The approval gate for a review-blocked task, for runs with no TUI to ask.
   * A headless run cannot wait on a human, so the gate is a policy rather than a
   * prompt. "accept" is bounded by the SAME safety property as the TUI's approve
   * key — a `verify` command must have RUN and passed — so no policy can accept
   * a task whose tests failed, nor one that never had a test to fail. Default
   * "block" = today's behaviour, so no existing setup silently starts
   * auto-accepting.
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
  /**
   * Run each task in its own detached `git worktree` and cherry-pick the result
   * back. It buys READ isolation — a `verify` that shells tsc/npm test reads the
   * whole project, so the gate must not observe files this task never asked
   * about — and it makes a blocked task's mess a discarded directory instead of
   * dirt smeared across the workspace.
   *
   * OFF by default because it is a real behaviour change, not just an
   * optimization: a worktree is checked out from HEAD, so the task no longer
   * sees the user's uncommitted work. See README.
   */
  worktree_per_task?: boolean;
  /**
   * Untracked paths to symlink from the workspace into a fresh worktree. A
   * worktree holds TRACKED files only, so without this `verify: "npm test"`
   * fails on every task before anything else runs. The default is Node-shaped:
   * a Python/Rust/Go project has to name its own (.venv, target, vendor).
   */
  worktree_link?: string[];
  /**
   * How many tasks may execute at the same time. Clamped to [1, 8] — the
   * binding constraint is agent spend and provider rate limits, not cores.
   *
   * 1 (the default) is the serial loop, byte for byte. Anything above 1 is
   * REFUSED unless worktree_per_task is on: two executors editing one checkout
   * is data loss, not a configuration. The real ceiling is the DAG's width, a
   * property of the plan and not of this knob. See README.
   */
  max_parallel_tasks?: number;
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
  worktree_per_task: false,
  worktree_link: ["node_modules"],
  max_parallel_tasks: 1,
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
  // The commit is the TRANSPORT out of a worktree — with commits off, nothing a
  // task does would ever leave it. Fail at load, where the user can see it, not
  // once per task at runtime.
  if (cfg.worktree_per_task && !cfg.commit_per_task) throw new Error(t("loop.err.worktreeNeedsCommit"));
  // `|| 1` also absorbs 0 and a non-numeric value from a hand-edited config
  cfg.max_parallel_tasks = Math.min(8, Math.max(1, Math.trunc(Number(cfg.max_parallel_tasks)) || 1));
  // Same reason as above, one step harder: without a worktree per task, two
  // executors share one checkout and overwrite each other's files. Refuse at
  // load rather than discovering it as a corrupted commit.
  if (cfg.max_parallel_tasks > 1 && !cfg.worktree_per_task) throw new Error(t("loop.err.parallelNeedsWorktree"));
  return cfg;
}
