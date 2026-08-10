// adapters.ts — build the headless command for a coding CLI.
// The per-cli knowledge lives in the registry (agents.ts); this is just the seam
// the rest of the app calls through.

import { agentDef, binOf } from "./agents.js";

/**
 * Which tool grant a call asks for. "read" is the reviewer that only inspects,
 * "exec" the one allowed to run its own checks (see reviewexec.ts). "exec" falls
 * back to "read" on a cli with no execution grant: the review still happens, it
 * just cannot run anything — which is strictly better than inventing a flag.
 */
export type ReviewTools = "none" | "read" | "exec";

export function buildCmd(
  cli: string,
  prompt: string,
  model: string,
  cwd: string,
  autoApprove: boolean,
  reviewTools: ReviewTools = "none",
  /**
   * Continue an earlier conversation instead of starting one. Used only by the
   * fix loop, where the agent already read the task and the codebase and the
   * only new information is what went wrong — see run.ts.
   */
  resumeSession?: string,
): string[] {
  const def = agentDef(cli);
  if (!def) throw new Error(`unknown cli: ${cli}`);
  // an in-process backend (see cursor-sdk.ts) has no argv at all
  if (!def.buildCmd) throw new Error(`${cli} has no command line: it runs in-process`);
  // A stdin cli gets an EMPTY prompt in the argv — the caller pipes the real
  // one in. Keeping it out of the command line is what lets a 25k review prompt
  // survive Windows, where a .cmd shim goes through cmd.exe's ~8191 char limit.
  const argvPrompt = def.promptVia === "stdin" ? "" : prompt;
  return def.buildCmd({
    bin: binOf(cli),
    prompt: argvPrompt,
    model,
    cwd,
    autoApprove,
    reviewArgs: reviewTools === "none" ? undefined : reviewTools === "exec" ? (def.reviewExecArgs ?? def.reviewArgs) : def.reviewArgs,
    // absent when this cli has no resume of its own: the caller then sends a
    // whole prompt, which is what every cli did before this existed
    resumeArgs: resumeSession && def.resumeArgs ? def.resumeArgs(resumeSession) : undefined,
  });
}

/** does this cli expect its prompt piped in rather than passed as an argument? */
export function promptViaStdin(cli: string): boolean {
  return agentDef(cli)?.promptVia === "stdin";
}
