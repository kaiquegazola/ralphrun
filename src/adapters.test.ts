// adapters.test.ts — buildCmd for each cli
import { describe, it, expect } from "vitest";
import { buildCmd, promptViaStdin } from "./adapters.js";

describe("buildCmd", () => {
  // claude reads its prompt from stdin, so it must NOT appear in the argv —
  // that is what keeps a 25k prompt under cmd.exe's ~8191 char limit on Windows
  it("claude with model + autoApprove keeps the prompt out of the argv", () => {
    expect(buildCmd("claude", "P", "sonnet", "/w", true)).toEqual([
      "claude", "-p", "--model", "sonnet", "--dangerously-skip-permissions",
    ]);
  });
  it("claude without model, no autoApprove", () => {
    expect(buildCmd("claude", "P", "", "/w", false)).toEqual(["claude", "-p"]);
  });
  it("grok with model + autoApprove uses cursor-agent-style flags and cwd", () => {
    expect(buildCmd("grok", "P", "grok-4.5", "/w", true)).toEqual([
      "grok", "-p", "P", "--cwd", "/w", "-m", "grok-4.5", "--always-approve",
    ]);
  });
  it("grok without model, no autoApprove", () => {
    expect(buildCmd("grok", "P", "", "/w", false)).toEqual(["grok", "-p", "P", "--cwd", "/w"]);
  });
  it("cursor with model + autoApprove uses cursor-agent binary", () => {
    expect(buildCmd("cursor", "P", "gpt", "/w", true)).toEqual([
      "cursor-agent", "agent", "--trust", "-p", "P", "--model", "gpt", "--force",
    ]);
  });
  it("cursor without model, no autoApprove", () => {
    expect(buildCmd("cursor", "P", "", "/w", false)).toEqual([
      "cursor-agent", "agent", "--trust", "-p", "P",
    ]);
  });
  it("agy passes the prompt and model", () => {
    expect(buildCmd("agy", "P", "gemini-2.5-pro", "/w", true)).toEqual([
      "agy", "-p", "P", "--model", "gemini-2.5-pro", "--dangerously-skip-permissions",
    ]);
  });
  // codex also reads stdin ("Reading prompt from stdin..."), so no prompt argument
  it("codex uses exec with the configured model and automation flags", () => {
    expect(buildCmd("codex", "P", "gpt-5.6-sol", "/w", true)).toEqual([
      "codex", "exec", "-m", "gpt-5.6-sol", "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
    ]);
  });
  it("opencode uses run with --model, --auto and the prompt last", () => {
    expect(buildCmd("opencode", "P", "opencode/big-pickle", "/w", true)).toEqual([
      "opencode", "run", "--model", "opencode/big-pickle", "--auto", "P",
    ]);
  });
  it("opencode without model, no autoApprove", () => {
    expect(buildCmd("opencode", "P", "", "/w", false)).toEqual(["opencode", "run", "P"]);
  });
  // The reviewer judges a diff cut at 12k chars that can also be empty; the
  // allowlist is what lets it open the files that view left out. It is an
  // allowlist and not an approve-all, so the advisor still cannot write.
  it("claude gets read-only tools on the review call only", () => {
    expect(buildCmd("claude", "P", "fable", "/w", false, "read")).toEqual([
      "claude", "-p", "--model", "fable", "--allowedTools", "Read,Grep,Glob",
    ]);
    expect(buildCmd("claude", "P", "fable", "/w", false)).toEqual(["claude", "-p", "--model", "fable"]);
  });
  // "exec" is a WIDER grant, not a different one: a reviewer that can run the
  // suite but can no longer open a file would be a downgrade.
  it("claude gets the command grant on an exec review, and it still allows reads", () => {
    const cmd = buildCmd("claude", "P", "fable", "/w", false, "exec");
    expect(cmd).toContain("--disallowedTools");
    const allowed = cmd[cmd.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("Read");
    expect(allowed).toContain("Bash(vitest:*)");
  });
  // asking for tools from a cli with no verified read-only flag must be a no-op,
  // not a guessed flag that makes every review fail on an unknown argument
  it("a cli that declares no reviewArgs is unchanged by the request", () => {
    for (const cli of ["grok", "cursor", "codex", "opencode", "agy"]) {
      for (const want of ["read", "exec"] as const) {
        expect(buildCmd(cli, "P", "", "/w", false, want)).toEqual(buildCmd(cli, "P", "", "/w", false));
      }
    }
  });
  it("unknown cli throws", () => {
    expect(() => buildCmd("nope", "P", "", "/w", false)).toThrow("unknown cli: nope");
  });
  // a registered cli with no argv is a DIFFERENT problem than a typo, so it must
  // not be reported as "unknown cli"
  it("an in-process backend throws its own error", () => {
    expect(() => buildCmd("cursorsdk", "P", "composer-2", "/w", false)).toThrow("has no command line");
  });
});

describe("promptViaStdin", () => {
  // the prompt is the ONLY oversized part of a command line: keeping it out of
  // the argv is what makes a big prompt survive a Windows .cmd shim
  it("is true exactly for the clis observed reading stdin", () => {
    expect(promptViaStdin("claude")).toBe(true);
    expect(promptViaStdin("codex")).toBe(true);
  });
  it("is false for clis that only take a positional prompt", () => {
    for (const cli of ["grok", "cursor", "cursorsdk", "opencode", "agy"]) expect(promptViaStdin(cli)).toBe(false);
  });
  it("is false for an unknown cli", () => {
    expect(promptViaStdin("nope")).toBe(false);
  });
  it("leaves a non-stdin cli's prompt in the argv", () => {
    expect(buildCmd("opencode", "P", "", "/w", false)).toContain("P");
  });
});

