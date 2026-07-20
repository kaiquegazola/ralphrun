// executor.ts — run the executor CLI, echoing output live with a heartbeat
//
// Node has no select(): we attach readline to stdout+stderr (merged) and run a
// heartbeat interval. A timeout side shoots the proc if task_timeout elapses.

import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { buildCmd } from "./adapters.js";
import { agentDef } from "./agents.js";
import type { AgentSpec, Config } from "./config.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { Task } from "./prd.js";
import { BLOCKED_MARKER } from "./prompts.js";
import { killTree, releasePipes, spawn } from "./spawn.js";
import { emit } from "./tui/events.js";

// after a kill, a surviving grandchild can hold the stdout pipe open so 'close'
// never arrives. Settle anyway once this elapses instead of hanging the run.
const KILL_GRACE_MS = 5_000;
// how long to wait after the process exits for readline to hand over a final,
// newline-less line before classifying the run anyway
const DRAIN_GRACE_MS = 2_000;

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
    // Streaming is for the EXECUTOR only. The advisor's stdout IS its answer
    // (advisor.ts parses it), so turning its output into events would feed the
    // reviewer's verdict a stream of JSON.
    const stream = cfg.stream_output === false ? undefined : agentDef(execu.cli)?.stream;
    const cmd = buildCmd(execu.cli, prompt, execu.model, workspace, true);
    cmd.push(...(stream?.args ?? []), ...extra, ...cfg.extra_executor_args);
    const tag = task.id;
    const timeout = cfg.task_timeout;
    const hb = cfg.heartbeat_secs ?? 30;

    const start = Date.now();
    let last = start; // last sign of life from the child
    let lastBeat = start; // last "…working" line — throttling only, kept SEPARATE
    //  from `last` so that resetting one to throttle the other cannot make the
    //  silence counter unable to accumulate.
    let timedOut = false;
    // the run's last displayed line, and whether it was the agent SPEAKING.
    // Both halves matter: tracking only prose would leave a stale marker line
    // standing after the agent carried on with tool calls, and not tracking
    // prose-ness would let a tool argument quoting the marker fail a good run.
    let lastLine = "";
    let lastWasProse = false;

    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // merge stderr into stdout for live echo
    const merged = new PassThrough();
    proc.stdout.pipe(merged);
    proc.stderr.pipe(merged);

    const rl = createInterface({ input: merged });
    rl.on("line", (raw) => {
      // every raw line is a sign of life, including the ones never displayed
      // (token counters, hook chatter)
      last = Date.now();
      const ev = stream ? stream.parse(raw) : { text: raw, prose: true };
      if (!ev) return;
      // The agent did more work, so whatever it last SAID is no longer its final
      // word — even when that work is invisible (a thinking-only turn, a tool
      // result). Without this a marker line the agent then moved on from would
      // still be standing at the end and would fail a run that succeeded.
      if (ev.activity) lastWasProse = false;
      // A cli that reports its final answer as its own event kind (claude's
      // `result`) hands it over here even though it is never displayed, so a
      // blocked marker that appears ONLY there is still heard.
      if (ev.final !== undefined) {
        const tail = ev.final.split("\n").filter((l) => l.trim()).pop();
        if (tail) {
          lastLine = tail.trim();
          lastWasProse = true;
        }
      }
      if (!ev.text) return;
      for (const line of ev.text.split("\n")) {
        if (line.trim()) {
          lastLine = line.trim();
          lastWasProse = ev.prose === true;
        }
        emit({ taskId: task.id, line, lineSource: "executor" });
        // The raw line is already emitted to the TUI above; keep it in progress.md
        // without routing a duplicate system line back into the live pane.
        if (line.trim()) log(progress, `  ${tag}› ${line}`, false);
      }
    });

    const hbTimer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= timeout * 1000) {
        timedOut = true;
        clearInterval(hbTimer);
        log(progress, t("exec.timeout", { tag, cli: execu.cli, s: Math.round(elapsed / 1000) }));
        killAndSettle();
        return;
      }
      emit({ taskId: task.id, elapsedMs: elapsed, timeoutMs: timeout * 1000 });
      if (Date.now() - last >= hb * 1000 && Date.now() - lastBeat >= hb * 1000) {
        lastBeat = Date.now();
        log(progress, t("exec.working", { tag, s: Math.round((Date.now() - start) / 1000) }));
      }
    }, Math.min(hb * 1000, 1000));

    // single-settle guard: abort / close / timeout can race — first one wins,
    // the rest are no-ops, and the abort listener is removed to avoid leaks.
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    // declared here, not next to their handlers below: the already-aborted path
    // calls finish() synchronously, before those declarations would be reached
    let drained = false;
    let exitCode: number | null | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      clearInterval(hbTimer);
      clearTimeout(grace);
      clearTimeout(drainTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(v);
    };
    // kill the whole tree, then settle on 'close' — or on the grace timer if a
    // surviving grandchild keeps the pipes open and 'close' never comes.
    const killAndSettle = (): void => {
      killTree(proc);
      releasePipes(proc, merged, rl); // killed: a survivor must not keep writing
      grace = setTimeout(() => finish(false), KILL_GRACE_MS);
      grace.unref?.();
    };
    const onAbort = (): void => {
      log(progress, t("exec.skipped", { tag, cli: execu.cli }));
      killTree(proc);
      releasePipes(proc, merged, rl);
      finish(false);
    };
    if (signal) {
      if (signal.aborted) {
        killTree(proc);
        releasePipes(proc, merged, rl);
        return finish(false);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // readline only emits a newline-less FINAL line when the stream ends, which
    // can land after the process 'close'. Deciding at 'close' would therefore
    // miss a blocked marker printed without a trailing newline — the exact
    // false success this signal exists to prevent. So wait for the output to
    // drain, bounded, before classifying the run.
    rl.on("close", () => {
      drained = true;
      settleClose();
    });

    const settleClose = (): void => {
      if (exitCode === undefined || !drained) return;
      clearTimeout(drainTimer);
      if (lastWasProse && lastLine.startsWith(BLOCKED_MARKER)) {
        // exit 0 but the agent's last word was "I could not proceed" — the
        // verify gate must NOT get a chance to call this task done
        log(progress, t("exec.blocked", { tag, reason: lastLine.slice(BLOCKED_MARKER.length).trim() }));
        return finish(false);
      }
      finish(exitCode === 0);
    };

    proc.on("close", (code) => {
      // a spawn 'error' (or an abort) can settle the run before 'close' lands —
      // going on would arm a drain timer for a promise nobody is waiting on
      if (settled) return;
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (timedOut) return finish(false); // already logged when the timeout fired
      log(progress, `  ${tag}: ${execu.cli} exit=${code} (${elapsed}s)`);
      exitCode = code;
      // don't wait forever for a stream a survivor may be holding open
      drainTimer = setTimeout(() => {
        drained = true;
        settleClose();
      }, DRAIN_GRACE_MS);
      drainTimer.unref?.();
      settleClose();
    });

    proc.on("error", (err) => {
      log(progress, t("exec.spawnFailed", { tag, cli: execu.cli, msg: err.message }));
      finish(false);
    });
  });
}
