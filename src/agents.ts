// agents.ts — THE agent registry. The single source of truth for every coding
// CLI ralphrun can drive.
//
// Adding a CLI = adding ONE entry to AGENTS below, or — for a cli with an
// ordinary command line — a JSON manifest the user drops in their config dir
// (see "Agent manifests" at the bottom). Nothing else. Every other module
// derives what it needs from here instead of re-listing the clis:
//   adapters.ts            -> buildCmd            (spawn args)
//   config.ts              -> binOf/defaultModelOf (BINARIES / DEFAULT_MODELS)
//   diagnostics.ts         -> checkAuth, agentClis (preflight)
//   wizard/configcmd       -> label, models, recommended (pickers)
//   run.ts / loop.ts       -> nativeAdvisor       (NATIVE vs CROSS routing)
//
// Imports only node stdlib and userconfig.ts (which is itself stdlib-only), so
// it can still be imported from any layer without a cycle.

import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { EXEC_ALLOWED_COMMANDS, EXEC_DENIED_COMMANDS } from "./reviewexec.js";
import { parseClaudeStream, type StreamEvent } from "./stream.js";
import { configDir } from "./userconfig.js";

export type AgentRole = "planner" | "executor" | "advisor";

export interface BuildCmdArgs {
  bin: string;
  prompt: string;
  model: string; // "" = let the CLI pick its own default
  cwd: string;
  autoApprove: boolean;
  /**
   * The def's own `reviewArgs`, handed back only on the review call (see
   * adapters.buildCmd) and absent everywhere else. It comes through here rather
   * than being appended by adapters because only the def knows where in its own
   * argv a flag may sit — several clis take the prompt as the LAST element.
   */
  reviewArgs?: string[];
  /** the def's own `resumeArgs`, handed back only on a fix round */
  resumeArgs?: string[];
}

export interface AgentDef {
  /** wizard/picker display name */
  label: string;
  /** executable on PATH */
  bin?: string;
  /**
   * This backend is driven IN-PROCESS through an SDK: no binary on PATH, no
   * argv. Set it and `bin`/`buildCmd` are meaningless — executor.ts and
   * advisor.ts route past the spawn path, diagnostics.ts stops looking for a
   * binary, and adapters.buildCmd throws instead of calling a missing method.
   */
  sdk?: true;
  /** model used when the user names the cli with no model ("claude" -> "sonnet"). "" = let the CLI decide. */
  defaultModel: string;
  /** models offered in the pickers (first-class list; a user can still type any model) */
  models: { value: string; label: string }[];
  /** per-role pick highlighted as "recommended" (and sorted first) */
  recommended: Partial<Record<AgentRole, string>>;
  /**
   * Continue a previous conversation by session id, for the clis that can.
   *
   * The fix loop's second call re-sends the whole task prompt today, so the
   * agent re-reads the codebase it just finished reading. Resuming makes the
   * round cost what it actually is — the feedback. Absent = no resume, and the
   * caller falls back to a full prompt, which is what every cli did before.
   *
   * Per-cli because the session id and the flag are both dialect: only a def
   * knows whether its cli has one and where in its argv it goes.
   */
  resumeArgs?: (sessionId: string) => string[];
  /** headless invocation */
  buildCmd?(a: BuildCmdArgs): string[];
  /**
   * READ-ONLY tool grant for the review call: the flags that let this cli open
   * the files the truncated diff left out. Absent = this cli reviews the diff
   * text alone, which is what all of them did before.
   *
   * Two conditions before adding one, both load-bearing:
   *  - the flag must grant reads WITHOUT granting writes. The review runs at
   *    autoApprove:false precisely so the advisor cannot touch the workspace;
   *    a blanket "approve everything" flag would trade the whole reason for it.
   *  - it must not be able to PROMPT. Nobody is on the other end of a review,
   *    so a cli that stops to ask does not review, it burns advisor_timeout.
   *
   * The read-only part is enforced by the target cli, never by ralphrun: we
   * spawn the cli, and its tool calls never pass through spawn.ts for us to
   * see, let alone refuse.
   */
  reviewArgs?: string[];
  /**
   * The WIDER grant for a reviewer that is allowed to run its own checks
   * (config: review_runs_commands). Same two conditions as `reviewArgs` — no
   * blanket approve, no prompting — plus a third: the command allowlist it
   * carries must be the one reviewexec.ts decides, not a hand-written variant,
   * or the policy ralphrun documents stops being the policy the cli enforces.
   *
   * Absent = this cli cannot be told which commands it may run, so it stays on
   * `reviewArgs` even when the config asks for execution. Granting it a blanket
   * "run anything" instead would be the opposite of the point.
   */
  reviewExecArgs?: string[];
  /**
   * Server-side advisor: extra args that make THIS cli consult an advisor model
   * mid-task, in one call. Present = the cli supports NATIVE mode. Absent = CROSS.
   */
  nativeAdvisor?: (advisorModel: string) => string[];
  /**
   * "stdin" = this cli reads its prompt from stdin when no prompt argument is
   * given, so buildCmd leaves it out of the argv and the caller pipes it in.
   *
   * That is not a style choice, it is the only way big prompts survive Windows:
   * an npm-installed cli is a `foo.cmd` shim, which cross-spawn must launch
   * through cmd.exe, and cmd.exe truncates a command line at ~8191 chars. Our
   * prompts reach ~17k (executor with standards) and ~25k (review, which embeds
   * a 12k diff). Absent = the prompt goes in the argv and is capped by that.
   *
   * Only set this for a cli where it has actually been observed working.
   */
  promptVia?: "stdin";
  /**
   * Event streaming. Present = this cli can report progress WHILE it works, so
   * the live pane shows real activity; absent = plain buffered text, which for
   * `-p` style CLIs means total silence until the turn ends. Every cli has its
   * own event schema, so only add this with a parser written against a real
   * captured stream (see stream.ts).
   */
  stream?: { args: string[]; parse: (line: string) => StreamEvent | null };
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
    // verified: `echo "<prompt>" | claude -p` answers the piped prompt
    promptVia: "stdin",
    // `claude --help`: `--allowedTools <tools...>` takes a comma or space
    // separated list of tools to allow. It is an ALLOWLIST — Edit/Write/Bash
    // stay out — and under `-p` there is no interactive prompt to hang on:
    // anything off the list is refused, not asked about.
    reviewArgs: ["--allowedTools", "Read,Grep,Glob"],
    // The execution grant, generated from reviewexec.ts so the two cannot drift.
    // `--allowedTools` matches a Bash entry by PREFIX, so `Bash(npm:*)` would
    // cover `npm publish` as well — `--disallowedTools` is what takes those back,
    // and it wins over the allowlist.
    reviewExecArgs: [
      "--allowedTools",
      ["Read", "Grep", "Glob", ...EXEC_ALLOWED_COMMANDS.map((c) => `Bash(${c}:*)`)].join(","),
      "--disallowedTools",
      EXEC_DENIED_COMMANDS.map((c) => `Bash(${c}:*)`).join(","),
    ],
    // verified against `claude --help`: -r/--resume takes a session id and works
    // under -p. The id comes off the stream's own events (see stream.ts).
    resumeArgs: (sessionId) => ["--resume", sessionId],
    buildCmd: ({ bin, prompt, model, autoApprove, reviewArgs, resumeArgs }) => {
      const cmd = [bin, "-p", ...(prompt ? [prompt] : [])];
      if (model) cmd.push("--model", model);
      if (autoApprove) cmd.push("--dangerously-skip-permissions");
      if (resumeArgs) cmd.push(...resumeArgs);
      // last on purpose: the option is variadic, so it must not be followed by
      // a value of its own that it would swallow as another tool name
      if (reviewArgs) cmd.push(...reviewArgs);
      return cmd;
    },
    // verified against a real captured stream; see stream.ts
    stream: { args: ["--output-format", "stream-json", "--verbose"], parse: parseClaudeStream },
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

  cursorsdk: {
    label: "Cursor SDK (in-process)",
    // No binary and no argv: this one is driven through the optional
    // @cursor/sdk package (see cursor-sdk.ts). The `cursor` CLI entry above is
    // unaffected — these are siblings, not a replacement.
    sdk: true,
    defaultModel: "composer-2",
    // SDK model ids are NOT the `cursor:` CLI ids (CLI "cursor-grok-4.5-high"
    // is SDK "grok-4.5"). Only these two have actually been observed working,
    // so the list stays short: a stale/invented id hard-fails EVERY task with
    // "Cannot use this model". Any other id can still be typed via the
    // "custom" picker, and Cursor.models.list() enumerates the real set.
    //
    // The bracket suffix is a variant pin parsed by parseCursorModelSpec. With
    // no params Cursor picks the model's DEFAULT variant, which for grok-4.5 is
    // the FAST tier at ~2x the standard rate.
    models: [
      { value: "composer-2", label: "Composer 2" },
      { value: "grok-4.5[fast=false,effort=high]", label: "Grok 4.5 (standard tier, high effort)" },
    ],
    // All three roles run in-process: executor.ts, advisor.ts and prdChat.ts each
    // branch on `sdk` before they build a command line.
    recommended: {
      planner: "composer-2",
      executor: "composer-2",
      advisor: "grok-4.5[fast=false,effort=high]",
    },
    auth: {
      loginCommand: "export CURSOR_API_KEY=<key from cursor.com/dashboard>",
      // The SDK accepts an API KEY only — a `cursor-agent login` session does
      // NOT work for it. Reading the env var is the whole probe: no import, no
      // network. `bin` is ignored (there isn't one).
      check: () => !!process.env.CURSOR_API_KEY?.trim(),
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
    // verified: `codex exec` with no prompt argument prints
    // "Reading prompt from stdin..." and consumes it
    promptVia: "stdin",
    buildCmd: ({ bin, prompt, model, autoApprove }) => {
      const cmd = [bin, "exec"];
      if (model) cmd.push("-m", model);
      if (autoApprove) cmd.push("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust");
      if (prompt) cmd.push(prompt); // codex takes the prompt LAST, after the flags
      return cmd;
    },
  },

  opencode: {
    label: "opencode CLI",
    bin: "opencode",
    defaultModel: "", // models are "provider/model" and user-configured; "" = opencode's own default
    // `opencode models` — the opencode/* ids are the built-in Zen provider's
    // free tier and opencode-go/* is the OpenCode Go subscription; BOTH need
    // credentials (`/connect` → API key, per https://opencode.ai/docs/providers).
    // Any other provider/model the user has configured can be typed via flags,
    // config, or the "custom" picker.
    models: [
      { value: "opencode/big-pickle", label: "Big Pickle (free)" },
      { value: "opencode/deepseek-v4-flash-free", label: "DeepSeek V4 Flash (free)" },
      { value: "opencode/hy3-free", label: "Hy3 (free)" },
      { value: "opencode/mimo-v2.5-free", label: "MiMo V2.5 (free)" },
      { value: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra (free)" },
      { value: "opencode/north-mini-code-free", label: "North Mini Code (free)" },
      { value: "opencode-go/deepseek-v4-flash", label: "Go · DeepSeek V4 Flash" },
      { value: "opencode-go/deepseek-v4-pro", label: "Go · DeepSeek V4 Pro" },
      { value: "opencode-go/glm-5.1", label: "Go · GLM 5.1" },
      { value: "opencode-go/glm-5.2", label: "Go · GLM 5.2" },
      { value: "opencode-go/grok-4.5", label: "Go · Grok 4.5" },
      { value: "opencode-go/kimi-k2.6", label: "Go · Kimi K2.6" },
      { value: "opencode-go/kimi-k2.7-code", label: "Go · Kimi K2.7 Code" },
      { value: "opencode-go/kimi-k3", label: "Go · Kimi K3" },
      { value: "opencode-go/mimo-v2.5", label: "Go · MiMo V2.5" },
      { value: "opencode-go/mimo-v2.5-pro", label: "Go · MiMo V2.5 Pro" },
      { value: "opencode-go/minimax-m2.7", label: "Go · MiniMax M2.7" },
      { value: "opencode-go/minimax-m3", label: "Go · MiniMax M3" },
      { value: "opencode-go/qwen3.6-plus", label: "Go · Qwen 3.6 Plus" },
      { value: "opencode-go/qwen3.7-max", label: "Go · Qwen 3.7 Max" },
      { value: "opencode-go/qwen3.7-plus", label: "Go · Qwen 3.7 Plus" },
    ],
    // advisor leans on a DIFFERENT model family than the executor — the whole
    // point of the advisor is a second opinion, not an echo.
    recommended: {
      planner: "opencode/big-pickle",
      executor: "opencode/big-pickle",
      advisor: "opencode/nemotron-3-ultra-free",
    },
    buildCmd: ({ bin, prompt, model, autoApprove }) => {
      const cmd = [bin, "run"];
      if (model) cmd.push("--model", model);
      if (autoApprove) cmd.push("--auto");
      cmd.push(prompt); // opencode takes the prompt LAST, after the flags
      return cmd;
    },
    // no auth probe: opencode auth is per-provider (`opencode auth list`),
    // so there is no single reliable headless "logged in" check → "unknown".
  },
} satisfies Record<string, AgentDef>);

// ---------------------------------------------------------------------------
// Agent manifests — a cli as DATA, not code.
//
// Drop `<cli>.json` in <configDir>/agents/ (the same place userconfig.ts keeps
// config.json) and that cli joins the registry: it shows up in the pickers,
// gets a preflight probe and runs. No fork, no rebuild, no republish.
//
// WHERE THE LINE IS. A manifest describes one command-line shape:
//   <bin> <args…> [prompt] [modelFlag <model>] [autoApproveArgs…] [reviewArgs…]
// with the prompt either right after `args`, LAST (promptLast), or piped in
// (promptVia: "stdin"). That covers every built-in above except grok, which
// weaves `--cwd <cwd>` into the middle of its argv.
//
// Everything that is a FUNCTION stays in code, because data cannot express it:
// stream parsers (stream.ts), headless auth probes, nativeAdvisor flags, and
// in-process SDK backends. An exotic cli still gets an entry in AGENTS above —
// that is the escape hatch, not a hole in the format. Rewriting the built-ins
// as manifests would be a migration with no user-visible gain, so they stay.
// ---------------------------------------------------------------------------

/** the declarative subset of an AgentDef: what a user can register from JSON */
export interface AgentManifest {
  label: string;
  bin: string;
  /** model ids offered in the pickers; the picker label is the id itself */
  models: string[];
  /** the flag this cli takes its model on, e.g. "--model" or "-m" */
  modelFlag: string;
  /** fixed args right after the binary: subcommand and always-on flags, e.g. ["agent", "--trust", "-p"] */
  args?: string[];
  /** appended when ralphrun runs unattended, e.g. ["--yolo"] */
  autoApproveArgs?: string[];
  /** READ-ONLY tool grant for the review call — see AgentDef.reviewArgs */
  reviewArgs?: string[];
  /** "" or absent = let the cli pick; anything else must be one of `models` */
  defaultModel?: string;
  /** "stdin" keeps the prompt out of the argv (survives cmd.exe's ~8191 limit) */
  promptVia?: "argv" | "stdin";
  /** true = the prompt is the LAST argv element, after the flags (codex, opencode) */
  promptLast?: boolean;
}

/** a manifest we refused to register, and why */
export interface ManifestRefusal {
  /** the cli id the file WOULD have registered (its filename, minus .json) */
  cli: string;
  file: string;
  reason: string;
}

/** where a user drops <cli>.json to register a cli without forking ralphrun */
export function manifestDir(): string {
  return join(configDir(), "agents");
}

// the id is typed by a human as `--executor <cli>:<model>`, so it may not
// contain the ":" that separator splits on, nor be empty
const MANIFEST_ID = /^[a-z0-9][a-z0-9._-]*$/i;

// the same shapes agents.test.ts refuses on the built-ins: the review runs at
// autoApprove:false on purpose, so a "read-only" grant that switches
// permissions off wholesale hands back exactly what that posture withholds.
// `--yolo` is not an exotic spelling: it is what this README's own manifest
// example puts in autoApproveArgs, so it is the flag a user is most likely to
// paste into reviewArgs by mistake.
const BLANKET_APPROVE = /skip-permissions|bypass|always-approve|dangerous|yolo|full-auto|--force|--auto\b|--yes\b/;

const BUILT_IN = new Set(Object.keys(AGENTS));

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/** first thing wrong with a parsed manifest, naming the field; null = usable */
function manifestProblem(m: Record<string, unknown>): string | null {
  if (typeof m.label !== "string" || !m.label.trim()) return '"label" must be a non-empty string';
  if (typeof m.bin !== "string" || !m.bin.trim()) return '"bin" must be a non-empty string';
  if (!isStringArray(m.models) || m.models.length === 0 || m.models.some((s) => !s.trim()))
    return '"models" must be a non-empty array of non-empty strings';
  if (typeof m.modelFlag !== "string" || !m.modelFlag.trim())
    return '"modelFlag" must be a non-empty string — the flag this cli takes its model on, e.g. "--model"';
  if (m.defaultModel !== undefined && typeof m.defaultModel !== "string") return '"defaultModel" must be a string';
  if (m.defaultModel && !m.models.includes(m.defaultModel as string))
    return '"defaultModel" must be one of "models" (or "" to let the cli choose)';
  for (const k of ["args", "autoApproveArgs", "reviewArgs"] as const)
    if (m[k] !== undefined && !isStringArray(m[k])) return `"${k}" must be an array of strings`;
  if (m.promptVia !== undefined && m.promptVia !== "argv" && m.promptVia !== "stdin")
    return '"promptVia" must be "argv" or "stdin"';
  if (m.promptLast !== undefined && typeof m.promptLast !== "boolean") return '"promptLast" must be a boolean';
  const blanket = (m.reviewArgs as string[] | undefined)?.find((a) => BLANKET_APPROVE.test(a));
  if (blanket) return `"reviewArgs" must not contain the approve-everything flag ${blanket} — a review runs read-only`;
  return null;
}

function compileManifest(m: AgentManifest): AgentDef {
  const defaultModel = m.defaultModel ?? "";
  // a manifest declares no per-role opinion, so every role gets the same pick.
  // It has to be a REAL model or the pickers offer something the cli rejects.
  const pick = defaultModel || m.models[0];
  return {
    label: m.label,
    bin: m.bin,
    defaultModel,
    models: m.models.map((value) => ({ value, label: value })),
    recommended: { planner: pick, executor: pick, advisor: pick },
    ...(m.promptVia === "stdin" ? { promptVia: "stdin" as const } : {}),
    ...(m.reviewArgs ? { reviewArgs: m.reviewArgs } : {}),
    buildCmd: ({ bin, prompt, model, autoApprove, reviewArgs }) => {
      const cmd = [bin, ...(m.args ?? [])];
      // empty prompt = adapters kept it out for a stdin cli; never push "",
      // which most clis read as an empty positional argument and reject
      if (prompt && !m.promptLast) cmd.push(prompt);
      if (model) cmd.push(m.modelFlag, model);
      if (autoApprove) cmd.push(...(m.autoApproveArgs ?? []));
      if (reviewArgs) cmd.push(...reviewArgs);
      if (prompt && m.promptLast) cmd.push(prompt);
      return cmd;
    },
  };
}

/**
 * Read every manifest in `dir`. Untrusted input (BUILD 08 posture): a file that
 * does not validate registers NOTHING and comes back as a refusal naming the
 * file and the field, rather than half-registering a cli that fails at spawn.
 */
export function loadAgentManifests(explicitDir?: string): {
  agents: Record<string, AgentDef>;
  refusals: ManifestRefusal[];
} {
  const agents: Record<string, AgentDef> = Object.create(null) as Record<string, AgentDef>;
  const refusals: ManifestRefusal[] = [];
  let dir: string;
  let files: string[];
  // Resolving the config dir is inside the try on purpose: agents.ts is
  // imported by every layer and this runs at load, so "we cannot locate the
  // config dir" has to degrade to "no manifests", never to a crash on import.
  try {
    dir = explicitDir ?? manifestDir();
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort(); // picker order must not depend on the filesystem's readdir order
  } catch {
    return { agents, refusals }; // no manifest dir at all is the normal case
  }
  for (const f of files) {
    const cli = basename(f, ".json");
    const path = join(dir, f);
    const refuse = (reason: string): void => void refusals.push({ cli, file: path, reason });
    if (!MANIFEST_ID.test(cli)) {
      refuse(`"${cli}" is not a usable cli id — the file name is the id, and it is typed as <cli>:<model>`);
      continue;
    }
    // A manifest may EXTEND the registry, never redefine it. Letting a file in
    // ~/.config silently repoint `claude` at another binary would change what
    // every existing prd.json and config runs, without anything saying so.
    if (BUILT_IN.has(cli)) {
      refuse(`"${cli}" is a built-in cli — a manifest cannot redefine one; rename the file to register a new cli`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      refuse(`invalid JSON: ${(e as Error).message}`);
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      refuse("must be a JSON object");
      continue;
    }
    const problem = manifestProblem(raw as Record<string, unknown>);
    if (problem) refuse(problem);
    else agents[cli] = compileManifest(raw as unknown as AgentManifest);
  }
  return { agents, refusals };
}

const manifests = loadAgentManifests();
Object.assign(AGENTS, manifests.agents);

/** manifests that were REFUSED this process; empty in the normal case */
export const manifestRefusals: readonly ManifestRefusal[] = manifests.refusals;

// Loud on stderr, once, at load: the alternative is a manifest that quietly
// does nothing and a preflight that then blames the user's PATH. This runs
// before setLocale, so it is English like the other thrown-error diagnostics.
for (const r of manifestRefusals) console.error(`ralphrun: ignoring agent manifest ${r.file} — ${r.reason}`);

/** every registered cli, in picker order (built-ins first, then manifests) */
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
