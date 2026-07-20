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
}

// a single event line past this is not a real event; parsing multi-MB of JSON
// per line would burn CPU for output nobody can read anyway
const MAX_EVENT_CHARS = 256_000;

/** a tool call rendered compactly: the arg that says WHICH thing it touched */
function toolSummary(name: string, input: unknown): string {
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
    case "assistant": {
      const content = (ev.message as { content?: unknown[] } | undefined)?.content;
      if (!Array.isArray(content)) return { text: "", activity: true };
      const out: string[] = [];
      let prose = false;
      for (const block of content) {
        if (!block || typeof block !== "object") continue; // a null entry is valid JSON
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.push(b.text);
          prose = true;
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          out.push(toolSummary(b.name, b.input));
        }
        // "thinking" is deliberately dropped: it is long, it is not the
        // agent's answer, and echoing it would bury the actual work
      }
      return { text: out.join("\n"), prose, activity: true };
    }
    case "result": {
      const final = typeof ev.result === "string" ? ev.result : "";
      // A FAILED result is the only place the reason lives, so it is shown.
      // A successful one repeats the assistant text we already displayed, so it
      // is classified but not printed — otherwise every task ends twice.
      const failed = ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success");
      return { text: failed ? final : "", prose: failed || undefined, final };
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
