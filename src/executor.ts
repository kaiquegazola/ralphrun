// executor.ts — run the executor CLI, echoing output live with a heartbeat
//
// Node has no select(): we attach readline to stdout+stderr (merged) and run a
// heartbeat interval. A timeout side shoots the proc if task_timeout elapses.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { buildCmd } from "./adapters.js";
import type { AgentSpec, Config } from "./config.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { Task } from "./prd.js";
import { emit } from "./tui/events.js";

export function runExecutor(
  execu: AgentSpec,
  prompt: string,
  cfg: Config,
  workspace: string,
  progress: string,
  task: Task,
  extra: string[] = [],
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = buildCmd(execu.cli, prompt, execu.model, workspace, true);
    cmd.push(...extra, ...cfg.extra_executor_args);
    const tag = task.id;
    const timeout = cfg.task_timeout;
    const hb = cfg.heartbeat_secs ?? 30;

    const start = Date.now();
    let last = start;
    let timedOut = false;

    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // merge stderr into stdout for live echo
    const merged = new PassThrough();
    proc.stdout.pipe(merged);
    proc.stderr.pipe(merged);

    const rl = createInterface({ input: merged });
    rl.on("line", (line) => {
      last = Date.now();
      emit({ taskId: task.id, line, lineSource: "executor" });
      // The raw line is already emitted to the TUI above; keep it in progress.md
      // without routing a duplicate system line back into the live pane.
      if (line.trim()) log(progress, `  ${tag}› ${line}`, false);
    });

    const hbTimer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= timeout * 1000) {
        timedOut = true;
        proc.kill("SIGKILL");
        clearInterval(hbTimer);
        return;
      }
      emit({ taskId: task.id, elapsedMs: elapsed, timeoutMs: timeout * 1000 });
      if (Date.now() - last >= hb * 1000) {
        last = Date.now();
        log(progress, t("exec.working", { tag, s: Math.round((Date.now() - start) / 1000) }));
      }
    }, Math.min(hb * 1000, 1000));

    // single-settle guard: abort / close / timeout can race — first one wins,
    // the rest are no-ops, and the abort listener is removed to avoid leaks.
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      clearInterval(hbTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onAbort = (): void => {
      log(progress, t("exec.skipped", { tag, cli: execu.cli }));
      proc.kill("SIGKILL");
      finish(false);
    };
    if (signal) {
      if (signal.aborted) {
        proc.kill("SIGKILL");
        return finish(false);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("close", (code) => {
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (timedOut) {
        log(progress, t("exec.timeout", { tag, cli: execu.cli, s: elapsed }));
        return finish(false);
      }
      log(progress, `  ${tag}: ${execu.cli} exit=${code} (${elapsed}s)`);
      finish(code === 0);
    });

    proc.on("error", (err) => {
      log(progress, t("exec.spawnFailed", { tag, cli: execu.cli, msg: err.message }));
      finish(false);
    });
  });
}
