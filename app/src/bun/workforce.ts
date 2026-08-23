// workforce.ts — "is this machine able to run agents right now?", answered
// continuously instead of once at boot. Wraps the core's preflight
// (diagnostics.checkAgent) and the agent registry, and adds the one thing a
// GUI needs and a CLI never did: a stable identity per cli (two letters and a
// colour) reused on every screen.

import { agentClis, agentDef, binOf, defaultModelOf } from "../../../src/agents.js";
import { BROWSER_INSTALL_HINT, browserStatus } from "../../../src/browser.js";
import { checkAgent } from "../../../src/diagnostics.js";
import { agentColor, agentInitials } from "../shared/identity.ts";
import { activeRuns } from "./runs.ts";
import type { AgentView, WorkforceView } from "../shared/types.ts";

// The registry knows how to LOG IN to a cli but not how to install one, and a
// "✗ não instalado" row with no next step is the one state the mockup gives a
// command to. Kept here rather than in the core: it is a UI affordance.
const INSTALL_HINTS: Record<string, string> = {
  claude: "npm i -g @anthropic-ai/claude-code",
  codex: "npm i -g @openai/codex",
  cursor: "curl https://cursor.com/install -fsS | bash",
  opencode: "npm i -g opencode-ai",
  grok: "npm i -g @vibe-kit/grok-cli",
  agy: "npm i -g @antigravity/cli",
};

export function workforce(): WorkforceView {
  const busyByCli = new Map<string, number>();
  // RUNNING, not merely active: a queued run has no child yet, and counting it
  // would report every agent as occupied the moment the queue fills up.
  for (const run of activeRuns().filter((r) => r.status === "running" || r.status === "attention")) {
    // Executor only. An advisor REVIEWS — it does not hold a task slot, and
    // counting it would inflate the number that gates how much more work this
    // machine can take on. (The line that used to "initialise" the advisor's
    // counter to 0 did nothing: an absent key already reads as 0.)
    busyByCli.set(run.executor.cli, (busyByCli.get(run.executor.cli) ?? 0) + Math.max(1, run.doing));
  }

  const agents: AgentView[] = agentClis.map((cli) => {
    const diag = checkAgent(cli);
    const def = agentDef(cli);
    const recommended = def?.recommended.executor ?? defaultModelOf(cli);
    const models = (def?.models ?? []).map((m) => ({ name: m.value, recommended: m.value === recommended }));
    // recommended first, then the rest — the same ordering the pickers use
    models.sort((a, b) => Number(b.recommended) - Number(a.recommended));

    const hint = !diag.installed
      ? (INSTALL_HINTS[cli] ?? `install ${binOf(cli)}`)
      : diag.loggedIn === false
        ? (diag.loginCommand ?? `${binOf(cli)} login`)
        : null;

    return {
      cli,
      label: def?.label ?? cli,
      initials: agentInitials(cli),
      color: agentColor(cli),
      installed: diag.installed,
      // "unknown" is not a failure: several clis have no headless auth probe,
      // and treating that as logged-out would red-flag a perfectly good setup.
      loggedIn: diag.loggedIn !== false,
      hint,
      models: models.slice(0, 6),
      activeTasks: busyByCli.get(cli) ?? 0,
    };
  });

  // installed-and-usable first, then broken, then absent — the list is a
  // to-do list when something is wrong and a roster when nothing is.
  agents.sort((a, b) => {
    const rank = (x: AgentView) => (!x.installed ? 2 : x.loggedIn ? 0 : 1);
    return rank(a) - rank(b) || a.cli.localeCompare(b.cli);
  });

  const status = browserStatus();
  return {
    agents,
    checkedAt: Date.now(),
    browser: {
      ok: status === "ok",
      label:
        status === "ok"
          ? "browser de teste presente — verify de UI habilitado"
          : status === "broken"
            ? "dev-browser instalado mas não executa"
            : BROWSER_INSTALL_HINT,
    },
  };
}
