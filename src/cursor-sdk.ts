// cursor-sdk.ts — drive Cursor's coding agent IN-PROCESS via the optional
// @cursor/sdk, as a sibling of the `cursor` CLI backend.
//
// Why: the CLI pays a process boot per call (measured 1.07s for
// `cursor-agent --version` alone) and ralphrun calls the executor up to
// max_review_rounds+1 times per task; in-process also gives typed events, a
// real cancel, and no cmd.exe 8191-char argv limit on Windows.
//
// Nothing in here deletes anything: `cwd` is the user's own repository, never a
// temp dir, so none of the cancel/cleanup race machinery a temp-dir runner needs
// applies. `stop()` cancels and closes; the filesystem is left alone.

import { createRequire } from "node:module";

import type { AgentSpec, Config } from "./config.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import type { Task } from "./prd.js";
import { BLOCKED_MARKER } from "./prompts.js";
import { assistantEvent, reportedCostUsd, toolSummary, type CostSink, type StreamEvent } from "./stream.js";
import { emit } from "./tui/events.js";

// Structural mirrors of @cursor/sdk, covering ONLY the fields this module
// touches. Not `import type`: the package is an optional peerDependency, so a real
// import breaks `tsc --noEmit` wherever the optional install was skipped.
export interface CursorModelParam {
  id: string;
  value: string;
}

export interface CursorAgentOptions {
  apiKey: string;
  model: { id: string; params?: CursorModelParam[] };
  mode?: "agent" | "plan";
  local: {
    cwd: string;
    settingSources: string[];
    sandboxOptions: { enabled: boolean };
  };
}

/** the SDKMessage union, flattened to the fields the renderer reads */
export interface CursorMessage {
  type: string;
  /** the assistant envelope — or, on a `status` message, the status text itself */
  message?: { content?: unknown[] } | string;
  name?: string;
  args?: unknown;
  status?: string;
  text?: string;
}

export interface CursorRunResult {
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: { message: string };
}

export interface CursorRun {
  supports(op: string): boolean;
  stream(): AsyncIterable<CursorMessage>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
}

export interface CursorAgent {
  send(message: string): Promise<CursorRun>;
  close(): void;
}

export type CursorCreateFn = (options: CursorAgentOptions) => Promise<CursorAgent>;

/** Mirrors only `Agent.create`, the one export this module resolves. */
export type CursorSdkImporter = () => Promise<{ Agent: { create: CursorCreateFn } }>;

/**
 * Injected only by tests; production lazily imports Agent.create. Both seams
 * exist because they are not interchangeable: `importSdk` goes through the
 * process-wide memo (so it also covers the resolution + failure path), while
 * `create` is per call and can be swapped without resetting that memo.
 */
export interface CursorSdkSeams {
  create?: CursorCreateFn;
  importSdk?: CursorSdkImporter;
}

// A LITERAL "@cursor/sdk" here breaks BOTH `tsc --noEmit` (TS2307 when the
// optional install was skipped) AND `tsup` (esbuild resolves it and tries to
// bundle 7.6MB of platform binaries when it WAS installed — 91 errors).
// Hoisting the specifier into a const makes neither able to resolve it
// statically, so it stays a runtime import in both states.
const SDK_SPECIFIER = "@cursor/sdk";
const importCursorSdk: CursorSdkImporter = () =>
  import(SDK_SPECIFIER) as Promise<{ Agent: { create: CursorCreateFn } }>;

// ponytail: dynamic + memoized so @cursor/sdk (~7.6MB of platform binaries, a
// @statsig telemetry client, Node >= 22.13) never loads unless someone actually
// types `cursorsdk:`. Resolved at CALL time.
let sdkPromise: Promise<CursorCreateFn> | undefined;
let warnedNoParams = false;

/**
 * Is the optional package there at all? RESOLUTION only — it reads package.json
 * and never executes the module, so preflight can answer this without pulling
 * 7.6MB of platform binaries into a run that will never use them. Never a
 * network call.
 *
 * @param spec overridden only by tests, which need a package that DOES resolve
 */
export function cursorSdkInstalled(spec: string = SDK_SPECIFIER): boolean {
  try {
    createRequire(import.meta.url).resolve(spec);
    return true;
  } catch {
    return false;
  }
}

/** the memo is module state and outlives a vitest case */
export function resetCursorSdkCacheForTest(): void {
  sdkPromise = undefined;
  warnedNoParams = false;
}

function loadCreate(importSdk: CursorSdkImporter): Promise<CursorCreateFn> {
  // A rejected promise is memoized deliberately: a missing package will not
  // appear between attempts, so re-importing only re-pays the failure.
  sdkPromise ??= importSdk().then(
    (m) => m.Agent.create.bind(m.Agent),
    (cause: unknown) => {
      // One branch for a missing package AND for Node < 22.13: on Node 20 the
      // import fails too, and naming the running version makes the cause obvious
      // without a semver probe that would be a second thing to keep correct.
      throw new Error(
        `cursorsdk needs the optional '@cursor/sdk' package and Node >= 22.13 (this is ${process.version}). ` +
          "Run: npm i -g @cursor/sdk — or use the 'cursor' CLI backend instead.",
        { cause },
      );
    },
  );
  return sdkPromise;
}

/**
 * "grok-4.5[fast=false,effort=high]" -> { id, params }.
 *
 * This is a money knob, not a nicety: with no params Cursor picks the model's
 * DEFAULT variant, which for some models (grok-4.5 among them) is the FAST tier
 * at about twice the standard rate. Values are not validated against a
 * hardcoded list — the SDK already rejects unknown ones and names the valid set
 * in its message, and a local list would only go stale.
 */
export function parseCursorModelSpec(spec: string): { id: string; params?: CursorModelParam[] } {
  const trimmed = spec.trim();
  const open = trimmed.indexOf("[");
  // Checked before the no-bracket fast path too: an empty id reaches the SDK as
  // a nonsense request instead of failing where the typo is.
  const id = (open === -1 ? trimmed : trimmed.slice(0, open)).trim();
  if (id === "") throw new Error(`cursorsdk model spec has no model id: ${spec}`);
  if (open === -1) return { id };
  if (!trimmed.endsWith("]")) throw new Error(`cursorsdk model spec has an unterminated '[': ${spec}`);
  const body = trimmed.slice(open + 1, -1).trim();
  if (body === "") return { id };
  const params = body.split(",").map((entry) => {
    const eq = entry.indexOf("=");
    const key = eq === -1 ? "" : entry.slice(0, eq).trim();
    const value = eq === -1 ? "" : entry.slice(eq + 1).trim();
    if (key === "" || value === "") {
      throw new Error(`cursorsdk model param must be key=value, got "${entry.trim()}" in: ${spec}`);
    }
    return { id: key, value };
  });
  return { id, params };
}

/** one SDKMessage, rendered and classified the way stream.ts classifies claude's */
export function cursorSdkEvent(msg: CursorMessage): StreamEvent {
  switch (msg.type) {
    // same envelope claude streams, so it goes through stream.ts's classifier
    case "assistant":
      return assistantEvent(typeof msg.message === "object" ? msg.message?.content : undefined);

    // Only the `running` message renders: printing the `completed` one too would
    // show every tool call twice.
    case "tool_call":
      return {
        text: msg.status === "running" ? toolSummary(msg.name ?? "tool", msg.args) : "",
        activity: true,
      };

    // Invisible, but it IS the agent working, so it must end any "my last word
    // was the marker" state. Thinking text is dropped for stream.ts's reason: it
    // is long, it is not the answer, and echoing it buries the real work.
    case "user":
    case "thinking":
      return { text: "", activity: true };

    // A failed run's reason has nowhere else to appear (same rule as the claude
    // parser's failed `result`), but it is NOT prose, so it can never satisfy a
    // marker check. Not activity either — see below.
    case "status":
      return { text: msg.status === "ERROR" && typeof msg.message === "string" ? msg.message : "" };

    // The SDK's billing tally. It is read for a cost figure and for NOTHING
    // else: still no text, still not activity (see below). Cursor does not
    // document a USD number here — its usage is token counts — so when there is
    // no cost field the spend stays UNKNOWN rather than becoming a 0 that would
    // satisfy a budget nothing measured.
    case "usage":
      return { text: "", costUsd: reportedCostUsd(msg) };

    // system / request / task and anything unrecognised are the HARNESS
    // talking. FINISHED, a usage tally and system:init all legitimately trail
    // the agent's final answer, so counting them as activity would clear a real
    // BLOCKED marker and mark a failed task DONE. A wasted retry beats a wrong
    // "done", so unknown defaults to noise.
    default:
      return { text: "" };
  }
}

export interface CursorSdkRunArgs {
  /** the raw AgentSpec.model, e.g. "grok-4.5[fast=false,effort=high]" */
  model: string;
  prompt: string;
  cwd: string;
  timeoutSecs: number;
  mode: "agent" | "plan";
  signal?: AbortSignal;
  /** called for EVERY message, including ones that render nothing */
  onEvent: (ev: StreamEvent) => void;
  create?: CursorCreateFn;
  importSdk?: CursorSdkImporter;
}

export interface CursorSdkOutcome {
  /** "finished" is the ONLY success — wait() does not throw on a failed run */
  status: "finished" | "error" | "cancelled" | "timeout" | "aborted";
  /** RunResult.result, "" when there is none */
  result: string;
  /** actionable one-liner; "" for "finished" / "timeout" / "aborted" */
  error: string;
}

function modelHint(msg: string): string {
  return msg.includes("Cannot use this model")
    ? `cursorsdk model ids are NOT the 'cursor:' CLI ids (CLI 'cursor-grok-4.5-high' -> SDK 'grok-4.5'). ${msg}`
    : msg;
}

/** never rejects: every throw is mapped onto { status: "error" } */
export async function runCursorSdk(a: CursorSdkRunArgs): Promise<CursorSdkOutcome> {
  let model: { id: string; params?: CursorModelParam[] };
  try {
    model = parseCursorModelSpec(a.model);
  } catch (e) {
    return { status: "error", result: "", error: (e as Error).message }; // it throws Error, only ever
  }

  // Read unconditionally, before `create` is resolved: injecting `create` must
  // not also bypass the key path, or it would have no coverage at all.
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) {
    return {
      status: "error",
      result: "",
      error:
        "CURSOR_API_KEY is not set: the cursorsdk backend needs a Cursor API key — a " +
        "`cursor-agent login` session does NOT work for the SDK. Get one at cursor.com/dashboard → " +
        "Integrations, or use the 'cursor' CLI backend instead.",
    };
  }

  if (!model.params && !warnedNoParams) {
    // AFTER the key check, so a misconfigured run fails on the real problem
    // instead of printing cost advice first. Once per process: silence here is
    // how the FAST premium goes unnoticed for a whole release.
    warnedNoParams = true;
    process.emitWarning(
      `cursorsdk:${model.id} has no variant params, so Cursor picks this model's DEFAULT variant — ` +
        "which for some models (grok-4.5 among them) is the FAST tier, billed at about twice the " +
        `standard rate. Pin one explicitly with 'cursorsdk:${model.id}[key=value,...]'; ` +
        "Cursor.models.list() shows each model's variants.",
    );
  }

  let create: CursorCreateFn;
  try {
    create = a.create ?? (await loadCreate(a.importSdk ?? importCursorSdk));
  } catch (e) {
    return { status: "error", result: "", error: (e as Error).message }; // loadCreate throws Error, only ever
  }

  if (a.signal?.aborted) return { status: "aborted", result: "", error: "" };

  let agent: CursorAgent | undefined;
  let run: CursorRun | undefined;
  let stopped: "timeout" | "aborted" | undefined;

  // May run twice — once when the deadline fires and again when a handle it did
  // not have arrives late. Both halves are guarded, so the repeat is a no-op.
  const stop = async (): Promise<void> => {
    // cancel BEFORE close: close() only releases the agent, it does not stop an
    // in-flight run. Nothing on disk is touched — cwd is the user's repository.
    try {
      if (run?.supports("cancel")) await run.cancel();
    } catch {
      /* a wedged or rejected cancel must not escape */
    }
    try {
      agent?.close();
    } catch {
      /* nothing left to do about it */
    }
  };

  // Called after EVERY await inside `work`: the race ABANDONS that chain, it
  // does not stop it. The deadline usually fires while create()/send() is still
  // in flight, when stop() has no handle to cancel yet — without these checks
  // the agent keeps working in the user's repo, keeps billing, and keeps
  // pushing lines into a pane whose task run.ts already failed and moved past.
  const giveUp = (): CursorSdkOutcome => {
    void stop(); // now WITH the handle the timer did not have
    return { status: stopped!, result: "", error: "" }; // the race already returned this
  };

  // The caller is released on the same tick the deadline (or the abort) fires,
  // while stop() runs fire-and-forget behind it: the SDK types cancel() as an
  // unbounded Promise<void>, so awaiting it here would let a wedged cancel hold
  // a run that must never reject and must never hang.
  let release!: (why: "timeout" | "aborted") => void;
  const released = new Promise<"timeout" | "aborted">((r) => {
    release = r;
  });
  const timer = setTimeout(() => {
    stopped = "timeout";
    void stop();
    release("timeout");
  }, a.timeoutSecs * 1000);
  timer.unref?.();
  // the run's AbortSignal is reused for every task in the loop, so a listener
  // left behind accumulates one per executor call
  const onAbort = (): void => {
    stopped = "aborted";
    void stop();
    release("aborted");
  };
  a.signal?.addEventListener("abort", onAbort, { once: true });

  // ONE chain — create, send, stream, wait — raced ONCE. Racing the whole thing
  // rather than just wait() is what makes a hung create()/send() still honour
  // the deadline.
  const work = (async (): Promise<CursorSdkOutcome> => {
    agent = await create({
      apiKey: key,
      model,
      mode: a.mode,
      local: {
        cwd: a.cwd, // the user's REAL repo. Nothing here is ever deleted.
        settingSources: [], // already the SDK default; pinned against a default flip
        sandboxOptions: { enabled: false }, // beats a dev's ~/.cursor/sandbox.json, which
        // otherwise spawns cursorsandbox and raises an
        // unreproducible ConfigurationError
      },
    });
    if (stopped) return giveUp();
    run = await agent.send(a.prompt);
    if (stopped) return giveUp();
    // guarded: a backend that cannot stream still has a usable wait()
    if (run.supports("stream")) {
      for await (const m of run.stream()) {
        // returning (not just breaking out of the awaits) is what runs the
        // generator's .return(), so the producer stops too
        if (stopped) return giveUp();
        a.onEvent(cursorSdkEvent(m));
      }
    }
    const r = await run.wait();
    const detail = r.error?.message ?? (r.result ?? "").trim();
    return r.status === "finished"
      ? { status: "finished", result: r.result ?? "", error: "" }
      : { status: r.status, result: r.result ?? "", error: `cursorsdk run ${r.status}: ${detail || "no detail"}` };
  })();

  try {
    // Promise.race attaches handlers to `work`, so a rejection of the abandoned
    // chain is already consumed and can never surface as an unhandled rejection.
    return await Promise.race([
      work,
      released.then<CursorSdkOutcome>((why) => ({ status: why, result: "", error: "" })),
    ]).catch((e: unknown) => ({
      status: "error" as const,
      result: "",
      error: modelHint(e instanceof Error ? e.message : String(e)),
    }));
  } finally {
    clearTimeout(timer);
    a.signal?.removeEventListener("abort", onAbort);
    // close() must run on EVERY exit path or the SDK's child processes leak —
    // killTree/releasePipes gave the spawn path this for free.
    // (when `stopped`, stop() already did — from the timer, or from giveUp())
    if (!stopped) {
      try {
        agent?.close();
      } catch {
        /* nothing left to do about it */
      }
    }
    // ponytail: KNOWN CEILING — a create() that NEVER resolves leaves an agent
    // we were never handed a handle to, so nothing can close it. The SDK offers
    // no earlier handle; upgrade path is an SDK-side abort option.
  }
}

/** signature-compatible with runExecutor minus `extra`, so executor.ts branches in one line */
export async function runCursorSdkExecutor(
  execu: AgentSpec,
  prompt: string,
  cfg: Config,
  workspace: string,
  progress: string,
  task: Task,
  signal?: AbortSignal,
  seams?: CursorSdkSeams,
  onCost?: CostSink,
): Promise<boolean> {
  // ponytail: KNOWN CEILING — one Agent per call, exactly like the CLI path. The
  // real win here would be keeping ONE agent across the fix rounds and sending
  // only the delta, but run.ts rebuilds a full prompt for every cli (run.ts:131),
  // so conversation reuse means changing that for all of them. Out of scope for
  // v1; upgrade path is to hold the SDKAgent in runTask and reuse Run.send().
  const tag = task.id;
  const start = Date.now();
  const hb = cfg.heartbeat_secs ?? 30;
  const timeout = cfg.task_timeout;
  let last = start; // last sign of life from the agent
  let lastBeat = start; // last "…working" line — throttling only, kept SEPARATE
  // the run's last displayed line, and whether it was the agent SPEAKING — see
  // executor.ts for why both halves matter
  let lastLine = "";
  let lastWasProse = false;
  // see executor.ts: undefined stays undefined until a cli reports a figure
  let costUsd: number | undefined;

  // there is no command line to append them to, and silently dropping a knob the
  // user set is worse than one line saying so
  if (cfg.extra_executor_args.length) {
    log(progress, `  ${tag}: extra_executor_args ignored — ${execu.cli} has no command line`);
  }

  // no timeout check here: runCursorSdk owns the deadline
  const hbTimer = setInterval(() => {
    const elapsed = Date.now() - start;
    emit({ taskId: task.id, elapsedMs: elapsed, timeoutMs: timeout * 1000 });
    if (Date.now() - last >= hb * 1000 && Date.now() - lastBeat >= hb * 1000) {
      lastBeat = Date.now();
      log(progress, t("exec.working", { tag, s: Math.round((Date.now() - start) / 1000) }));
    }
  }, Math.min(hb * 1000, 1000));
  hbTimer.unref?.();

  try {
    const out = await runCursorSdk({
      model: execu.model,
      prompt,
      cwd: workspace,
      timeoutSecs: cfg.task_timeout,
      mode: "agent",
      signal,
      onEvent: (ev) => {
        // every message is a sign of life, including the ones never displayed
        last = Date.now();
        // ordering is load-bearing: this runs BEFORE the same event's own text
        // can set it back
        if (ev.activity) lastWasProse = false;
        if (ev.costUsd !== undefined) costUsd = (costUsd ?? 0) + ev.costUsd;
        if (!ev.text) return;
        for (const line of ev.text.split("\n")) {
          if (line.trim()) {
            lastLine = line.trim();
            lastWasProse = ev.prose === true;
          }
          emit({ taskId: task.id, line, lineSource: "executor" });
          // already emitted to the TUI above; keep it in progress.md without
          // routing a duplicate system line back into the live pane
          if (line.trim()) log(progress, `  ${tag}› ${line}`, false);
        }
      },
      ...seams,
    });
    const s = Math.round((Date.now() - start) / 1000);
    // Divergence from the spawn path on purpose: executor.ts logs exec.skipped
    // only from its abort listener and stays silent when the signal was already
    // aborted. There is one code path here, and the asymmetry bought nothing.
    if (out.status === "aborted") {
      log(progress, t("exec.skipped", { tag, cli: execu.cli }));
      return false;
    }
    if (out.status === "timeout") {
      log(progress, t("exec.timeout", { tag, cli: execu.cli, s }));
      return false;
    }
    // exec.spawnFailed's "failed to spawn" wording is slightly off in-process;
    // reusing it is what makes this backend need zero new i18n keys
    if (out.status !== "finished") {
      log(progress, t("exec.spawnFailed", { tag, cli: execu.cli, msg: out.error }));
      return false;
    }
    // the final answer is classified even though it is never printed, so a
    // blocked marker that appears ONLY there is still heard
    const tail = out.result.split("\n").filter((l) => l.trim()).pop();
    if (tail) {
      lastLine = tail.trim();
      lastWasProse = true;
    }
    if (lastWasProse && lastLine.startsWith(BLOCKED_MARKER)) {
      log(progress, t("exec.blocked", { tag, reason: lastLine.slice(BLOCKED_MARKER.length).trim() }));
      return false;
    }
    log(progress, `  ${tag}: ${execu.cli} finished (${s}s)`);
    return true;
  } finally {
    clearInterval(hbTimer);
    // `finally` is this backend's single settle point, so the sink fires exactly
    // once here too — including on the timeout/abort paths that were still billed
    onCost?.(costUsd);
  }
}

/** drop-in for advisor.ts's runAdvisorCli: trimmed answer, or null */
export async function runCursorSdkText(
  advis: AgentSpec,
  prompt: string,
  cfg: Config,
  workspace: string,
  taskId: string,
  source: "advisor" | "review",
  seams?: CursorSdkSeams,
): Promise<string | null> {
  const out = await runCursorSdk({
    model: advis.model,
    prompt,
    cwd: workspace,
    timeoutSecs: cfg.advisor_timeout,
    // chat-only posture, matching buildCmd(..., autoApprove: false) on the CLI path
    mode: "plan",
    onEvent: (ev) => {
      if (!ev.text) return;
      for (const line of ev.text.split("\n")) emit({ taskId, line, lineSource: source });
    },
    ...seams,
  });
  // The RESULT is RunResult.result ONLY. The streamed lines go to the pane for
  // visibility but must never enter the returned string: advisorReview parses it
  // with parseReview, so a tool summary in there could flip a review verdict.
  return out.status === "finished" ? out.result.trim() || null : null;
}
