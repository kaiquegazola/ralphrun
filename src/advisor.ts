// advisor.ts — CROSS-mode advisor: guidance before, review after

import { createInterface } from "node:readline";

import { buildCmd, promptViaStdin } from "./adapters.js";
import { agentDef } from "./agents.js";
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
}

function runAdvisorCli(
  advis: AgentSpec,
  prompt: string,
  cfg: Config,
  workspace: string,
  taskId: string,
  source: "advisor" | "review",
): Promise<string | null> {
  // An in-process backend has no command line, and its RunResult IS the stdout
  // the spawn path below accumulates — same contract, same return type.
  if (agentDef(advis.cli)?.sdk) return runCursorSdkText(advis, prompt, cfg, workspace, taskId, source);
  const cmd = buildCmd(advis.cli, prompt, advis.model, workspace, false);
  return new Promise((resolve) => {
    try {
      const viaStdin = promptViaStdin(advis.cli);
      const proc = spawn(cmd[0], cmd.slice(1), {
        cwd: workspace,
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
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
        outRl.close();
        errRl.close();
        resolve(v);
      };

      const timeout = setTimeout(() => {
        killTree(proc);
        // killed: a survivor must not keep writing into the parsed output
        outRl.close();
        errRl.close();
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        grace = setTimeout(() => finish(null), KILL_GRACE_MS);
        grace.unref?.();
      }, cfg.advisor_timeout * 1000);

      proc.on("close", () => finish(out.trim() || null));
      proc.on("error", () => finish(null));
    } catch {
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
): Promise<string | null> {
  const prompt = advisorPrompt(task, prd, standards);
  const advice = await runAdvisorCli(advis, prompt, cfg, workspace, task.id, "advisor");
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
  const prompt = reviewPrompt(task, prd, standards, diff, verification);
  const out = await runAdvisorCli(advis, prompt, cfg, workspace, task.id, "review");
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
