// verify.ts — objective test gate + unified feedback assembly

import { spawnSync } from "node:child_process";

import { t } from "./i18n.js";
import { log } from "./log.js";
import type { Task } from "./prd.js";

export function runVerify(task: Task, workspace: string, progress: string): { passed: boolean; output: string } {
  const cmd = task.verify;
  if (!cmd) return { passed: true, output: "" };
  try {
    const p = spawnSync(cmd, {
      shell: true,
      cwd: workspace,
      encoding: "utf8",
      timeout: 600_000,
    });
    const out = ((p.stdout ?? "") + (p.stderr ?? "")).slice(-4000);
    if (p.status !== 0) {
      log(progress, t("verify.failed", { id: task.id, status: String(p.status) }) + `\n${out.slice(-1500)}`);
    }
    return { passed: p.status === 0, output: out };
  } catch (e) {
    log(progress, t("verify.crashed", { id: task.id, msg: e instanceof Error ? e.message : String(e) }));
    return { passed: false, output: String(e) };
  }
}

export function assembleFeedback(
  execOk: boolean,
  testOk: boolean,
  testOut: string,
  approved: boolean,
  changes: string,
): string {
  const parts: string[] = [];
  if (!execOk) parts.push("## Your previous run exited non-zero. Make the task complete cleanly.");
  if (!testOk) parts.push("## Tests are failing — fix them:\n" + testOut.slice(-3000));
  if (!approved && changes) parts.push("## Reviewer requested changes (address ALL):\n" + changes);
  return parts.join("\n\n");
}