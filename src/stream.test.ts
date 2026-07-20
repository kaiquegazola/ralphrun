// stream.test.ts — the event shapes here are copied from a REAL captured run of
// `claude -p ... --output-format stream-json --verbose`, not invented.
import { describe, expect, it } from "vitest";

import { parseClaudeStream } from "./stream.js";

const assistant = (content: unknown[]): string =>
  JSON.stringify({ type: "assistant", message: { model: "claude-haiku-4-5", role: "assistant", content } });

describe("parseClaudeStream", () => {
  it("surfaces the model's prose as prose (the only thing the blocked marker is read from)", () => {
    const ev = parseClaudeStream(assistant([{ type: "text", text: "Done. hello.txt created." }]));
    expect(ev).toEqual({ text: "Done. hello.txt created.", prose: true, activity: true });
  });

  it("renders a tool call compactly, and NOT as prose", () => {
    const ev = parseClaudeStream(
      assistant([{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/w/hello.txt", content: "pipes" } }]),
    );
    // not prose: a tool argument quoting the marker must never fail the task
    expect(ev).toEqual({ text: "→ Write(/w/hello.txt)", prose: false, activity: true });
  });

  it("picks the argument that says WHICH thing the tool touched", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ command: "npm run   test" }, "→ Bash(npm run test)"], // whitespace collapsed
      [{ pattern: "TODO" }, "→ Bash(TODO)"],
      [{ url: "https://x.dev" }, "→ Bash(https://x.dev)"],
      [{ irrelevant: 1 }, "→ Bash"], // nothing identifying -> bare name
      [{ file_path: "   " }, "→ Bash"], // blank does not count as identifying
      [{ file_path: 42 }, "→ Bash"], // non-string is not identifying either
    ];
    for (const [input, expected] of cases) {
      expect(parseClaudeStream(assistant([{ type: "tool_use", name: "Bash", input }]))?.text).toBe(expected);
    }
  });

  it("truncates a long tool argument instead of flooding the pane", () => {
    const ev = parseClaudeStream(assistant([{ type: "tool_use", name: "Bash", input: { command: "x".repeat(200) } }]));
    expect(ev!.text!.length).toBeLessThan(100);
    expect(ev!.text).toContain("…");
  });

  // a long absolute path chopped from the right shows only the prefix every
  // line shares, and hides the one part that identifies it: the file name
  it("keeps the TAIL of a long path and the HEAD of a long command", () => {
    const path = "/private/tmp/some/very/deep/build/output/directory/tree/that/keeps/going/src/thing.ts";
    const asPath = parseClaudeStream(assistant([{ type: "tool_use", name: "Read", input: { file_path: path } }]));
    expect(asPath!.text).toContain("src/thing.ts");
    expect(asPath!.text!.startsWith("→ Read(…")).toBe(true);

    const cmd = "npm run test -- " + "a".repeat(200);
    const asCmd = parseClaudeStream(assistant([{ type: "tool_use", name: "Bash", input: { command: cmd } }]));
    expect(asCmd!.text).toContain("→ Bash(npm run test -- ");
    expect(asCmd!.text!.endsWith("…)")).toBe(true);
  });

  // the choice is made by FIELD, not by content: a command that merely contains
  // a path is still a command, and trimming its head would hide what it RUNS
  it("keeps the head of a long command even when it contains a path", () => {
    const cmd = "cat /private/tmp/some/very/deep/directory/tree/that/keeps/going/and/going/note.txt";
    const ev = parseClaudeStream(assistant([{ type: "tool_use", name: "Bash", input: { command: cmd } }]));
    expect(ev!.text!.startsWith("→ Bash(cat /private/tmp/")).toBe(true);
  });

  it("survives a tool_use with no input at all", () => {
    expect(parseClaudeStream(assistant([{ type: "tool_use", name: "Bash" }]))?.text).toBe("→ Bash");
    expect(parseClaudeStream(assistant([{ type: "tool_use", name: "Bash", input: "nope" }]))?.text).toBe("→ Bash");
  });

  it("drops thinking blocks — long, not the answer, and it would bury the work", () => {
    const ev = parseClaudeStream(assistant([{ type: "thinking", thinking: "a".repeat(610) }]));
    expect(ev).toEqual({ text: "", prose: false, activity: true });
  });

  it("keeps prose and tool calls from the same message, in order", () => {
    const ev = parseClaudeStream(
      assistant([
        { type: "thinking", thinking: "..." },
        { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
        { type: "text", text: "and here is why" },
      ]),
    );
    expect(ev).toEqual({ text: "→ Read(a.ts)\nand here is why", prose: true, activity: true });
  });

  it("treats every other event kind as liveness only", () => {
    const noisy = [
      { type: "system", subtype: "init", cwd: "/w" },
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 114 },
      { type: "system", subtype: "hook_started", hook_id: "7a32" },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "File created" }] } },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } },
      // the final result duplicates the last assistant text — showing it twice
      // would make every task end with a doubled answer
      { type: "result", subtype: "success", result: "Done. hello.txt created." },
    ];
    for (const ev of noisy) expect(parseClaudeStream(JSON.stringify(ev))?.text).toBe("");
  });

  // captured shape: {"type":"tool_progress","tool_name":"Bash",
  // "elapsed_time_seconds":30,"heartbeat":true,...} — emitted while a command
  // is STILL RUNNING, which is exactly what a blind "…working (Ns)" could not say
  it("shows a still-running tool, with how long it has been going", () => {
    const ev = parseClaudeStream(
      JSON.stringify({ type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: 30, heartbeat: true }),
    );
    expect(ev).toEqual({ text: "⋯ Bash still running 30s", activity: true });
  });

  it("still renders a tool_progress missing its name or elapsed time", () => {
    expect(parseClaudeStream(JSON.stringify({ type: "tool_progress" }))).toEqual({
      text: "⋯ tool still running",
      activity: true,
    });
  });

  // a task_* event is the lifecycle of a command the AGENT launched
  it("counts task lifecycle events as agent work, and harness chatter as noise", () => {
    const work = [
      { type: "system", subtype: "task_started", task_id: "b80", task_type: "local_bash" },
      { type: "system", subtype: "task_notification", task_id: "b80", status: "completed" },
      { type: "system", subtype: "task_updated", task_id: "b80" },
    ];
    for (const e of work) expect(parseClaudeStream(JSON.stringify(e))).toEqual({ text: "", activity: true });

    const chatter = [
      { type: "system", subtype: "init" },
      { type: "system", subtype: "hook_response", output: "x" },
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 1 },
      { type: "system" },
    ];
    for (const e of chatter) expect(parseClaudeStream(JSON.stringify(e))).toEqual({ text: "", activity: undefined });
  });

  it("passes non-JSON through as prose so a crash message is never swallowed", () => {
    expect(parseClaudeStream("Error: ENOENT, cannot find claude")).toEqual({
      text: "Error: ENOENT, cannot find claude",
      prose: true,
    });
  });

  it("ignores blank lines", () => {
    expect(parseClaudeStream("")).toBeNull();
    expect(parseClaudeStream("   ")).toBeNull();
  });

  it("survives an assistant event with a malformed content field", () => {
    expect(parseClaudeStream(JSON.stringify({ type: "assistant", message: { content: "not an array" } }))).toEqual({
      text: "",
      activity: true,
    });
    expect(parseClaudeStream(JSON.stringify({ type: "assistant" }))).toEqual({ text: "", activity: true });
  });
});

// these are all VALID json, so the try/catch around JSON.parse does not save us
// — and an exception here is thrown inside a readline handler, which would take
// the whole run down rather than lose one line
describe("parseClaudeStream hostile input", () => {
  it("passes valid JSON scalars through as text instead of reading .type off them", () => {
    for (const raw of ["null", "42", '"a string"', "true"]) {
      expect(() => parseClaudeStream(raw)).not.toThrow();
      expect(parseClaudeStream(raw)).toEqual({ text: raw, prose: true });
    }
  });

  it("treats a bare array as an unknown event rather than crashing", () => {
    // typeof [] === "object", so it reaches the switch and has no .type
    expect(parseClaudeStream("[1,2,3]")).toEqual({ text: "" });
  });

  it("survives null entries inside an assistant content array", () => {
    const raw = JSON.stringify({
      type: "assistant",
      message: { content: [null, 7, { type: "text", text: "still here" }] },
    });
    expect(parseClaudeStream(raw)).toEqual({ text: "still here", prose: true, activity: true });
  });

  it("does not parse an absurdly long line, and truncates it for display", () => {
    const huge = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(300_000) }] } });
    const ev = parseClaudeStream(huge);
    expect(ev!.text!.length).toBeLessThan(600);
    expect(ev!.text).toContain("…");
  });
});

describe("parseClaudeStream result events", () => {
  it("classifies a successful result without printing it twice", () => {
    const ev = parseClaudeStream(JSON.stringify({ type: "result", subtype: "success", result: "Done." }));
    expect(ev).toEqual({ text: "", prose: undefined, final: "Done." });
  });

  it("prints a failed result — its reason exists nowhere else", () => {
    const ev = parseClaudeStream(
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "hit the turn limit" }),
    );
    expect(ev).toEqual({ text: "hit the turn limit", prose: true, final: "hit the turn limit" });
  });

  it("treats a non-success subtype as failed even without is_error", () => {
    const ev = parseClaudeStream(JSON.stringify({ type: "result", subtype: "error_during_execution", result: "boom" }));
    expect(ev!.prose).toBe(true);
    expect(ev!.text).toBe("boom");
  });

  it("survives a result with no result string", () => {
    expect(parseClaudeStream(JSON.stringify({ type: "result", subtype: "success" }))).toEqual({
      text: "",
      prose: undefined,
      final: "",
    });
  });
});
