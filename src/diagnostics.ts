import which from "which";
import { execSync } from "node:child_process";
import { BINARIES } from "./config.js";

export interface AgentDiagnostic {
  cli: string;
  installed: boolean;
  loggedIn: boolean | "unknown";
  loginCommand?: string;
}

export function checkAgent(cli: string): AgentDiagnostic {
  // a shape-corrupt config can hand us a non-string cli at runtime — which.sync
  // throws a TypeError on non-strings (nothrow only covers not-found), so gate it.
  const bin = BINARIES[cli] ?? cli;
  const installed = typeof bin === "string" && !!which.sync(bin, { nothrow: true });
  
  if (!installed) {
    return { cli, installed: false, loggedIn: "unknown" };
  }

  let loggedIn: boolean | "unknown" = "unknown";
  let loginCommand: string | undefined = undefined;

  try {
    if (cli === "claude") {
      loginCommand = "claude auth login";
      // returns 0 if logged in, 1 if not
      execSync(`${bin} auth status`, { stdio: "ignore" });
      loggedIn = true;
    } else if (cli === "cursor") {
      loginCommand = "cursor agent login";
      // returns 0 but prints "Not logged in" if not logged in
      const out = execSync(`${bin} agent status`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (out.includes("Not logged in")) {
        loggedIn = false;
      } else {
        loggedIn = true;
      }
    } else if (cli === "grok") {
      // Grok doesn't have a reliable headless auth status check yet.
      loggedIn = "unknown";
    }
  } catch (err) {
    // If execSync throws (non-zero exit code), it's generally not logged in
    loggedIn = false;
  }

  return { cli, installed, loggedIn, loginCommand };
}

export function checkAllAgents(): AgentDiagnostic[] {
  return ["claude", "grok", "cursor"].map(checkAgent);
}
