// adapters.ts — build the headless command for a coding CLI.
// The per-cli knowledge lives in the registry (agents.ts); this is just the seam
// the rest of the app calls through.

import { agentDef, binOf } from "./agents.js";

export function buildCmd(
  cli: string,
  prompt: string,
  model: string,
  cwd: string,
  autoApprove: boolean,
): string[] {
  const def = agentDef(cli);
  if (!def) throw new Error(`unknown cli: ${cli}`);
  // A stdin cli gets an EMPTY prompt in the argv — the caller pipes the real
  // one in. Keeping it out of the command line is what lets a 25k review prompt
  // survive Windows, where a .cmd shim goes through cmd.exe's ~8191 char limit.
  const argvPrompt = def.promptVia === "stdin" ? "" : prompt;
  return def.buildCmd({ bin: binOf(cli), prompt: argvPrompt, model, cwd, autoApprove });
}

/** does this cli expect its prompt piped in rather than passed as an argument? */
export function promptViaStdin(cli: string): boolean {
  return agentDef(cli)?.promptVia === "stdin";
}
