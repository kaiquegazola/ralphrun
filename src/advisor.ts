// advisor.ts — CROSS-mode advisor: guidance before, review after

import { createInterface } from "node:readline";

import { buildCmd, promptViaStdin } from "./adapters.js";
import { agentDef, type AgentDef } from "./agents.js";
import type { AgentSpec, Config } from "./config.js";
import { runCursorSdkText } from "./cursor-sdk.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { PRD, Task } from "./prd.js";
import { advisorPrompt, parseReview, reviewPrompt, type VerificationEvidence } from "./prompts.js";
import { captureDiff } from "./git.js";
import { killTree, spawn, writePrompt } from "./spawn.js";
import { emit } from "./tui/events.js";

// see executor.ts — a killed child's grandchildren can hold the pipes open, so
// 'close' may never arrive. Settle on our own after this.
const KILL_GRACE_MS = 5_000;

export interface AdvisorReviewResult {
  approved: boolean;
  changes: string;
  diff: string;
  /**
   * A durable fact for the architecture notes, when the reviewer judged this
   * task taught one. Rides on the review call the task already makes, so it
   * costs no extra model call — and only ever comes off an APPROVE.
   */
  note?: string;
}

/**
 * Is THIS reviewer actually going to run commands? Both halves matter: the user
 * has to have opted in, and the cli has to have an execution grant to be given —
 * as argv flags (claude) or as config-borne env (opencode). Asked once and used
 * twice — the flags/env and the prompt have to agree, or a reviewer spends its
 * round trying tools it was never handed.
 */
function reviewerRuns(advis: AgentSpec, cfg: Config): boolean {
  const def = agentDef(advis.cli);
  return !!cfg.review_runs_commands && !!(def?.reviewExecArgs || def?.reviewEnv);
}

// exported for expand.ts: the JIT expansion rides the same spawn/parse path as
// guidance and review — one cli call, text back, no event stream.
export function runAdvisorCli(
  advis: AgentSpec,
  prompt: string,
  cfg: Config,
  workspace: string,
  taskId: string,
  source: "advisor" | "review",
  signal?: AbortSignal,
): Promise<string | null> {
  // An in-process backend has no command line, and its RunResult IS the stdout
  // the spawn path below accumulates — same contract, same return type. The
  // signal goes with it: a control honoured on the spawn reviewer and not on the
  // sdk one is the same one-backend wiring the handoff already got wrong once.
  if (agentDef(advis.cli)?.sdk) return runCursorSdkText(advis, prompt, cfg, workspace, taskId, source, undefined, signal);
  // autoApprove stays FALSE on both calls — the advisor must not be able to write.
  // The review additionally asks for the cli's read-only tools: the diff it judges
  // is cut at 12k chars and can be empty, and a reviewer with no way to open a file
  // has nothing but that text to go on. Guidance runs before any code exists, so
  // there is nothing to inspect and it stays text-only.
  const exec = source === "review" && reviewerRuns(advis, cfg);
  const cmd = buildCmd(advis.cli, prompt, advis.model, workspace, false, source === "review" ? (exec ? "exec" : "read") : "none");
  // The config-borne grant (opencode) rides in the env, scoped to the same
  // "read"/"exec" decision the argv flags got — a reviewer whose prompt says it
  // may run the suite must not open a config that forbids it, and vice versa.
  // The grant may carry a temp file the cli reads at startup, so its cleanup
  // runs on EVERY settle path below — nobody else will remove it.
  let granted: ReturnType<NonNullable<AgentDef["reviewEnv"]>> | undefined;
  try {
    granted = source === "review" ? agentDef(advis.cli)?.reviewEnv?.(exec ? "exec" : "read", workspace) : undefined;
  } catch {
    // a grant that cannot even be written must fail the review — NEVER fall
    // through to an unscoped reviewer running on the cli's permissive defaults
    return Promise.resolve(null);
  }
  const env = granted?.env;
  // Only the executing reviewer gets the longer budget: it is running a suite,
  // not composing an answer. Everything else keeps advisor_timeout, so a hung
  // read-only review still dies when it always did.
  const timeoutSecs = exec ? (cfg.review_timeout ?? cfg.advisor_timeout) : cfg.advisor_timeout;
  return new Promise((resolve) => {
    // never start one after the abort: the caller is already unwinding
    if (signal?.aborted) {
      granted?.cleanup();
      return resolve(null);
    }
    try {
      const viaStdin = promptViaStdin(advis.cli);
      const proc = spawn(cmd[0], cmd.slice(1), {
        cwd: workspace,
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
        // merged OVER process.env, never replacing it: the cli's auth, model
        // config and PATH all have to survive the grant
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      if (viaStdin) writePrompt(proc, prompt);

      // The RESULT is parsed from stdout only (the model's answer / review
      // verdict); stderr is streamed to the TUI for visibility but must NOT
      // enter `out`, or diagnostic noise could corrupt the parsed advice or flip
      // a review verdict.
      let out = "";
      const outRl = createInterface({ input: proc.stdout });
      outRl.on("line", (line) => {
        out += line + "\n";
        emit({ taskId, line, lineSource: source });
      });
      const errRl = createInterface({ input: proc.stderr });
      errRl.on("line", (line) => emit({ taskId, line, lineSource: source }));

      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const finish = (v: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(grace);
        signal?.removeEventListener("abort", onAbort);
        outRl.close();
        errRl.close();
        granted?.cleanup();
        resolve(v);
      };

      // The skip/quit key, on the phase that owns the longest budget in the
      // product (review_timeout, 900s with an executing reviewer). Same kill as
      // the timeout below, minus the grace window: nobody is waiting for the
      // verdict any more, and "no verdict" already means not approved.
      const onAbort = (): void => {
        killTree(proc);
        outRl.close();
        errRl.close();
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        finish(null);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timeout = setTimeout(() => {
        killTree(proc);
        // killed: a survivor must not keep writing into the parsed output
        outRl.close();
        errRl.close();
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        grace = setTimeout(() => finish(null), KILL_GRACE_MS);
        grace.unref?.();
      }, timeoutSecs * 1000);

      proc.on("close", () => finish(out.trim() || null));
      proc.on("error", () => finish(null));
    } catch {
      granted?.cleanup();
      resolve(null);
    }
  });
}

export async function getAdvice(
  task: Task,
  prd: PRD,
  advis: AgentSpec,
  cfg: Config,
  workspace: string,
  progress: string,
  standards: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const prompt = advisorPrompt(task, prd, standards);
  const advice = await runAdvisorCli(advis, prompt, cfg, workspace, task.id, "advisor", signal);
  if (advice === null) {
    log(progress, t("advisor.failed", { id: task.id }));
    return null;
  }
  log(progress, t("advisor.advice", { id: task.id, agent: `${advis.cli}:${advis.model}`, n: advice.length }));
  if (advice.trim()) emit({ taskId: task.id, line: compactLine(advice), lineSource: "advisor" });
  return advice;
}

export async function advisorReview(
  task: Task,
  prd: PRD,
  advis: AgentSpec,
  cfg: Config,
  workspace: string,
  progress: string,
  standards: string,
  reviewBase?: string | null,
  verification?: VerificationEvidence,
  signal?: AbortSignal,
): Promise<AdvisorReviewResult> {
  // The reviewer is a GATE, so "no verdict" is not a verdict. Each branch below
  // used to return approved:true, which is how a task reached `done` with
  // NOTHING having judged it: a dead reviewer, or an answer in neither format,
  // both counted as an approval.
  const diff = captureDiff(workspace, reviewBase);
  // An empty diff is NOT decided here: whether a task can be satisfied with no
  // change is a judgement about that task, so the reviewer makes it (the prompt
  // says what it is looking at). Only the spawn is unconditional now.
  if (!diff.trim()) log(progress, t("advisor.reviewNoDiff", { id: task.id }));
  const runs = reviewerRuns(advis, cfg);
  // A round that just got several minutes longer and several times more
  // expensive has to say so in the durable log, not only in the config file.
  if (runs) log(progress, t("advisor.reviewExec", { id: task.id, s: cfg.review_timeout ?? cfg.advisor_timeout }));
  const prompt = reviewPrompt(task, prd, standards, diff, verification, runs);
  const out = await runAdvisorCli(advis, prompt, cfg, workspace, task.id, "review", signal);
  if (out === null) {
    // `changes` stays EMPTY on purpose: a reviewer that never answered gives the
    // executor nothing to fix, so the fix loop breaks out (run.ts) and the task
    // blocks for a human rather than burning rounds re-running a dead reviewer.
    log(progress, t("advisor.reviewFailed", { id: task.id }));
    return { approved: false, changes: "", diff };
  }
  const parsed = parseReview(out);
  // Neither APPROVE nor CHANGES. Same empty-`changes` reasoning as above, but the
  // reviewer DID say something — log it, or the human deciding on the blocked
  // task has nothing to go on (review output never reaches progress.md).
  if (!parsed.approved && !parsed.changes) {
    log(progress, t("advisor.reviewUnparsed", { id: task.id, out: compactLine(out, 300) }));
  }
  emit({
    taskId: task.id,
    line: parsed.approved ? "APPROVE" : compactLine(parsed.changes || out),
    lineSource: "review",
  });
  return { ...parsed, diff };
}

function compactLine(value: string, max = 500): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1).trimEnd() + "…";
}
