// prdChat.ts — headless planner turn: spawn the CLI, stream stdout line-by-line
// via onChunk, then parse the summary + fenced PRD json out of the full reply
// and validate it. Reuses the spawn+readline merge pattern from executor.ts.
// Parses fail-safe: junk output -> { prd: null, errors } so nothing is written.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { buildCmd } from "../../adapters.js";
import { t } from "../../i18n.js";
import type { PRD } from "../../prd.js";
import type { ChatMessage, PlannerResult } from "./prdController.js";
import { validatePrd } from "./validatePrd.js";

const TIMEOUT_MS = 600_000;
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

// planners love inventing statuses ("pending", "TODO") — coerce to the enum before
// validating, same philosophy as prd.ts recoverAndNormalize for hand-written backlogs.
// Only harmless fields are coerced; a wrong deps/acceptance SHAPE still fails validation.
const STATUSES = new Set(["todo", "doing", "done", "blocked"]);
function normalizeDraft(obj: unknown): void {
  // caller guarantees obj came from JSON.parse of a "{...}" slice — always a non-null object
  const tasks = (obj as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return;
  for (const t of tasks) {
    if (typeof t !== "object" || t === null) continue;
    const task = t as Record<string, unknown>;
    const low = typeof task.status === "string" ? task.status.toLowerCase() : "";
    task.status = STATUSES.has(low) ? low : "todo";
    if (typeof task.retries !== "number") task.retries = 0;
    if (task.deps === undefined) task.deps = [];
    if (task.acceptance === undefined) task.acceptance = [];
  }
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
  normalizeDraft(parsed);
  const v = validatePrd(parsed);
  if (!v.ok) return { summary, prd: null, errors: v.errors };
  return { summary, prd: parsed as PRD, errors: [] };
}

export function runPlannerTurn(args: PlannerTurnArgs): Promise<PlannerResult> {
  return new Promise((resolve) => {
    // planner is chat-only: NO auto-approve flags, so a studio turn can never
    // grant the agent permission to write to disk.
    const cmd = buildCmd(args.cli, buildPrompt(args), args.model, args.cwd, false);
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: args.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: args.signal,
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

    const timer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);

    // single-settle guard: close / error / timeout-then-close can race.
    let settled = false;
    const finish = (result: PlannerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    proc.on("close", () => finish(parseReply(full)));
    proc.on("error", () => finish({ summary: "", prd: null, errors: [t("studio.err.spawnFailed")] }));
  });
}
