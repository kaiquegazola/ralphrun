// adapters.ts — build the headless command for each coding CLI

import { BINARIES } from "./config.js";

export function buildCmd(
  cli: string,
  prompt: string,
  model: string,
  cwd: string,
  autoApprove: boolean,
): string[] {
  const bin = BINARIES[cli] ?? cli;
  if (cli === "claude") {
    const cmd: string[] = [bin, "-p", prompt];
    if (model) cmd.push("--model", model);
    if (autoApprove) cmd.push("--dangerously-skip-permissions");
    return cmd;
  }
  if (cli === "grok") {
    const cmd: string[] = [bin, "-p", prompt, "--cwd", cwd];
    if (model) cmd.push("-m", model);
    if (autoApprove) cmd.push("--always-approve");
    return cmd;
  }
  if (cli === "cursor") {
    const cmd: string[] = [bin, "agent", "--trust", "-p", prompt];
    if (model) cmd.push("--model", model);
    if (autoApprove) cmd.push("--force");
    return cmd;
  }
  if (cli === "agy") {
    const cmd: string[] = [bin, "-p", prompt];
    if (model) cmd.push("--model", model);
    if (autoApprove) cmd.push("--dangerously-skip-permissions");
    return cmd;
  }
  if (cli === "codex") {
    const cmd: string[] = [bin, "exec"];
    if (model) cmd.push("-m", model);
    if (autoApprove) cmd.push("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust");
    cmd.push(prompt);
    return cmd;
  }
  throw new Error(`unknown cli: ${cli}`);
}