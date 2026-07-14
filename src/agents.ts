// agents.ts — THE agent registry. The single source of truth for every coding
// CLI ralphrun can drive.
//
// Adding a CLI = adding ONE entry to AGENTS below. Nothing else. Every other
// module derives what it needs from here instead of re-listing the clis:
//   adapters.ts            -> buildCmd            (spawn args)
//   config.ts              -> binOf/defaultModelOf (BINARIES / DEFAULT_MODELS)
//   diagnostics.ts         -> checkAuth, agentClis (preflight)
//   wizard/configcmd       -> label, models, recommended (pickers)
//   run.ts / loop.ts       -> nativeAdvisor       (NATIVE vs CROSS routing)
//
// Depends on nothing in the app (only node stdlib), so it can be imported from
// any layer without a cycle.

import { execSync } from "node:child_process";

export type AgentRole = "planner" | "executor" | "advisor";

export interface BuildCmdArgs {
  bin: string;
  prompt: string;
  model: string; // "" = let the CLI pick its own default
  cwd: string;
  autoApprove: boolean;
}

export interface AgentDef {
  /** wizard/picker display name */
  label: string;
  /** executable on PATH */
  bin: string;
  /** model used when the user names the cli with no model ("claude" -> "sonnet"). "" = let the CLI decide. */
  defaultModel: string;
  /** models offered in the pickers (first-class list; a user can still type any model) */
  models: { value: string; label: string }[];
  /** per-role pick highlighted as "recommended" (and sorted first) */
  recommended: Partial<Record<AgentRole, string>>;
  /** headless invocation */
  buildCmd(a: BuildCmdArgs): string[];
  /**
   * Server-side advisor: extra args that make THIS cli consult an advisor model
   * mid-task, in one call. Present = the cli supports NATIVE mode. Absent = CROSS.
   */
  nativeAdvisor?: (advisorModel: string) => string[];
  /**
   * Headless auth probe. Absent = no reliable check -> "unknown" (never blocks).
   * Throwing (non-zero exit) is read as "not logged in" by the caller.
   */
  auth?: { loginCommand: string; check(bin: string): boolean };
}

// null-prototype: a lookup like AGENTS["constructor"] / AGENTS["hasOwnProperty"]
// must be undefined (unknown cli), not an inherited Object.prototype member —
// otherwise buildCmd() would call a non-function and throw the wrong error.
export const AGENTS: Record<string, AgentDef> = Object.assign(Object.create(null) as Record<string, AgentDef>, {
  agy: {
    label: "Antigravity CLI",
    bin: "agy",
    defaultModel: "",
    // `agy models` — NOTE these contain SPACES. Safe here: we spawn without a
    // shell, so the model is one argv element. Quotes are only needed when a
    // human types `--executor "agy:Gemini 3.1 Pro (High)"` into a terminal.
    models: [
      { value: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)" },
      { value: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)" },
      { value: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)" },
      { value: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)" },
      { value: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
      { value: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking)" },
      { value: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking)" },
      { value: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B (Medium)" },
    ],
    // advisor leans on a DIFFERENT model family than the executor — the whole
    // point of the advisor is a second opinion, not an echo.
    recommended: {
      planner: "Gemini 3.1 Pro (High)",
      executor: "Gemini 3.1 Pro (High)",
      advisor: "Claude Opus 4.6 (Thinking)",
    },
    buildCmd: ({ bin, prompt, model, autoApprove }) => {
      const cmd = [bin, "-p", prompt];
      if (model) cmd.push("--model", model);
      if (autoApprove) cmd.push("--dangerously-skip-permissions");
      return cmd;
    },
  },

  claude: {
    label: "Claude Code CLI",
    bin: "claude",
    defaultModel: "sonnet",
    models: [
      { value: "sonnet", label: "sonnet" },
      { value: "opus", label: "opus" },
      { value: "fable", label: "fable" },
      { value: "haiku", label: "haiku" },
    ],
    recommended: { planner: "opus", executor: "sonnet", advisor: "fable" },
    buildCmd: ({ bin, prompt, model, autoApprove }) => {
      const cmd = [bin, "-p", prompt];
      if (model) cmd.push("--model", model);
      if (autoApprove) cmd.push("--dangerously-skip-permissions");
      return cmd;
    },
    // the only cli with a server-side advisor today (needs Claude Code >= 2.1.170)
    nativeAdvisor: (advisorModel) => ["--advisor", advisorModel],
    auth: {
      loginCommand: "claude auth login",
      check: (bin) => {
        execSync(`${bin} auth status`, { stdio: "ignore" }); // exit 0 = logged in, throws otherwise
        return true;
      },
    },
  },

  grok: {
    label: "Grok CLI",
    bin: "grok",
    defaultModel: "grok-4.5",
    models: [{ value: "grok-4.5", label: "grok-4.5" }],
    recommended: { planner: "grok-4.5", executor: "grok-4.5", advisor: "grok-4.5" },
    buildCmd: ({ bin, prompt, model, cwd, autoApprove }) => {
      const cmd = [bin, "-p", prompt, "--cwd", cwd];
      if (model) cmd.push("-m", model);
      if (autoApprove) cmd.push("--always-approve");
      return cmd;
    },
  },

  cursor: {
    label: "Cursor CLI",
    bin: "cursor-agent",
    defaultModel: "", // router cli: no model = Cursor picks its own (auto)
    // Cursor's model IDs churn fast and now carry effort suffixes; these are a
    // curated slice of valid `cursor agent models` (a user can still type any
    // exact id via the "custom" picker). Stale ids make the CLI hard-fail every
    // task ("Cannot use this model: ..."), so keep these matching the real list.
    models: [
      { value: "auto", label: "Auto (Cursor picks)" },
      { value: "composer-2.5", label: "Composer 2.5" },
      { value: "claude-sonnet-5-high", label: "Sonnet 5 1M" },
      { value: "claude-sonnet-5-thinking-high", label: "Sonnet 5 1M Thinking" },
      { value: "claude-opus-4-8-high", label: "Opus 4.8 1M" },
      { value: "claude-opus-4-8-thinking-high", label: "Opus 4.8 1M Thinking" },
      { value: "claude-fable-5-high", label: "Fable 5 1M" },
      { value: "gpt-5.6-sol-high", label: "GPT-5.6 Sol High" },
      { value: "gpt-5.6-terra-high", label: "GPT-5.6 Terra High" },
      { value: "gpt-5.5-high", label: "GPT-5.5 High" },
      { value: "cursor-grok-4.5-high", label: "Cursor Grok 4.5" },
      { value: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
    ],
    recommended: {
      planner: "claude-opus-4-8-high",
      executor: "claude-sonnet-5-high",
      advisor: "claude-opus-4-8-high",
    },
    buildCmd: ({ bin, prompt, model, autoApprove }) => {
      const cmd = [bin, "agent", "--trust", "-p", prompt];
      if (model) cmd.push("--model", model);
      if (autoApprove) cmd.push("--force");
      return cmd;
    },
    auth: {
      loginCommand: "cursor agent login",
      check: (bin) => {
        // exits 0 either way — the answer is in the text
        const out = execSync(`${bin} status`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return !out.includes("Not logged in");
      },
    },
  },

  codex: {
    label: "Codex CLI",
    bin: "codex",
    defaultModel: "",
    models: [
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { value: "gpt-5.6-lua", label: "GPT-5.6 Lua" },
      { value: "gpt-4.5-preview", label: "GPT-4.5 Preview" },
    ],
    recommended: { planner: "gpt-5.6-sol", executor: "gpt-5.6-sol", advisor: "gpt-5.6-sol" },
    buildCmd: ({ bin, prompt, model, autoApprove }) => {
      const cmd = [bin, "exec"];
      if (model) cmd.push("-m", model);
      if (autoApprove) cmd.push("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust");
      cmd.push(prompt); // codex takes the prompt LAST, after the flags
      return cmd;
    },
  },
} satisfies Record<string, AgentDef>);

/** every registered cli, in picker order */
export const agentClis: string[] = Object.keys(AGENTS);

export function agentDef(cli: string): AgentDef | undefined {
  return AGENTS[cli];
}

/** binary for a cli; unknown cli falls back to the cli name itself */
export function binOf(cli: string): string {
  return AGENTS[cli]?.bin ?? cli;
}

/** model to use when the user names a cli with no model; "" = let the cli decide */
export function defaultModelOf(cli: string): string {
  return AGENTS[cli]?.defaultModel ?? "";
}

/** NATIVE mode: same cli on both sides AND that cli has a server-side advisor */
export function supportsNativeAdvisor(executorCli: string, advisorCli: string | undefined | null): boolean {
  return !!advisorCli && executorCli === advisorCli && !!AGENTS[executorCli]?.nativeAdvisor;
}

/** the extra spawn args that turn an executor call into a NATIVE advised call */
export function nativeAdvisorArgs(executorCli: string, advisorModel: string): string[] {
  return AGENTS[executorCli]?.nativeAdvisor?.(advisorModel) ?? [];
}
