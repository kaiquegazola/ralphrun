// advisor.ts — CROSS-mode advisor: guidance before, review after

import { createInterface } from "node:readline";

import { buildCmd } from "./adapters.js";
import type { AgentSpec, Config } from "./config.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { PRD, Task } from "./prd.js";
import { advisorPrompt, parseReview, reviewPrompt } from "./prompts.js";
import { captureDiff } from "./git.js";
import { killTree, spawn } from "./spawn.js";
import { emit } from "./tui/events.js";

// see executor.ts — a killed child's grandchildren can hold the pipes open, so
// 'close' may never arrive. Settle on our own after this.
const KILL_GRACE_MS = 5_000;

export interface AdvisorReviewResult {
  approved: boolean;
  changes: string;
  diff: string;
}

function runAdvisorCli(advis: AgentSpec, cmd: string[], cfg: Config, workspace: string, taskId: string, source: "advisor" | "review"): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd[0], cmd.slice(1), {
        cwd: workspace,
        stdio: ["ignore", "pipe", "pipe"],
      });

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
  const cmd = buildCmd(advis.cli, advisorPrompt(task, prd, standards), advis.model, workspace, false);
  const advice = await runAdvisorCli(advis, cmd, cfg, workspace, task.id, "advisor");
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
): Promise<AdvisorReviewResult> {
  const diff = captureDiff(workspace, reviewBase);
  if (!diff.trim()) return { approved: true, changes: "", diff };
  const cmd = buildCmd(advis.cli, reviewPrompt(task, prd, standards, diff), advis.model, workspace, false);
  const out = await runAdvisorCli(advis, cmd, cfg, workspace, task.id, "review");
  if (out === null) {
    log(progress, t("advisor.reviewFailed", { id: task.id }));
    return { approved: true, changes: "", diff };
  }
  const parsed = parseReview(out);
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
