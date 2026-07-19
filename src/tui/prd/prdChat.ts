// prdChat.ts — headless planner turn: spawn the CLI, stream stdout line-by-line
// via onChunk, then parse the summary + fenced PRD json out of the full reply
// and validate it. Reuses the spawn+readline merge pattern from executor.ts.
// Parses fail-safe: junk output -> { prd: null, errors } so nothing is written.

import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { buildCmd } from "../../adapters.js";
import { killTree, releasePipes, spawn } from "../../spawn.js";
import { t } from "../../i18n.js";
import type { PRD } from "../../prd.js";
import { normalizePrd } from "../../prdload.js";
import type { ChatMessage, PlannerResult } from "./prdController.js";
import { validatePrd } from "./validatePrd.js";

const TIMEOUT_MS = 600_000;
// see executor.ts — how long to wait for 'close' after a kill before settling
const KILL_GRACE_MS = 5_000;
// errors render in the studio chat pane → localized (function: locale is set after import)
const NO_JSON = (): string => t("studio.err.noJson");

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
  " status, deps[], retries, description, acceptance[], verify}]}",
  'status MUST be exactly one of "todo" | "doing" | "done" | "blocked" — use "todo"',
  "for new tasks. retries starts at 0. deps: [] when none.",
  "Every dep must reference an existing task id, and verify must be a REAL runnable",
  "command that checks the task.",
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
  const parts: string[] = [PREAMBLE];
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
  const fence = text.indexOf("```json");
  if (fence === -1) return { summary: "", prd: null, errors: [NO_JSON()] };
  const summary =
    text
      .slice(0, fence)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const rest = text.slice(fence + "```json".length);
  const close = rest.indexOf("```");
  const body = close === -1 ? rest : rest.slice(0, close);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return { summary, prd: null, errors: [NO_JSON()] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { summary, prd: null, errors: [NO_JSON()] };
  }
  // planners love inventing statuses ("pending", "TODO") — the shared pipeline
  // coercions run before validating; the changed-flag is irrelevant here.
  // keepDoing: a planner echoing an in-flight "doing" task must not have it
  // silently reset (matches the old normalizeDraft behavior).
  void normalizePrd(parsed, { keepDoing: true });
  const v = validatePrd(parsed);
  if (!v.ok) return { summary, prd: null, errors: v.errors };
  return { summary, prd: parsed as PRD, errors: [] };
}

export function runPlannerTurn(args: PlannerTurnArgs): Promise<PlannerResult> {
  return new Promise((resolve) => {
    // planner is chat-only: NO auto-approve flags, so a studio turn can never
    // grant the agent permission to write to disk.
    const cmd = buildCmd(args.cli, buildPrompt(args), args.model, args.cwd, false);
    // NOT spawn's own `signal` option: node aborts with a SIGTERM to the direct
    // child, which leaves the agent's descendants running. killTree takes the
    // whole tree on every platform.
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: args.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const merged = new PassThrough();
    proc.stdout.pipe(merged);
    proc.stderr.pipe(merged);
    const rl = createInterface({ input: merged });

    let full = "";
    rl.on("line", (line) => {
      full += (full ? "\n" : "") + line;
      args.onChunk(line);
    });

    // single-settle guard: close / error / timeout / abort can race.
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const finish = (result: PlannerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      args.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    // a surviving grandchild can hold the pipes open, so 'close' may never
    // arrive after a kill — settle on our own once the grace elapses.
    function killAndSettle(): void {
      killTree(proc);
      releasePipes(proc, merged, rl); // killed: a survivor must not keep writing
      grace = setTimeout(() => finish(parseReply(full)), KILL_GRACE_MS);
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

    timer = setTimeout(killAndSettle, TIMEOUT_MS);
    if (args.signal) {
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("close", () => finish(parseReply(full)));
    proc.on("error", () => finish({ summary: "", prd: null, errors: [t("studio.err.spawnFailed")] }));
  });
}
