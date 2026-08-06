// diagnostics.ts — is each cli installed / logged in? Preflight fails fast on a
// missing or logged-out cli instead of burning every task's retry budget.
// The per-cli probe lives in the registry (agents.ts); this only runs it.

import which from "which";
import { agentClis, agentDef, binOf } from "./agents.js";
import { cursorSdkInstalled } from "./cursor-sdk.js";

export interface AgentDiagnostic {
  cli: string;
  installed: boolean;
  loggedIn: boolean | "unknown";
  loginCommand?: string;
}

export function checkAgent(cli: string): AgentDiagnostic {
  // a shape-corrupt config can hand us a non-string cli at runtime — which.sync
  // throws a TypeError on non-strings (nothrow only covers not-found), so gate it.
  const def = agentDef(cli);
  const bin = binOf(cli);
  // An in-process backend has no binary to look for; its "install" is the
  // optional package, which is NOT installed by default. Resolving it (never
  // importing it) is the same fail-fast promise the PATH probe makes: without
  // it every task in the PRD burns its whole retry budget on the same import.
  const installed = def?.sdk
    ? cursorSdkInstalled()
    : typeof bin === "string" && !!which.sync(bin, { nothrow: true });
  if (!installed) return { cli, installed: false, loggedIn: "unknown" };

  // no registered probe (grok, agy, codex and opencode have no reliable headless
  // auth check) → "unknown", which never blocks the run.
  const auth = def?.auth;
  if (!auth) return { cli, installed, loggedIn: "unknown" };

  let loggedIn: boolean | "unknown";
  try {
    loggedIn = auth.check(bin);
  } catch {
    // probe threw (non-zero exit) → read as logged out
    loggedIn = false;
  }
  return { cli, installed, loggedIn, loginCommand: auth.loginCommand };
}

export function checkAllAgents(): AgentDiagnostic[] {
  return agentClis.map(checkAgent);
}
