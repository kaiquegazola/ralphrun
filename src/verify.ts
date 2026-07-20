// verify.ts — objective test gate + unified feedback assembly

import { t } from "./i18n.js";
import { log } from "./log.js";
import type { Task } from "./prd.js";
import { killTree, spawn } from "./spawn.js";

const VERIFY_TIMEOUT_MS = 600_000;
// a killed command's children can hold the pipes open, so 'close' may never
// arrive — settle on our own after this (same reasoning as executor.ts)
const KILL_GRACE_MS = 5_000;
// verify output is only ever read as feedback; keeping the whole thing in memory
// would let one runaway command (a test suite in a retry loop) eat the heap
const MAX_OUTPUT_CHARS = 200_000;

/**
 * Run the task's verify command.
 *
 * Async on purpose: the old spawnSync could not kill a TREE. Its `timeout`
 * option signals the shell only, so a `npm test` that hung left its children
 * running — and on POSIX those children also hold the pipes, so nothing was
 * cleaned up. killTree takes the whole group, exactly like the executor.
 */
export function runVerify(task: Task, workspace: string, progress: string): Promise<{ passed: boolean; output: string }> {
  const cmd = task.verify;
  if (!cmd) return Promise.resolve({ passed: true, output: "" });

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, [], { cwd: workspace, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      log(progress, t("verify.crashed", { id: task.id, msg: e instanceof Error ? e.message : String(e) }));
      return resolve({ passed: false, output: String(e) });
    }

    let out = "";
    const collect = (chunk: Buffer): void => {
      out += chunk.toString();
      if (out.length > MAX_OUTPUT_CHARS) out = out.slice(-MAX_OUTPUT_CHARS);
    };
    proc.stdout.on("data", collect);
    proc.stderr.on("data", collect);

    let settled = false;
    let timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      const tail = out.slice(-4000);
      if (timedOut) log(progress, t("verify.timeout", { id: task.id, s: VERIFY_TIMEOUT_MS / 1000 }));
      else if (status !== 0) log(progress, t("verify.failed", { id: task.id, status: String(status) }) + `\n${tail.slice(-1500)}`);
      resolve({ passed: !timedOut && status === 0, output: tail });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc);
      grace = setTimeout(() => finish(null), KILL_GRACE_MS);
      grace.unref?.();
    }, VERIFY_TIMEOUT_MS);

    proc.on("close", (code) => finish(code));
    proc.on("error", (err) => {
      // the settled check comes FIRST: a stream error arriving after the command
      // already closed must not log "crashed" over a verdict we have shipped
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      log(progress, t("verify.crashed", { id: task.id, msg: err.message }));
      resolve({ passed: false, output: String(err) });
    });
  });
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
