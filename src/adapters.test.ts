// adapters.test.ts — buildCmd for each cli
import { describe, it, expect } from "vitest";
import { buildCmd } from "./adapters.js";

describe("buildCmd", () => {
  it("claude with model + autoApprove", () => {
    expect(buildCmd("claude", "P", "sonnet", "/w", true)).toEqual([
      "claude", "-p", "P", "--model", "sonnet", "--dangerously-skip-permissions",
    ]);
  });
  it("claude without model, no autoApprove", () => {
    expect(buildCmd("claude", "P", "", "/w", false)).toEqual(["claude", "-p", "P"]);
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
  it("codex uses exec with the configured model and automation flags", () => {
    expect(buildCmd("codex", "P", "gpt-5.6-sol", "/w", true)).toEqual([
      "codex", "exec", "-m", "gpt-5.6-sol", "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust", "P",
    ]);
  });
  it("unknown cli throws", () => {
    expect(() => buildCmd("nope", "P", "", "/w", false)).toThrow("unknown cli: nope");
  });
});
