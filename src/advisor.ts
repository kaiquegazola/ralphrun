// advisor.ts — CROSS-mode advisor: guidance before, review after

import { spawnSync } from "node:child_process";

import { buildCmd } from "./adapters.js";
import type { AgentSpec, Config } from "./config.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { PRD, Task } from "./prd.js";
import { advisorPrompt, parseReview, reviewPrompt } from "./prompts.js";
import { captureDiff } from "./git.js";
import { emit } from "./tui/events.js";

export interface AdvisorReviewResult {
  approved: boolean;
  changes: string;
  diff: string;
}

function runAdvisorCli(advis: AgentSpec, cmd: string[], cfg: Config, workspace: string): string | null {
  try {
    const p = spawnSync(cmd[0], cmd.slice(1), {
      cwd: workspace,
      encoding: "utf8",
      timeout: cfg.advisor_timeout * 1000,
    });
    return (p.stdout ?? "").trim();
  } catch {
    return null;
  }
}

export function getAdvice(
  task: Task,
  prd: PRD,
  advis: AgentSpec,
  cfg: Config,
  workspace: string,
  progress: string,
  standards: string,
): string | null {
  const cmd = buildCmd(advis.cli, advisorPrompt(task, prd, standards), advis.model, workspace, false);
  const advice = runAdvisorCli(advis, cmd, cfg, workspace);
  if (advice === null) {
    log(progress, t("advisor.failed", { id: task.id }));
    return null;
  }
  log(progress, t("advisor.advice", { id: task.id, agent: `${advis.cli}:${advis.model}`, n: advice.length }));
  if (advice.trim()) emit({ taskId: task.id, line: compactLine(advice), lineSource: "advisor" });
  return advice || null;
}

export function advisorReview(
  task: Task,
  prd: PRD,
  advis: AgentSpec,
  cfg: Config,
  workspace: string,
  progress: string,
  standards: string,
  reviewBase?: string | null,
): AdvisorReviewResult {
  const diff = captureDiff(workspace, reviewBase);
  if (!diff.trim()) return { approved: true, changes: "", diff };
  const cmd = buildCmd(advis.cli, reviewPrompt(task, prd, standards, diff), advis.model, workspace, false);
  const out = runAdvisorCli(advis, cmd, cfg, workspace);
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
