// prdChat.ts — headless planner turn: spawn the CLI, stream stdout line-by-line
// via onChunk, then parse the summary + fenced PRD json out of the full reply
// and validate it. Reuses the spawn+readline merge pattern from executor.ts.
// Parses fail-safe: junk output -> { prd: null, errors } so nothing is written.

import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { buildCmd, promptViaStdin } from "../../adapters.js";
import { agentDef } from "../../agents.js";
import { fencedBlocks } from "../../fence.js";
import { runCursorSdk } from "../../cursor-sdk.js";
import { startIdleLadder } from "../../idleness.js";
import { killTree, releasePipes, spawn, writePrompt } from "../../spawn.js";
import { t } from "../../i18n.js";
import type { PRD } from "../../prd.js";
import { normalizePrd } from "../../prdload.js";
import { hostEnvironmentBlock } from "../../prompts.js";
import type { ChatMessage, PlannerResult } from "./prdController.js";
import { validatePrd } from "./validatePrd.js";

// see executor.ts — how long to wait for 'close' after a kill before settling
const KILL_GRACE_MS = 5_000;
// A turn dies by LIVENESS, not by a wall-clock budget: while output keeps
// flowing it runs as long as the model needs — a slow free-tier model writing
// a giant PRD is work, not a hang (a 22KB reply once died mid-string at the
// old 10-min mark). Guards, escalating:
//   IDLE LADDER — continuous SILENCE climbs one step every IDLE_STEP_MS: the
//           first steps only ANNOUNCE ("sem saída há N min…", streamed into the
//           chat so the user sees we noticed), the last step kills. Every line
//           from the cli resets the ladder to zero — provider backoff, silent
//           retries and slow thinking all pass; a genuinely frozen stream does
//           not (proven against opencode's own log: request opened, zero
//           tokens, zero errors until we cut it).
//   MAX   — absolute ceiling against degenerate infinite output only.
//   close — a cli that died ON ITS OWN is reported WITH its exit code, which
//           is how "the model gave up" becomes visible instead of guessing.
const IDLE_STEP_MS = 180_000;
const IDLE_STEPS = 4; // warn at 3min, 6min, 9min — kill only at 12min of total silence
const MAX_TURN_MS = 1_800_000;
// errors render in the studio chat pane → localized (function: locale is set after import)
const NO_JSON = (): string => t("studio.err.noJson");

// A failed turn's raw reply is the ONLY evidence of WHY no json was found —
// timeout truncation? a ``` fence without the json tag? pure prose? Without it
// the question is unanswerable once the pane has scrolled away. Persist one
// file per studio process (overwritten per failed turn) and surface the path
// next to the parse error.
//
// Next to it, when the cli keeps an internal log of its own (opencode logs
// provider streams there — the stdout can be mute while the child still
// "works" on a frozen connection), a tail of that log lands beside the raw
// output as <path>.internal.log. It answers what stdout never will: whether
// the child was mid-generation, silently retrying, or sitting on a dead pipe.
function withRawDump(result: PlannerResult, raw: string, cli: string): PlannerResult {
  if (result.prd || result.errors.length === 0) return result;
  const path = join(tmpdir(), `ralphrun-planner-${process.pid}.log`);
  try {
    writeFileSync(path, raw);
    const internal = internalLogTail(cli);
    if (internal) writeFileSync(`${path}.internal.log`, internal);
  } catch {
    return result; // a debug artifact must never turn a parse failure into a crash
  }
  return { ...result, errors: [...result.errors, t("studio.err.rawSaved", { path })] };
}

/** last INTERNAL_LOG_MINUTES of the cli's own log file; "" when unknown */
const INTERNAL_LOG_MINUTES = 10;
function internalLogTail(cli: string): string {
  if (cli !== "opencode") return ""; // the one cli whose log location we know today
  try {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const lines = readFileSync(join(base, "opencode", "log", "opencode.log"), "utf8").split("\n");
    const cutoff = Date.now() - INTERNAL_LOG_MINUTES * 60_000;
    const recent = lines.filter((l) => {
      const m = /^timestamp=(\S+?)(?:\.\d+)?Z /.exec(l);
      return m ? Date.parse(`${m[1]}Z`) >= cutoff : false;
    });
    return recent.slice(-120).join("\n");
  } catch {
    return ""; // no log / unreadable: the diagnostic simply stays absent
  }
}

export interface PlannerAttachment {
  path: string;
  content: string;
  truncated: boolean;
  ok: boolean;
}

export interface PlannerTurnArgs {
  cli: string;
  model: string;
  cwd: string;
  currentPrd: PRD | null;
  history: ChatMessage[];
  instruction: string;
  attachments: PlannerAttachment[];
  signal?: AbortSignal; // abort kills the child (wizard teardown / quit)
  onChunk: (t: string) => void;
}

const PREAMBLE = [
  "You are the planner for a Ralph autonomous build loop. Produce a PRD as JSON",
  "with this exact shape:",
  '{project:string, stack:string, architecture_notes:string, tasks:[{id, title,',
  " status, deps[], retries, description, acceptance[], scope[], parallel, resources, verify}]}",
  'status MUST be exactly one of "todo" | "doing" | "done" | "blocked" — use "todo"',
  "for new tasks. retries starts at 0. deps: [] when none.",
  "Every dep must reference an existing task id, and verify must be a REAL runnable",
  "command that checks the task.",
  "AUTHORING IN STAGES — follow this strictly for large products:",
  "1. When there is no Current PRD yet (or the user asks for the plan), reply with a",
  "SKELETON first: every task as {id, title, status:\"todo\", deps, retries:0} and NO",
  "description/acceptance/scope/verify. A skeleton keeps every turn small and lets the",
  "user steer the architecture before any detail is written.",
  "2. On later turns the user asks you to EXPAND tasks or groups (\"expand t10-t14\").",
  "Then output the FULL PRD where the requested tasks carry all fields — description,",
  "acceptance[], scope[], verify — while not-yet-expanded tasks stay skeletal.",
  "3. Before the user can build, EVERY task must be fully expanded; if the user says",
  "\"build\" with skeletal tasks remaining, expand them ALL in that turn's PRD.",
  "deps: declare an edge ONLY when the task CONSUMES an artifact the earlier task",
  'produces. "It comes later in the narrative" is not a dependency. Before keeping an',
  "edge, ask: would this task FAIL if it ran first? If not, drop the edge — a wider",
  "graph is the point. But do not manufacture parallelism either: when the work is",
  "genuinely sequential, a chain is the right plan.",
  "scope: the paths or globs the task will edit. Two tasks with NO dependency path",
  "between them must not declare overlapping scope — the plan is refused. Tasks that",
  "do depend on each other may overlap, because they are ordered.",
  "parallel: set safe only when the task and its verify do not mutate shared external",
  "state. Set exclusive for shared database/cache/queue writes or resets, fixed ports,",
  "Docker/cluster services, or whenever isolation cannot be proved.",
  "resources: when relevant, declare database/cache as isolated, read, write or reset,",
  "and list named ports/services. Missing metadata is treated as exclusive at runtime.",
  'Write every acceptance item as a CHECKABLE statement ("the endpoint returns 401',
  'without a token"), never as an intention ("authentication works correctly").',
  "At the points where parallel branches converge, add an integration task whose verify",
  "runs the WHOLE suite instead of one slice: N tasks each passing their own isolated",
  "verify can still be broken together. When many branches converge, fan them in over",
  "layers rather than one task consuming everything.",
  "Choose verify commands as context-aware quality gates, not narrow smoke tests.",
  "For typed/tested stacks, include the relevant static check plus focused tests",
  '(examples: "npm run typecheck && npm run test -- tests/foo.test.ts",',
  '"cargo test", "go test ./...", "pytest tests/foo_test.py").',
  "When a task adds or changes integration surface, include build or integration tests too.",
  "Do not mark a task done if typecheck/lint/build is known to fail, even when unit tests pass.",
  "For tasks that build or change USER-FACING UI, prefer a real browser check in verify using",
  'dev-browser (a Playwright-backed CLI): e.g. "npm run build && dev-browser --headless < e2e/login.mjs",',
  "where the script throws on any failed assertion. Add this ONLY for tasks with actual UI to drive —",
  "never for backend, library, or config tasks.",
].join("\n");

const REQUIRED_OUTPUT =
  "Reply with FIRST a ONE-LINE summary, THEN a blank line, THEN the FULL updated PRD as a single json fenced block.";

function buildPrompt(args: PlannerTurnArgs): string {
  const parts: string[] = [PREAMBLE, hostEnvironmentBlock()];
  parts.push("Current PRD:\n" + (args.currentPrd ? JSON.stringify(args.currentPrd, null, 2) : "none yet"));
  if (args.currentPrd) {
    // the studio shows tasks numbered 1..N — let "task 15" resolve to an id
    parts.push(
      "Task numbers (1-based, as shown to the user): " +
        args.currentPrd.tasks.map((t, i) => `${i + 1}=${t.id}`).join(" "),
    );
  }
  parts.push("Chat history:\n" + args.history.map((m) => `${m.role}: ${m.text}`).join("\n"));
  for (const a of args.attachments) {
    // prompt-side strings: ALWAYS English (injected into the planner prompt), never t()
    if (!a.ok) {
      parts.push(`## Attached reference: ${a.path}\n(error: could not read the file)`);
      continue;
    }
    const note = a.truncated ? "\n…(truncated at 12000 chars)" : "";
    parts.push(`## Attached reference: ${a.path}\n${a.content}${note}`);
  }
  parts.push("User instruction:\n" + args.instruction);
  parts.push(REQUIRED_OUTPUT);
  return parts.join("\n\n");
}

function parseReply(text: string): PlannerResult {
  // Models drafting long PRDs emit SEVERAL json blocks in one turn — earlier
  // drafts, then the refined one. Judge EVERY fenced block, newest first, and
  // accept the first that survives parse + validation (a real 33-task PRD was
  // once thrown away because it sat in the fourth block). Blocks that fail
  // JSON.parse outright (raw control characters mid-string) are drafts by
  // definition and are skipped, not fatal.
  const lines = text.split("\n");
  const firstFence = lines.findIndex((l) => l.trim().startsWith("```"));
  const summary =
    (firstFence === -1 ? [] : lines.slice(0, firstFence))
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  let bestErrors: string[] | null = null; // validator errors of the newest parseable block
  const blocks = fencedBlocks(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const body = blocks[i];
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
      continue;
    }
    // planners love inventing statuses ("pending", "TODO") — the shared pipeline
    // coercions run before validating; the changed-flag is irrelevant here.
    // keepDoing: a planner echoing an in-flight "doing" task must not have it
    // silently reset (matches the old normalizeDraft behavior).
    void normalizePrd(parsed, { keepDoing: true });
    // STAGED AUTHORING: a skeleton task (no description/acceptance yet) is
    // ACCEPTED here — the studio is where the details get filled in. The run
    // gates keep validating strictly on their own.
    const v = validatePrd(parsed, { draft: true, requireVerify: false });
    if (v.ok) return { summary, prd: parsed as PRD, errors: [] };
    // newest-first scan: keep the FIRST error set seen — that is the NEWEST
    // draft's verdict, which is what the user needs to fix
    bestErrors ??= v.errors;
  }
  if (bestErrors) return { summary, prd: null, errors: bestErrors };
  return { summary, prd: null, errors: [NO_JSON()] };
}

// An in-process backend has no argv and no child to kill: buildCmd would throw,
// and a throw here rejects the turn promise, which mount.ts turns into a DEAD
// wizard (unsaved PRD and all). Its final answer is what the spawn path
// accumulates from stdout, so the parse below is identical.
async function runPlannerSdkTurn(args: PlannerTurnArgs, prompt: string): Promise<PlannerResult> {
  const out = await runCursorSdk({
    model: args.model,
    prompt,
    cwd: args.cwd,
    timeoutSecs: MAX_TURN_MS / 1000,
    mode: "plan", // chat-only, same posture as buildCmd(..., autoApprove: false)
    signal: args.signal,
    onEvent: (ev) => {
      if (ev.text) for (const line of ev.text.split("\n")) args.onChunk(line);
    },
  });
  // an abort is a cancellation, not a failed turn — same empty settle as onAbort
  if (out.status === "aborted") return { summary: "", prd: null, errors: [] };
  if (out.status === "finished") return withRawDump(parseReply(out.result), out.result, args.cli);
  return { summary: "", prd: null, errors: [out.error || NO_JSON()] };
}

export function runPlannerTurn(args: PlannerTurnArgs): Promise<PlannerResult> {
  // planner is chat-only: NO auto-approve flags, so a studio turn can never
  // grant the agent permission to write to disk.
  const prompt = buildPrompt(args);
  if (agentDef(args.cli)?.sdk) return runPlannerSdkTurn(args, prompt);
  return new Promise((resolve) => {
    const cmd = buildCmd(args.cli, prompt, args.model, args.cwd, false);
    // NOT spawn's own `signal` option: node aborts with a SIGTERM to the direct
    // child, which leaves the agent's descendants running. killTree takes the
    // whole tree on every platform.
    const viaStdin = promptViaStdin(args.cli);
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: args.cwd,
      stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (viaStdin) writePrompt(proc, prompt);

    const merged = new PassThrough();
    proc.stdout.pipe(merged);
    proc.stderr.pipe(merged);
    const rl = createInterface({ input: merged });

    let full = "";
    // Escalating silence ladder (see idleness.ts): warns stream into the chat
    // so the user sees the stall forming; only the last rung kills. Armed at
    // spawn too, so a cli that produces nothing at all dies here instead of at
    // the ceiling; every line resets it to rung zero.
    const idle = startIdleLadder({
      stepMs: IDLE_STEP_MS,
      steps: IDLE_STEPS,
      warn: (mins) => args.onChunk(t("studio.warn.idle", { mins })),
      fatal: () => killAndSettle("stall"),
    });
    rl.on("line", (line) => {
      full += (full ? "\n" : "") + line;
      idle.bump(); // every line is proof of life
      args.onChunk(line);
    });
    // single-settle guard: close / error / stall / ceiling / abort can race.
    let settled = false;
    let max: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let killedBy: "stall" | "ceiling" | null = null;
    let exitCode: number | null = null;

    const clearTimers = (): void => {
      idle.stop();
      clearTimeout(max);
      clearTimeout(grace);
    };
    const finish = (result: PlannerResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      args.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    // settle by parsing what accumulated, annotated with WHY when we killed it
    // or the cli died first — the failure classes a user needs told apart
    // ("did the model give up, or did we cut it?").
    const settleParsed = (): void => {
      const parsed = parseReply(full);
      let errors = parsed.errors;
      if (parsed.prd === null && errors.length > 0) {
        const idleMins = (IDLE_STEP_MS * IDLE_STEPS) / 60_000;
        if (killedBy === "stall") errors = [t("studio.err.stalled", { mins: idleMins }), ...errors];
        else if (killedBy === "ceiling") errors = [t("studio.err.maxed", { mins: MAX_TURN_MS / 60_000 }), ...errors];
        else if (exitCode !== null && exitCode !== 0) errors = [t("studio.err.exited", { code: exitCode }), ...errors];
      }
      finish(withRawDump({ ...parsed, errors }, full, args.cli));
    };

    // a surviving grandchild can hold the pipes open, so 'close' may never
    // arrive after a kill — settle on our own once the grace elapses.
    function killAndSettle(reason: "stall" | "ceiling"): void {
      if (settled) return;
      killedBy = reason;
      killTree(proc);
      releasePipes(proc, merged, rl); // killed: a survivor must not keep writing
      idle.stop();
      grace = setTimeout(settleParsed, KILL_GRACE_MS);
      grace.unref?.();
    }
    // An abort is a CANCELLATION, not a slow turn: settle immediately and
    // discard whatever was streamed. Waiting for 'close' here would let a late
    // reply land on a wizard that has already torn down.
    function onAbort(): void {
      killTree(proc);
      releasePipes(proc, merged, rl);
      finish({ summary: "", prd: null, errors: [] });
    }

    max = setTimeout(() => killAndSettle("ceiling"), MAX_TURN_MS);
    max.unref?.();
    idle.bump(); // arm the ladder: even zero-output silence starts climbing
    if (args.signal) {
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("close", (code) => {
      exitCode = typeof code === "number" ? code : null;
      settleParsed();
    });
    proc.on("error", () => finish({ summary: "", prd: null, errors: [t("studio.err.spawnFailed")] }));
  });
}
