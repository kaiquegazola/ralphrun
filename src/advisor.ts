// advisor.ts — CROSS-mode advisor: guidance before, review after

import { createInterface } from "node:readline";
import { isAbsolute, relative, resolve } from "node:path";

import { buildCmd, promptViaStdin } from "./adapters.js";
import { agentDef, type AgentDef } from "./agents.js";
import type { AgentSpec, Config } from "./config.js";
import { runCursorSdkText } from "./cursor-sdk.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { PRD, ScopeRequest, Task } from "./prd.js";
import {
  advisorPrompt,
  formatReviewFindings,
  parseReview,
  reviewPrompt,
  type ReviewContext,
  type ReviewCommit,
  type ReviewFinding,
  type VerificationEvidence,
} from "./prompts.js";
import { captureDiff } from "./git.js";
import { BRAIN_DIRECTORY } from "./brain.js";
import { pathsOutsideScopeContract, taskScopeContract } from "./prdload.js";
import { killTree, spawn, writePrompt } from "./spawn.js";
import { emit } from "./tui/events.js";

// see executor.ts — a killed child's grandchildren can hold the pipes open, so
// 'close' may never arrive. Settle on our own after this.
const KILL_GRACE_MS = 5_000;

// A provider blip — finish_reason: network_error, a reset socket, a 5xx — kills
// the cli call before it says a word, and every null below reads as "not
// approved". That is how one flaky minute used to burn a review round and block
// a task whose code was fine: infrastructure no executor fix could address.
// The tail of what the child printed (BOTH pipes — some clis announce provider
// errors on stdout) is matched against these markers; every other way of
// settling null (timeout, abort, empty answer) keeps the old behaviour.
const NETWORK_BLIP_MARKERS = [
  "network_error",
  "network error",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "etimedout",
  "enotfound",
  "eai_again",
  "fetch failed",
  "socket hang up",
  "rate limit",
  "overloaded",
  "bad gateway",
  "service unavailable",
];
// Five escalating shots — a dead Wi-Fi minute, an ISP blip or a provider
// incident all outlast one short wait, and burning a whole task round (plus its
// executor re-run) costs far more than ~4 minutes of patient backoff ever will.
// Exported for the tests, which walk the whole ladder.
export const NETWORK_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

function looksLikeNetworkBlip(tail: string): boolean {
  const hay = tail.toLowerCase();
  return NETWORK_BLIP_MARKERS.some((m) => hay.includes(m));
}

/** resolves true when the wait elapsed; false when the abort cut it short */
function delayMs(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface AdvisorReviewResult {
  approved: boolean;
  changes: string;
  diff: string;
  /** A constrained replacement for task.verify proposed by the reviewer. */
  verify?: string;
  findings?: ReviewFinding[];
  /** No actionable verdict arrived; retry the reviewer before asking the executor to change code. */
  reviewRetryable?: boolean;
  /** The reviewer found only fixes the task's plan forbids. */
  scopePlanIssuePaths?: string[];
  scopePlanRequests?: ScopeRequest[];
  commit?: ReviewCommit;
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
export async function runAdvisorCli(
  advis: AgentSpec,
  prompt: string,
  cfg: Config,
  workspace: string,
  taskId: string,
  source: "advisor" | "review",
  signal?: AbortSignal,
  /** where retry notices are recorded; callers without one just stay silent */
  progress?: string,
  runtimeEnv?: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const { answer, tail } = await runAdvisorCliAttempt(advis, prompt, cfg, workspace, taskId, source, signal, runtimeEnv);
    // An aborted call settled null because the USER skipped it — never a blip,
    // so no wait and no second spawn after the skip. Same for every null whose
    // pipes carry no network marker.
    if (answer !== null || signal?.aborted || attempt > NETWORK_RETRY_DELAYS_MS.length || !looksLikeNetworkBlip(tail)) {
      return answer;
    }
    if (progress) {
      const waitMs = NETWORK_RETRY_DELAYS_MS[attempt - 1];
      log(
        progress,
        t("advisor.networkRetry", {
          id: taskId,
          src: source,
          s: Math.round(waitMs / 1000),
          n: attempt,
          max: NETWORK_RETRY_DELAYS_MS.length,
        }),
      );
    }
    if (!(await delayMs(NETWORK_RETRY_DELAYS_MS[attempt - 1], signal))) return null;
  }
}

async function runAdvisorCliAttempt(
  advis: AgentSpec,
  prompt: string,
  cfg: Config,
  workspace: string,
  taskId: string,
  source: "advisor" | "review",
  signal?: AbortSignal,
  runtimeEnv?: NodeJS.ProcessEnv,
): Promise<{ answer: string | null; tail: string }> {
  // An in-process backend has no command line, and its RunResult IS the stdout
  // the spawn path below accumulates — same contract, same return type. The
  // signal goes with it: a control honoured on the spawn reviewer and not on the
  // sdk one is the same one-backend wiring the handoff already got wrong once.
  // ponytail: KNOWN CEILING — the sdk runner keeps its error text to itself, so
  // its failures never match the markers and never retry.
  if (agentDef(advis.cli)?.sdk)
    return { answer: await runCursorSdkText(advis, prompt, cfg, workspace, taskId, source, undefined, signal), tail: "" };
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
  } catch (e) {
    // a grant that cannot even be written must fail the review — NEVER fall
    // through to an unscoped reviewer running on the cli's permissive defaults
    return { answer: null, tail: String(e) };
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
      return resolve({ answer: null, tail: "" });
    }
    try {
      const viaStdin = promptViaStdin(advis.cli);
      const proc = spawn(cmd[0], cmd.slice(1), {
        cwd: workspace,
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
        // merged OVER process.env, never replacing it: the cli's auth, model
        // config and PATH all have to survive the grant
        ...((env || runtimeEnv) ? { env: { ...process.env, ...runtimeEnv, ...env } } : {}),
      });
      if (viaStdin) writePrompt(proc, prompt);

      // The RESULT is parsed from stdout only (the model's answer / review
      // verdict); stderr is streamed to the TUI for visibility but must NOT
      // enter `out`, or diagnostic noise could corrupt the parsed advice or flip
      // a review verdict.
      let out = "";
      let tail = ""; // bounded last-4k of both pipes — the network-blip evidence
      const keep = (chunk: string): void => {
        out += chunk + "\n";
        tail = (tail + chunk + "\n").slice(-4000);
      };
      const outRl = createInterface({ input: proc.stdout });
      outRl.on("line", (line) => {
        keep(line);
        emit({ taskId, line, lineSource: source });
      });
      const errRl = createInterface({ input: proc.stderr });
      errRl.on("line", (line) => {
        tail = (tail + line + "\n").slice(-4000);
        emit({ taskId, line, lineSource: source });
      });

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
        resolve({ answer: v, tail });
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
      proc.on("error", (e) => {
        tail = (tail + String(e) + "\n").slice(-4000);
        finish(null);
      });
    } catch (e) {
      granted?.cleanup();
      resolve({ answer: null, tail: String(e) });
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
  const prompt = advisorPrompt(task, prd, standards, workspace);
  const advice = await runAdvisorCli(advis, prompt, cfg, workspace, task.id, "advisor", signal, progress);
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
  context?: ReviewContext,
): Promise<AdvisorReviewResult> {
  // The reviewer is a GATE, so "no verdict" is not a verdict. Each branch below
  // used to return approved:true, which is how a task reached `done` with
  // NOTHING having judged it: a dead reviewer, or an answer in neither format,
  // both counted as an approval.
  const diff = captureDiff(workspace, reviewBase, [BRAIN_DIRECTORY]);
  // An empty diff is NOT decided here: whether a task can be satisfied with no
  // change is a judgement about that task, so the reviewer makes it (the prompt
  // says what it is looking at). Only the spawn is unconditional now.
  if (!diff.trim()) {
    log(
      progress,
      t(context?.executionReport?.state === "already_satisfied" ? "advisor.reviewAlreadySatisfied" : "advisor.reviewNoDiff", {
        id: task.id,
      }),
    );
  }
  const runs = reviewerRuns(advis, cfg);
  // A round that just got several minutes longer and several times more
  // expensive has to say so in the durable log, not only in the config file.
  if (runs) log(progress, t("advisor.reviewExec", { id: task.id, s: cfg.review_timeout ?? cfg.advisor_timeout }));
  const prompt = reviewPrompt(task, prd, standards, diff, verification, runs, context, workspace);
  const out = await runAdvisorCli(advis, prompt, cfg, workspace, task.id, "review", signal, progress, context?.runtimeEnv);
  if (out === null) {
    // `changes` stays EMPTY on purpose: a reviewer that never answered gives the
    // executor nothing to fix. run.ts retries the reviewer with the same evidence
    // instead of sending the executor into a blind fix round.
    log(progress, t("advisor.reviewFailed", { id: task.id }));
    return { approved: false, changes: "", diff, reviewRetryable: true };
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
  const withDiff = { ...parsed, diff, ...(!parsed.approved && !parsed.changes ? { reviewRetryable: true } : {}) };
  const findings = withDiff.findings ?? [];
  const filtered = filterReviewFindings(findings, taskScopeContract(task), workspace);
  if (filtered.dropped.length > 0) {
    const paths = filtered.dropped
      .map((finding) => locationRepoPath(finding.location, workspace))
      .filter((path): path is string => !!path);
    log(
      progress,
      t("advisor.reviewScopeFiltered", {
        id: task.id,
        n: filtered.dropped.length,
        paths: [...new Set(paths)].join(", "),
      }),
    );
  }
  if (filtered.planIssuePaths.length > 0) {
    log(progress, t("advisor.reviewScopePlan", { id: task.id, paths: filtered.planIssuePaths.join(", ") }));
  }
  return {
    ...withDiff,
    ...(findings.length > 0
      ? {
          findings: filtered.findings,
          // parseReview derives changes from structured findings. Re-derive it
          // after filtering so the executor cannot be told to implement the
          // very out-of-scope fix the gate would later reject.
          changes: parsed.approved ? "" : formatReviewFindings(filtered.findings),
        }
      : {}),
    ...(filtered.planIssuePaths.length > 0 ? { scopePlanIssuePaths: filtered.planIssuePaths } : {}),
    ...(filtered.planRequests.length > 0 ? { scopePlanRequests: filtered.planRequests } : {}),
  };
}

function compactLine(value: string, max = 500): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1).trimEnd() + "…";
}

/**
 * A location is evidence only when it names a file inside this checkout. A
 * missing/odd location stays attached to the finding: filtering it would turn
 * "we cannot prove this is outside scope" into a silent loss of a blocker.
 */
function locationRepoPath(location: string | undefined, workspace: string): string | undefined {
  if (!location || location.includes("\0")) return undefined;
  const match = location.trim().match(/^(.+?):\d+(?::\d+)?$/);
  if (!match) return undefined;
  const candidate = match[1].trim();
  if (!candidate || candidate.includes("\0")) return undefined;
  const root = resolve(workspace);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const repoPath = relative(root, absolute).replace(/\\/g, "/");
  if (!repoPath || repoPath === ".." || repoPath.startsWith("../") || isAbsolute(repoPath)) return undefined;
  return repoPath;
}

function filterReviewFindings(
  findings: ReviewFinding[],
  contract: ReturnType<typeof taskScopeContract>,
  workspace: string,
): { findings: ReviewFinding[]; dropped: ReviewFinding[]; planIssuePaths: string[]; planRequests: ScopeRequest[] } {
  // Empty scope means unrestricted here just as it does in the objective gate;
  // calling the matcher anyway would make a legacy task pay for a reviewer-only
  // policy that the actual merge gate does not enforce.
  if (contract.owned.length === 0 && contract.shared.length === 0 && contract.forbidden.length === 0) {
    return { findings, dropped: [], planIssuePaths: [], planRequests: [] };
  }
  const dropped: ReviewFinding[] = [];
  const kept = findings.filter((finding) => {
    const path = locationRepoPath(finding.location, workspace);
    // No location, malformed location, or a path outside this checkout is not
    // proof of an escape. Keep it so a genuine blocker cannot disappear merely
    // because the reviewer supplied weak evidence.
    if (!path || pathsOutsideScopeContract([path], contract).length === 0) return true;
    dropped.push(finding);
    return false;
  });
  const droppedBlocking = dropped.filter((f) => f.severity === "blocker" || f.severity === "major");
  const planIssuePaths =
    droppedBlocking.length > 0
      ? [...new Set(droppedBlocking.map((f) => locationRepoPath(f.location, workspace)).filter((p): p is string => !!p))]
      : [];
  const planRequests =
    planIssuePaths.length > 0
      ? dropped
          .filter((finding) => {
            const path = locationRepoPath(finding.location, workspace);
            return (finding.severity === "blocker" || finding.severity === "major") && !!path && planIssuePaths.includes(path);
          })
          .map((finding) => ({
            paths: [locationRepoPath(finding.location, workspace)!],
            reason: finding.id + ": " + finding.problem + " Fix: " + finding.fix,
          }))
      : [];
  return { findings: kept, dropped, planIssuePaths, planRequests };
}
