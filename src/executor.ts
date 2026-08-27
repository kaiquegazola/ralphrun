// executor.ts — run the executor CLI, echoing output live with a heartbeat
//
// Node has no select(): we attach readline to stdout+stderr (merged) and run a
// heartbeat interval. A timeout side shoots the proc if task_timeout elapses.

import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { buildCmd, promptViaStdin } from "./adapters.js";
import { agentDef } from "./agents.js";
import type { AgentSpec, Config } from "./config.js";
import { runCursorSdkExecutor } from "./cursor-sdk.js";
import { startIdleLadder } from "./idleness.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { Task } from "./prd.js";
import { BLOCKED_MARKER } from "./prompts.js";
import { killTree, releasePipes, spawn, writePrompt } from "./spawn.js";
import { MAX_TAIL_CHARS, MAX_TAIL_LINES, type CostSink } from "./stream.js";
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
  onCost?: CostSink,
  /**
   * The agent's whole final message. The next attempt gets it as a handoff, so
   * it does not re-derive what this one already found — see run.ts. Only the
   * last LINE of it is used for the blocked-marker check; the rest was being
   * thrown away.
   */
  onFinal?: (text: string) => void,
  runtimeEnv?: NodeJS.ProcessEnv,
): Promise<boolean> {
  // in-process backend: it owns its own heartbeat and marker classification,
  // because there is no child process to attach readline to
  if (agentDef(execu.cli)?.sdk) {
    return runCursorSdkExecutor(execu, prompt, cfg, workspace, progress, task, signal, undefined, onCost, onFinal);
  }
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
    //
    // Both halves need a PARSER, though. With no `stream` entry (only claude has
    // one) or with stream_output off, line 106 below synthesises
    // `{ text: raw, prose: true }` for every line: `prose` is then always true,
    // `activity` never fires, and the marker check degrades to "the last
    // non-empty line of merged stdout+stderr". Staleness is still mostly covered
    // there — any later displayed line overwrites this one — but tool-argument
    // immunity is not available at all, because there is no schema to tell a
    // tool argument from prose.
    let lastLine = "";
    let lastWasProse = false;
    // undefined until a cli actually reports a figure: "nobody measured" and
    // "measured zero" must not collapse into the same number
    let costUsd: number | undefined;
    let finalText: string | undefined;
    // The handoff for a cli that reports no structured final answer — which is
    // every cli but claude, and claude itself with stream_output off. Its last
    // PROSE lines are the closest thing it has to a closing statement, and
    // without this the handoff would silently work on one backend out of seven.
    // Bounded: an agent that ends by pasting a file must not hand the next
    // attempt a prompt-sized wall of it.
    const proseTail: string[] = [];

    const viaStdin = promptViaStdin(execu.cli);
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: workspace,
      stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: runtimeEnv ? { ...process.env, ...runtimeEnv } : undefined,
    });
    if (viaStdin) writePrompt(proc, prompt);

    // The silence ladder sits UNDER task_timeout (which stays the absolute
    // wall-clock ceiling): continuous silence climbs a rung every step — early
    // rungs announce in the durable log, the last kills as HUNG, which is a
    // different death than the budget timeout and says so. Step size shrinks
    // with the budget so a small task_timeout still gets a full ladder under
    // it; every line below resets to rung zero.
    const silenceStepMs = Math.min(180_000, Math.round((timeout * 1000) / 6));
    let stalledOut = false;
    const idle = startIdleLadder({
      stepMs: silenceStepMs,
      steps: 4,
      warn: (mins) =>
        log(progress, t("exec.silent", { tag, cli: execu.cli, mins: Math.max(1, Math.round(mins)) })),
      fatal: () => {
        stalledOut = true;
        log(progress, t("exec.stalled", { tag, cli: execu.cli, mins: Math.max(1, Math.round((Date.now() - last) / 60_000)) }));
        killAndSettle();
      },
    });
    idle.bump(); // arm at spawn: zero-output silence climbs too

    // merge stderr into stdout for live echo
    const merged = new PassThrough();
    proc.stdout.pipe(merged);
    proc.stderr.pipe(merged);

    const rl = createInterface({ input: merged });
    rl.on("line", (raw) => {
      // every raw line is a sign of life, including the ones never displayed
      // (token counters, hook chatter)
      last = Date.now();
      idle.bump();
      const ev = stream ? stream.parse(raw) : { text: raw, prose: true };
      if (!ev) return;
      // The agent did more work, so whatever it last SAID is no longer its final
      // word — even when that work is invisible (a thinking-only turn, a tool
      // result). Without this a marker line the agent then moved on from would
      // still be standing at the end and would fail a run that succeeded.
      if (ev.activity) lastWasProse = false;
      // summed, not assigned: a cli free to report per-turn costs must not have
      // its last turn silently replace everything before it
      if (ev.costUsd !== undefined) costUsd = (costUsd ?? 0) + ev.costUsd;
      // A cli that reports its final answer as its own event kind (claude's
      // `result`) hands it over here even though it is never displayed, so a
      // blocked marker that appears ONLY there is still heard.
      if (ev.final !== undefined) {
        finalText = ev.final;
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
          // prose only: a tool summary ("→ Edit(x)") is the harness narrating,
          // and the next attempt can read the diff for what was edited
          // proseText, not the line: a turn that speaks AND calls a tool renders
          // both into `text` under one `prose` flag, so pushing by line would
          // hand the retry a "→ Edit(x)" the diff already shows. No parser means
          // no summaries to separate, and there `text` is all the agent said.
          if (ev.prose && (ev.proseText ?? ev.text).split("\n").includes(line)) {
            proseTail.push(line.trim());
            if (proseTail.length > MAX_TAIL_LINES) proseTail.shift();
          }
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
      idle.stop();
      clearTimeout(grace);
      clearTimeout(drainTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      // the single settle guard above is what makes this exactly-once, on every
      // path — including the timeout and abort ones, which were still billed
      onCost?.(costUsd);
      // the structured answer when the cli gives one, its last words otherwise
      const handoff = (finalText?.trim() || proseTail.join("\n")).slice(-MAX_TAIL_CHARS).trim();
      if (handoff) onFinal?.(handoff);
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
      log(progress, t(signal?.reason === "quit" ? "exec.quit" : "exec.skipped", { tag, cli: execu.cli }));
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
      if (stalledOut) return finish(false); // already logged when the ladder fired
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
