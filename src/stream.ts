// stream.ts — turn a coding CLI's event stream into lines a human can read.
//
// Without this every executor call is a black box: `claude -p` buffers its
// whole answer and delivers it in ONE chunk when the turn ends (measured: 25s
// of total silence, then 1.7KB at once), so the live pane could only ever show
// "…working (1454s)".
//
// Turning the CLI's own event stream on fixes that: events arrive every few
// hundred ms, including while the model is still thinking. It does NOT make
// silence a reliable stuck-detector — a 40s foreground tool call still went
// 25.9s with no events — which is why there is no idle timeout (see README).
//
// Each CLI has its OWN event schema, so a parser is only written for one we
// have actually captured and can test against. A cli with no `stream` entry in
// the registry keeps the plain-text behaviour.

import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";

import { t } from "./i18n.js";

/** what a single raw event line means to us */
export interface StreamEvent {
  /** text to show / log, if any. Empty for events that are pure liveness. */
  text?: string;
  /** true when this is model prose (as opposed to tool activity) — the blocked
   *  marker is only honoured in prose, never in a tool call's arguments */
  prose?: boolean;
  /** the run's final answer, when the cli reports it as its own event. Not
   *  displayed (it repeats what was already shown) but still classified, so a
   *  blocked marker that appears ONLY here is not lost. */
  final?: string;
  /**
   * The AGENT did something here, as opposed to the harness making noise.
   *
   * This is what tells "the marker was my final word" apart from "I said that,
   * then kept working" — including when the later work is invisible, like a
   * thinking-only turn or a tool result. Infrastructure events (token counters,
   * hooks, rate-limit notices) are NOT activity: they can legitimately trail the
   * agent's final answer, and treating them as work would silence a real block.
   */
  activity?: boolean;
  /**
   * What the cli says this turn cost, in USD. Absent when it reported nothing —
   * NEVER 0, see reportedCostUsd.
   *
   * Deliberately neither `prose` nor `activity`: a cost tally is the harness
   * billing us, not the agent working, and counting it either way would let
   * telemetry that trails the final answer clear a real BLOCKED marker.
   */
  costUsd?: number;
  /**
   * Only the agent's OWN words from this event, with the tool summaries left
   * out — `text` renders both, and `prose` is one boolean for the pair, so a
   * turn that says something AND calls a tool cannot be split by either.
   *
   * The handoff tails need that split: a "→ Edit(x)" line is the harness
   * narrating, and the next attempt reads the diff for what was edited.
   *
   * Absent whenever it would equal `text` — a turn that only spoke, and every
   * event from a cli with no parser, where each line is the agent's by
   * definition. Consumers fall back to `text`, which is right in both.
   */
  proseText?: string;
}

/**
 * The cli's own money figure for a turn, or undefined when it did not report
 * one. Never estimated: a fabricated 0 would make a budget look satisfied when
 * nothing was measured at all. Both spellings because claude streams
 * `total_cost_usd` and the Cursor SDK speaks camelCase.
 */
export function reportedCostUsd(ev: unknown): number | undefined {
  if (!ev || typeof ev !== "object") return undefined;
  const o = ev as Record<string, unknown>;
  const raw = o.total_cost_usd ?? o.totalCostUsd;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/**
 * Money spent so far. `unknown` marks that at least one call reported no figure
 * — only claude emits a cost today, and no cli meters the advisor — so `usd` is
 * a FLOOR, never a total. Kept as a flag rather than folded into the number
 * because a silent 0 is exactly the lie this feature exists to prevent.
 */
export interface CostTally {
  usd: number;
  unknown: boolean;
}

/**
 * Reports what ONE executor call cost. Called exactly once per call, on every
 * exit path — a timed-out or aborted turn was still billed, so skipping those
 * would under-count precisely the runs that burned money for nothing — with
 * undefined when the cli reported no figure at all.
 */
export type CostSink = (usd: number | undefined) => void;

// How much of a cli's closing output is worth handing the next attempt. Lives
// HERE, not in executor.ts, because both executor backends need the same bound
// and executor.ts already imports cursor-sdk.ts — importing back would be a
// cycle, and a second copy of the numbers is how the two paths drift apart.
export const MAX_TAIL_LINES = 20;
export const MAX_TAIL_CHARS = 2_000;
export const MAX_RESPONSE_CHARS = 200_000;

export interface BoundedLineReader {
  close(): void;
}

/** Split a child stream without letting readline buffer an unbounded line. */
export function readBoundedLines(
  input: Readable,
  maxChars: number,
  onLine: (line: string) => void,
  onOverflow: () => void,
): BoundedLineReader {
  let pending = "";
  let closed = false;
  let skipLf = false;
  const decoder = new TextDecoder("utf-8");

  const overflow = (): void => {
    if (closed) return;
    closed = true;
    pending = "";
    input.off("data", onData);
    input.off("end", onEnd);
    onOverflow();
  };

  function processText(text: string): void {
    let start = 0;
    if (skipLf) {
      if (text.startsWith("\n")) start = 1;
      skipLf = false;
    }
    for (let i = start; i < text.length; i++) {
      const delimiter = text[i];
      if (delimiter !== "\n" && delimiter !== "\r") continue;
      const segmentLength = i - start;
      if (pending.length + segmentLength > maxChars) return overflow();
      const line = pending + text.slice(start, i);
      pending = "";
      onLine(line);
      if (closed) return;
      if (delimiter === "\r") {
        if (text[i + 1] === "\n") i++;
        else if (i + 1 === text.length) skipLf = true;
      }
      start = i + 1;
    }
    const rest = text.slice(start);
    if (pending.length + rest.length > maxChars) return overflow();
    pending += rest;
  }

  function onData(chunk: Buffer | string): void {
    if (closed) return;
    processText(decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true }));
  }

  function onEnd(): void {
    if (closed) return;
    processText(decoder.decode());
    if (closed) return;
    closed = true;
    input.off("data", onData);
    input.off("end", onEnd);
    if (pending) onLine(pending);
    pending = "";
  }

  input.on("data", onData);
  input.on("end", onEnd);
  return {
    close: () => {
      closed = true;
      pending = "";
      input.off("data", onData);
      input.off("end", onEnd);
    },
  };
}

/** one cli call's outcome; `undefined` means that call reported no cost */
export function addCost(tally: CostTally, usd: number | undefined): void {
  if (usd === undefined) tally.unknown = true;
  else tally.usd += usd;
}

/** roll a task's tally into the run's */
export function mergeCost(dst: CostTally, src: CostTally): void {
  dst.usd += src.usd;
  dst.unknown ||= src.unknown;
}

/** "$1.2345", "≥$1.2345" when part of the spend was never reported, else unknown */
export function formatCost(tally: CostTally): string {
  if (tally.unknown && tally.usd === 0) return t("cost.unknown");
  return `${tally.unknown ? "≥$" : "$"}${tally.usd.toFixed(4)}`;
}

// a single event line past this is not a real event; parsing multi-MB of JSON
// per line would burn CPU for output nobody can read anyway
const MAX_EVENT_CHARS = 256_000;

/**
 * The blocks of an assistant turn, rendered and classified. Shared with
 * cursor-sdk.ts: both harnesses emit the same content shape, and a second copy
 * of this drifts the moment one of them is fixed.
 */
export function assistantEvent(content: unknown): StreamEvent {
  if (!Array.isArray(content)) return { text: "", activity: true };
  const out: string[] = [];
  const spoken: string[] = [];
  let prose = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue; // a null entry is valid JSON
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      out.push(b.text);
      spoken.push(b.text);
      prose = true;
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      out.push(toolSummary(b.name, b.input));
    }
    // "thinking" is deliberately dropped: it is long, it is not the
    // agent's answer, and echoing it would bury the actual work
  }
  const text = out.join("\n");
  const proseText = spoken.join("\n");
  // Present ONLY on a turn that BOTH spoke and called a tool — the one shape the
  // `prose` boolean cannot describe. A turn that only spoke has proseText ===
  // text, and one that only called tools has no prose for a consumer to want;
  // both fall back to `text`, which is right for them.
  return prose && proseText !== text
    ? { text, prose, activity: true, proseText }
    : { text, prose, activity: true };
}

/** a tool call rendered compactly: the arg that says WHICH thing it touched */
export function toolSummary(name: string, input: unknown): string {
  const arg = summarizeToolInput(input);
  return arg ? `→ ${name}(${arg})` : `→ ${name}`;
}

// The field that identifies what a tool touched, in the order the common tools
// use — and which END of it to keep when it is too long. A path's identity is
// its TAIL (chopping /very/long/absolute/prefix/src/thing.ts from the right
// leaves only the prefix every line shares); everything else reads head-first.
// Keyed by FIELD, not by content: `cat /some/very/long/path` is a command that
// happens to contain a path, and trimming its head would hide the `cat`.
const IDENTIFYING_FIELDS: [key: string, keep: "head" | "tail"][] = [
  ["file_path", "tail"],
  ["path", "tail"],
  ["command", "head"],
  ["pattern", "head"],
  ["url", "head"],
  ["query", "head"],
  ["description", "head"],
];

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const [key, keep] of IDENTIFYING_FIELDS) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return truncate(v.trim().replace(/\s+/g, " "), 80, keep);
  }
  return "";
}

function truncate(s: string, max: number, keep: "head" | "tail" = "head"): string {
  if (s.length <= max) return s;
  return keep === "tail" ? "…" + s.slice(-(max - 1)) : s.slice(0, max - 1) + "…";
}

/**
 * Claude Code's `--output-format stream-json --verbose` stream.
 *
 * Captured shapes: {type:"system",subtype:"init"|"thinking_tokens"|"hook_*"},
 * {type:"assistant",message:{content:[{type:"thinking"|"tool_use"|"text"}]}},
 * {type:"user",message:{content:[{type:"tool_result"}]}},
 * {type:"rate_limit_event"}, {type:"result",subtype:"success",result:"..."}.
 */
export function parseClaudeStream(line: string): StreamEvent | null {
  // length is checked BEFORE trim: trimming a multi-MB line allocates a second
  // copy of it just to find out we were never going to parse it
  if (line.length > MAX_EVENT_CHARS) return { text: truncate(line, 500), prose: true };
  const trimmed = line.trim();
  if (!trimmed) return null;
  let ev: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // `null`, `42` and `"a string"` are all valid JSON. Reading .type off them
    // would throw INSIDE a readline handler, i.e. an uncaught exception that
    // takes the whole run down.
    if (!parsed || typeof parsed !== "object") return { text: line, prose: true };
    ev = parsed as Record<string, unknown>;
  } catch {
    // not an event: stderr and any plain-text output pass through untouched, so
    // a crash message is never swallowed by the parser. Treated as prose — a
    // cli that fell back to plain text still speaks for the agent.
    return { text: line, prose: true };
  }

  switch (ev.type) {
    case "assistant":
      return assistantEvent((ev.message as { content?: unknown[] } | undefined)?.content);
    case "result": {
      const final = typeof ev.result === "string" ? ev.result : "";
      // A FAILED result is the only place the reason lives, so it is shown.
      // A successful one repeats the assistant text we already displayed, so it
      // is classified but not printed — otherwise every task ends twice.
      const failed = ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success");
      // the money figure rides on this same event, and a FAILED turn was still
      // billed — dropping its cost would under-count exactly the runs that
      // burned budget for nothing
      return { text: failed ? final : "", prose: failed || undefined, final, costUsd: reportedCostUsd(ev) };
    }
    // a tool result is invisible but it IS the agent working: it must end any
    // "my last word was the marker" state, same as a visible tool call
    case "user":
      return { text: "", activity: true };

    // a still-running tool, heartbeated every 30s. The single most useful line
    // there is during a long command — it is what replaces a blind
    // "…working (1454s)" with "the Bash call is 30s in".
    case "tool_progress": {
      const name = typeof ev.tool_name === "string" ? ev.tool_name : "tool";
      const secs = typeof ev.elapsed_time_seconds === "number" ? ` ${ev.elapsed_time_seconds}s` : "";
      return { text: `⋯ ${name} still running${secs}`, activity: true };
    }

    case "system": {
      // task_* is the lifecycle of a command the agent launched: real work, so
      // it ends the marker state. init/hook/token-counter chatter is the
      // harness talking and must NOT, or a genuine block gets silenced by
      // telemetry that merely trails the final answer.
      const work = typeof ev.subtype === "string" && ev.subtype.startsWith("task_");
      return { text: "", activity: work || undefined };
    }

    // Unknown events are treated as noise ON PURPOSE. Getting it wrong that way
    // keeps a stale marker and fails a task that passed — it is retried. Getting
    // it wrong the other way silences a real block and marks the task DONE.
    // A wasted retry beats a wrong "done", so unknown defaults to noise.
    default:
      return { text: "" };
  }
}
