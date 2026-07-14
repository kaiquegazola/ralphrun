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
  return def.buildCmd({ bin: binOf(cli), prompt, model, cwd, autoApprove });
}
