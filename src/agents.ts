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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import {
  EXEC_ALLOWED_COMMANDS,
  EXEC_DENIED_COMMANDS,
  INDIRECT_PAIRS,
  INDIRECT_PROGRAMS,
  INDIRECT_SUBFORMS,
  INSTALL_VERBS,
  INTERPRETERS,
  INLINE_CODE_FLAGS,
  RELEASE_VERBS,
  RUNNERS,
} from "./reviewexec.js";
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
   * Absent = this cli cannot be told ON THE COMMAND LINE which commands it may
   * run. It may still carry the grant as config (`reviewEnv`, opencode); with
   * neither, it stays on `reviewArgs` even when the config asks for execution.
   * Granting it a blanket "run anything" instead would be the opposite of the
   * point.
   */
  reviewExecArgs?: string[];
  /**
   * The grant for a cli whose permissions are enforced from CONFIG rather than
   * an argv flag. Called with the same grant buildCmd was given ("read" or
   * "exec"); the returned env is merged over process.env for that one spawn
   * only, and `cleanup` runs on EVERY settle path — the grant may carry a temp
   * file the cli reads at startup, and nobody else will remove it. Absent =
   * the cli needs no config to review.
   */
  reviewEnv?(tools: "read" | "exec", cwd: string): { env: Record<string, string>; cleanup(): void };
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

/**
 * Leading runner flags the exec grant tolerates before the program name. The
 * decision skips ANY leading flag (firstVerb), but a glob cannot say "any
 * flag" without also matching `npx -c <shell>` — a shell by another name — so
 * the config grant carries only the auto-confirm switches a reviewer actually
 * writes (`npx -y tsc`) and stays over-blocking on the rest: the failure
 * direction the README prefers.
 */
const RUNNER_CONFIRM_FLAGS = ["-y", "--yes"];

/**
 * opencode's review grant, as a generated config FILE. opencode enforces tool
 * permissions from its config — not argv — and OPENCODE_CONFIG points it at a
 * specific file. A file, not the inline OPENCODE_CONFIG_CONTENT env var: the
 * exec policy is tens of KB of rules, and Windows' CreateProcess environment
 * block dies at 32KB — the review would fail to spawn before reviewing.
 * Rules evaluate last-match-wins in insertion order (opencode's documented
 * contract), so the shape mirrors claude's grant exactly: a fallback deny
 * first, the read tools next, and on an exec review the denied command shapes
 * AFTER the allowed prefixes — that ordering is what makes `npm publish` lose
 * to the `npm*` allow, the same way --disallowedTools beats --allowedTools.
 * The patterns are generated from reviewexec.ts's own lists, so the policy the
 * README documents and the policy opencode enforces cannot drift apart.
 *
 * One fidelity upgrade over the argv grants: `npx`/`bunx`/`uvx` are expanded into
 * `npx <allowed program>*` shapes instead of a bare `npx*` allow, and a
 * hand-off to ANOTHER indirect form (`npx uv run …`, `npx npm exec …`) is
 * denied unless the program under it is allowed too — two levels of the
 * decision function's lookthrough, where the argv grants carry none. The
 * residual is depth three and beyond (`npx pnpm dlx uv run curl`), where the
 * cross product stops being worth its bytes; that is the same
 * prefix-coarseness the claude flags live with at depth one, documented in the
 * README.
 */
function opencodeReviewEnv(tools: "read" | "exec", cwd: string): { env: Record<string, string>; cleanup(): void } {
  const permission: Record<string, unknown> = {
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: tools === "exec" ? execBashRules() : "deny",
    edit: "deny",
    webfetch: "deny",
  };
  // The user's own opencode config — a file they pointed OPENCODE_CONFIG at,
  // or inline JSON in OPENCODE_CONFIG_CONTENT — is merged in as the BASE, with
  // this grant's permission keys moved LAST (delete-then-set: a spread would
  // keep an existing key's position, and a user `{read: "deny"}` sorting after
  // the grant's `read: "allow"` would deny every read). Their providers,
  // agents and MCP servers survive; every key the grant names wins the tie;
  // anything it does not name still falls to the grant's `"*": "deny"`, which
  // now sorts after the user's own rules.
  const base = existingOpencodeConfig(cwd);
  const mergedPermission = permissionWithGrantLast(base, permission);
  // opencode merges PER-AGENT permissions over top-level ones, so the grant
  // locks the default agent (`build`) to the same rules — whichever layer wins
  // the merge, the rules are the grant's. The user's other agent fields (and
  // other agents) survive.
  const locked = withAgentLock({ ...base, permission: mergedPermission }, mergedPermission);
  // The user's own permission rules NEVER ride the inline layer: they can be
  // arbitrarily large, and the grant's keys override them anyway. They live in
  // the file (when one is written) and in the user's own config sources.
  const baseWithoutPermission = { ...base };
  delete baseWithoutPermission.permission;
  if (tools === "read") {
    // A read grant is a few hundred bytes, so it rides INLINE when it fits —
    // and OPENCODE_CONFIG_CONTENT is the LAST config layer opencode loads,
    // after the workspace's own `.opencode/opencode.json`: nothing the
    // workspace ships can loosen a read review's denies.
    const inline = JSON.stringify(withAgentLock({ ...baseWithoutPermission, permission }, permission));
    if (inlineFits(inline)) {
      return { env: { OPENCODE_CONFIG_CONTENT: inline }, cleanup: () => {} };
    }
    // a user config big enough to blow the env rides in a file; CONTENT keeps
    // just the grant — small, and still the final layer
    return writeGrantFile(JSON.stringify(locked), JSON.stringify(withAgentLock({ permission }, permission)));
  }
  // The exec bash rules are tens of KB — past any env block — so the FILE
  // carries the full merged config (bash rules, the agent lock and the user's
  // own permission rules included), and CONTENT carries the grant WITHOUT bash
  // as the final layer — top-level AND on the default agent, so the workspace
  // cannot loosen edit/webfetch even where its agent config outranks the file.
  // Residual, documented in the README: bash on an executing review resolves
  // through the file, which the workspace's own config could loosen.
  const withoutBash = { ...permission };
  delete withoutBash.bash;
  return writeGrantFile(
    JSON.stringify(locked),
    JSON.stringify(withAgentLock({ permission: withoutBash }, withoutBash)),
  );
}

/** Windows' CreateProcess environment block dies at 32KB — the budget below is
 * for the WHOLE environment the child gets, inherited variables included, with
 * margin for the child's own additions */
const INLINE_CONFIG_LIMIT = 20_000;

/** does the inline layer fit in the env block alongside everything inherited? */
export function inlineFits(
  inline: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  let inherited = 0;
  for (const [k, v] of Object.entries(env)) inherited += k.length + (v?.length ?? 0) + 2;
  return inline.length + inherited <= INLINE_CONFIG_LIMIT;
}

/** write the merged config to a temp file; CONTENT carries the small final layer */
function writeGrantFile(full: string, inline: string): { env: Record<string, string>; cleanup(): void } {
  // Atomic enough: a write failure removes the directory it may have created,
  // so a half-written grant never lingers and never reaches a reviewer.
  const dir = mkdtempSync(join(tmpdir(), "ralphrun-opencode-"));
  const config = join(dir, "opencode-review.json");
  try {
    writeFileSync(config, full);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    env: { OPENCODE_CONFIG: config, OPENCODE_CONFIG_CONTENT: inline },
    // the whole directory: mkdtemp made one per grant, and only removing the
    // file would leak it on every review of a long session
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** the same grant, set on the default agent whose per-agent rules outrank top-level ones */
function withAgentLock(config: Record<string, unknown>, permission: Record<string, unknown>): Record<string, unknown> {
  const agent = isRecord(config.agent) ? { ...config.agent } : {};
  const build = isRecord(agent.build) ? { ...agent.build } : {};
  build.permission = permission;
  agent.build = build;
  return { ...config, agent };
}

/** the user's own config, file then inline — later sources win, matching opencode's own order */
function existingOpencodeConfig(cwd: string): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  const sources: string[] = [];
  // a relative OPENCODE_CONFIG is relative to the REVIEWER's cwd (the
  // workspace), not to ralphrun's — resolve before reading, and pass the
  // ABSOLUTE path back so the child, whose cwd IS the workspace, reads the
  // same file this merged
  if (process.env.OPENCODE_CONFIG) {
    const configured = process.env.OPENCODE_CONFIG;
    sources.push(readFileSyncSafe(isAbsolute(configured) ? configured : join(cwd, configured)));
  }
  if (process.env.OPENCODE_CONFIG_CONTENT?.trim()) sources.push(process.env.OPENCODE_CONFIG_CONTENT);
  for (const source of sources) {
    try {
      const parsed: unknown = parseJsonOrJsonc(source);
      // a non-object carries no mergeable config, so it is skipped, not inherited
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        mergeDeepInto(base, parsed as Record<string, unknown>);
      }
    } catch {
      // unparseable even as JSONC: skipped rather than inherited
    }
  }
  return base;
}

/** deep merge for plain-object values — a shallow assign drops the user's
 * nested `mcp`/`provider` entries the moment both sources name the section */
function mergeDeepInto(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const into = dst[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      into && typeof into === "object" && !Array.isArray(into)
    ) {
      mergeDeepInto(into as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      dst[k] = v;
    }
  }
}

/** JSON.parse, falling back to a JSONC strip — opencode configs are commonly JSONC */
function parseJsonOrJsonc(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return JSON.parse(stripJsonc(source));
  }
}

/**
 * JSONC → JSON: comments and trailing commas, string-aware so a `"url":
 * "https://…"` survives its `//`. Malformed input still throws — the caller
 * skips it rather than inheriting half of something.
 */
function stripJsonc(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === ",") {
      // the next SIGNIFICANT character decides: whitespace AND comments do
      // not count, or `, /* x */ }` would keep its dangling comma
      let j = i + 1;
      for (;;) {
        while (j < source.length && /\s/.test(source[j])) j++;
        if (source[j] === "/" && source[j + 1] === "/") {
          while (j < source.length && source[j] !== "\n") j++;
          continue;
        }
        if (source[j] === "/" && source[j + 1] === "*") {
          j += 2;
          while (j < source.length && !(source[j] === "*" && source[j + 1] === "/")) j++;
          j += 2; // past the closing slash — the main loop's for(++) covers this there
          continue;
        }
        break;
      }
      if (source[j] === "}" || source[j] === "]") continue; // trailing comma: drop
    }
    out += ch;
  }
  return out;
}

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return ""; // unreadable: the same skip an unparseable file gets
  }
}

/** the grant's permission keys, moved to the END of the user's ordering */
function permissionWithGrantLast(
  base: Record<string, unknown>,
  grant: Record<string, unknown>,
): Record<string, unknown> {
  const userPermission = base.permission;
  const merged: Record<string, unknown> =
    userPermission && typeof userPermission === "object" && !Array.isArray(userPermission)
      ? { ...(userPermission as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(grant)) {
    delete merged[k]; // drop the user's position, then append: the grant sorts last
    merged[k] = v;
  }
  return merged;
}

/**
 * The exec bash rules. opencode resolves them last-match-wins, so the ORDER is
 * the enforcement and every phase must sit over the one before it:
 *
 *   1. the fallback deny
 *   2. depth-1 allows — EXACT-TOKEN shapes (`node`, `node *`), because a
 *      prefix like `node*` also admits `nodejs -e` and `node_modules/.bin/x`,
 *      binaries the decision refuses by name; an indirect runner is expanded
 *      into `npx <allowed program>` for the same reason
 *   3. hand-off denies — a runner, reached directly or through an indirect
 *      program, may not hand off to ANOTHER indirect form (`uv run curl`,
 *      `npx uv run curl`: both match the broad runner allows above, and the
 *      decision looks through both to refuse curl)
 *   4. the hand-offs re-open for an ALLOWED program only (`uv run prettier`)
 *   5. the denied command shapes ride over every expansion — `npm publish`
 *      loses to `npm *` exactly like --disallowedTools beats --allowedTools,
 *      and `pnpm exec npm publish` loses to `pnpm exec npm *`
 *   6. the shell-metacharacter refusals over everything — the decision refuses
 *      any command carrying one (`npm test; git push` is not the command it
 *      claims to be), and these globs match the whole line, so without them a
 *      chain would ride in on a leading allow
 *
 * Every pattern is generated from reviewexec.ts's own lists, so the policy the
 * README documents and the policy opencode enforces cannot drift apart. The
 * boundary is exact by construction: exactly ONE hand-off, and never into
 * another runner — `npm exec npx vitest` is denied even though the decision
 * allows it, an over-block the README documents rather than a recursion with
 * no bottom.
 */
function execBashRules(): Record<string, string> {
  const rules: Record<string, string> = { "*": "deny" };
  // exact-token shape: the bare program, and the program with arguments
  const withArgs = (cmd: string): string[] => [cmd, `${cmd} *`];
  // 2. depth-1 allows
  for (const c of EXEC_ALLOWED_COMMANDS) {
    if (INDIRECT_PROGRAMS.includes(c)) {
      for (const a of EXEC_ALLOWED_COMMANDS) {
        for (const shape of withArgs(`${c} ${a}`)) rules[shape] = "allow";
        for (const f of RUNNER_CONFIRM_FLAGS) {
          for (const shape of withArgs(`${c} ${f} ${a}`)) rules[shape] = "allow";
        }
      }
    } else {
      for (const shape of withArgs(c)) rules[shape] = "allow";
    }
  }
  // 3. hand-off denies, at the top level and under an indirect program (bare
  // or behind a confirm flag — `npx -y uv run curl` must not ride `npx -y uv *`).
  // The TOP level denies only the two-token PAIRS: a bare `npx vitest` is the
  // depth-1 expansion above, not a hand-off — a `npx*` deny here would sit
  // after those allows and, last-match-wins, silence every one of them.
  const flagCtxs = ["", ...RUNNER_CONFIRM_FLAGS.map((f) => `${f} `)];
  for (const sub of INDIRECT_PAIRS) rules[`${sub}*`] = "deny";
  for (const p of INDIRECT_PROGRAMS) {
    for (const ctx of flagCtxs) {
      for (const sub of INDIRECT_SUBFORMS) rules[`${p} ${ctx}${sub}*`] = "deny";
    }
  }
  // 4. the hand-offs re-open for an allowed program, top level only — and
  // NEVER into another runner: a hand-off under a hand-off (`npm exec npx
  // vitest`) stays denied, which over-blocks a shape no reviewer writes in
  // exchange for a boundary that is exact instead of bottomless
  for (const sub of INDIRECT_PAIRS) {
    for (const a of EXEC_ALLOWED_COMMANDS) {
      if (INDIRECT_PROGRAMS.includes(a)) continue;
      for (const shape of withArgs(`${sub} ${a}`)) rules[shape] = "allow";
    }
  }
  // 5. the denied command shapes, over every expansion — exact, plus a
  // flag-cluster form: the decision scans every non-flag word, so
  // `npm --access public publish` is a publish and `npm publish` alone would
  // let it ride the broad `npm *` allow. The config has no argv ceiling, so
  // the denied set is the FULL policy — every install verb, every interpreter
  // inline flag — not the CLI-sized subset the claude flags had to shrink to.
  const denied = new Set(EXEC_DENIED_COMMANDS);
  for (const r of RUNNERS) {
    for (const v of [...RELEASE_VERBS, ...INSTALL_VERBS, "i"]) denied.add(`${r} ${v}`);
  }
  for (const i of INTERPRETERS) {
    for (const f of INLINE_CODE_FLAGS) denied.add(`${i} ${f}`);
  }
  for (const d of denied) {
    // the bare prefix too: `node --eval=code` is an inline code the exact and
    // with-args shapes would miss
    rules[`${d}*`] = "deny";
    for (const shape of withArgs(d)) rules[shape] = "deny";
    for (const p of INDIRECT_PROGRAMS) {
      for (const shape of withArgs(`${p} ${d}`)) rules[shape] = "deny";
      for (const f of RUNNER_CONFIRM_FLAGS) {
        for (const shape of withArgs(`${p} ${f} ${d}`)) rules[shape] = "deny";
      }
    }
    for (const sub of INDIRECT_SUBFORMS) rules[`${sub} ${d}*`] = "deny";
    // the flag-cluster form needs a clean runner-verb pair (`npm i -g` has a
    // trailing flag of its own, and its exact shapes above already cover it)
    const parts = d.split(" ");
    if (parts.length !== 2) continue;
    const [runner, verb] = parts;
    rules[`${runner} -* ${verb}*`] = "deny";
    for (const p of INDIRECT_PROGRAMS) {
      rules[`${p} ${runner} -* ${verb}*`] = "deny";
      for (const f of RUNNER_CONFIRM_FLAGS) rules[`${p} ${f} ${runner} -* ${verb}*`] = "deny";
    }
    for (const sub of INDIRECT_SUBFORMS) rules[`${sub} ${runner} -* ${verb}*`] = "deny";
  }
  // 5.5 a `run` script is judged by its NAME: `npm run publish` is a publish,
  // because the decision checks whether the script name CONTAINS a release
  // verb — the same contains, as a glob with room on both sides, behind a
  // flag cluster too (`npm --silent run publish`)
  for (const r of RUNNERS) {
    for (const ctx of [
      "",
      ...INDIRECT_PROGRAMS.map((p) => `${p} `),
      ...INDIRECT_PROGRAMS.flatMap((p) => RUNNER_CONFIRM_FLAGS.map((f) => `${p} ${f} `)),
      ...INDIRECT_SUBFORMS.map((s) => `${s} `),
    ]) {
      for (const v of RELEASE_VERBS) {
        rules[`${ctx}${r} run *${v}*`] = "deny";
        rules[`${ctx}${r} -* run *${v}*`] = "deny";
      }
    }
  }
  // 6. metacharacters over everything
  for (const meta of [";", "&", "|", "<", ">", "`", "$", "\n", "\r"]) rules[`*${meta}*`] = "deny";
  return rules;
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
      { value: "Gemini 3.7 Flash (High)", label: "Gemini 3.7 Flash (High)" },
      { value: "Gemini 3.7 Flash (Medium)", label: "Gemini 3.7 Flash (Medium)" },
      { value: "Gemini 3.7 Flash (Low)", label: "Gemini 3.7 Flash (Low)" },
      { value: "Gemini 3.6 Flash (High)", label: "Gemini 3.6 Flash (High)" },
      { value: "Gemini 3.6 Flash (Medium)", label: "Gemini 3.6 Flash (Medium)" },
      { value: "Gemini 3.6 Flash (Low)", label: "Gemini 3.6 Flash (Low)" },
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
    // `agy models` is the whole probe and SAFE to run headless, unlike `-p`:
    // signed out it fails FAST with exit 1 ("Please sign in to view available
    // models"), while an unauthenticated `-p` enters the interactive OAuth
    // wait and would hang the preflight for its full 60s.
    auth: {
      loginCommand: "agy",
      check: (bin) => {
        execSync(`${bin} models`, { stdio: "ignore" }); // exit 0 = signed in, throws otherwise
        return true;
      },
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
    buildCmd: ({ bin, prompt, model, autoApprove, reviewArgs }) => {
      const cmd = [bin, "-p", ...(prompt ? [prompt] : [])];
      if (model) cmd.push("--model", model);
      if (autoApprove) cmd.push("--dangerously-skip-permissions");
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
    defaultModel: "grok-4.6",
    // `grok models` while signed out — grok-4.6 is the server-side default,
    // grok-4.5 stays listed because the cli still accepts it.
    models: [
      { value: "grok-4.6", label: "grok-4.6" },
      { value: "grok-4.5", label: "grok-4.5" },
    ],
    recommended: { planner: "grok-4.6", executor: "grok-4.6", advisor: "grok-4.6" },
    buildCmd: ({ bin, prompt, model, cwd, autoApprove }) => {
      const cmd = [bin, "-p", prompt, "--cwd", cwd];
      if (model) cmd.push("-m", model);
      if (autoApprove) cmd.push("--always-approve");
      return cmd;
    },
    // `grok models` exits 0 whether or not you are signed in — the marker line
    // is the answer ("You are not authenticated."). Same shape as cursor.
    auth: {
      loginCommand: "grok login",
      check: (bin) => {
        const out = execSync(`${bin} models`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return !out.includes("not authenticated");
      },
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
    // verified against cursor's docs: plan mode is the CLI's read-only posture
    // ("planning, read-only behavior" — the same mode the cursorsdk backend
    // already reviews in), and `--plan` is its documented shorthand. It stays
    // on the exec request too: cursor has no per-command allowlist on argv, so
    // the wider grant would be a blanket one.
    reviewArgs: ["--plan"],
    buildCmd: ({ bin, prompt, model, autoApprove, reviewArgs }) => {
      const cmd = [bin, "agent", "--trust"];
      if (model) cmd.push("--model", model);
      if (autoApprove) cmd.push("--force");
      // every flag BEFORE `-p`: its prompt is the print mode's payload, and a
      // flag landing after that text is a flag the cli never parses
      if (reviewArgs) cmd.push(...reviewArgs);
      cmd.push("-p", prompt);
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
    // probed against a ChatGPT-account login on 2026-08: gpt-5.6-lua and
    // gpt-4.5-preview are rejected outright ("not supported when using Codex
    // with a ChatGPT account"), so only ids that answered stay listed — same
    // posture as cursor above, a stale id hard-fails every task.
    models: [
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { value: "gpt-5.5", label: "GPT-5.5" },
    ],
    recommended: { planner: "gpt-5.6-sol", executor: "gpt-5.6-sol", advisor: "gpt-5.6-sol" },
    // verified: `codex exec` with no prompt argument prints
    // "Reading prompt from stdin..." and consumes it
    promptVia: "stdin",
    // verified against codex's own CLI source: `codex exec` runs headless with
    // approval_policy Never (it cannot prompt), and `--sandbox read-only` is
    // codex's named mode for exactly this posture — reads and read-only shell
    // permitted, every write refused. It stays on the exec request too: codex
    // has no per-command allowlist, so the wider grant would be a blanket one.
    reviewArgs: ["--sandbox", "read-only"],
    buildCmd: ({ bin, prompt, model, autoApprove, reviewArgs }) => {
      const cmd = [bin, "exec"];
      if (model) cmd.push("-m", model);
      if (autoApprove) cmd.push("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust");
      if (reviewArgs) cmd.push(...reviewArgs);
      if (prompt) cmd.push(prompt); // codex takes the prompt LAST, after the flags
      return cmd;
    },
    // `codex login status` is the whole probe: exit 0 = "Logged in", exit 1 =
    // "Not logged in". No output parsing needed.
    auth: {
      loginCommand: "codex login",
      check: (bin) => {
        execSync(`${bin} login status`, { stdio: "ignore" }); // exit 0 = logged in, throws otherwise
        return true;
      },
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
    // Synced against `opencode models` on 2026-08-26. These ids CHURN: the Zen
    // and Go catalogues gain and retire models between releases, and a retired
    // id is not a soft failure — the server answers an unknown model with
    // "UnknownError: Unexpected server error", which reads like an outage
    // rather than a typo. `opencode-go/ox-alpha-free` was exactly that: a
    // stealth alias that shipped as `opencode-go/glm-5.3-flash`, taking every
    // run configured against it down with it.
    models: [
      { value: "opencode/big-pickle", label: "Big Pickle (free)" },
      { value: "opencode/hy3-free", label: "Hy3 (free)" },
      { value: "opencode/mimo-v2.5-free", label: "MiMo V2.5 (free)" },
      { value: "opencode/muse-spark-1.2-contributor-free", label: "Muse Spark 1.2 Contributor (free)" },
      { value: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra (free)" },
      { value: "opencode/nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning (free)" },
      { value: "opencode-go/deepseek-v4-flash", label: "Go · DeepSeek V4 Flash" },
      { value: "opencode-go/deepseek-v4-flash-vision-exp", label: "Go · DeepSeek V4 Flash Vision (exp)" },
      { value: "opencode-go/deepseek-v4-pro", label: "Go · DeepSeek V4 Pro" },
      { value: "opencode-go/glm-5.1", label: "Go · GLM 5.1" },
      { value: "opencode-go/glm-5.2", label: "Go · GLM 5.2" },
      { value: "opencode-go/glm-5.3", label: "Go · GLM 5.3" },
      { value: "opencode-go/glm-5.3-flash", label: "Go · GLM 5.3 Flash" },
      { value: "opencode-go/gpt-5.6-luna", label: "Go · GPT-5.6 Luna" },
      { value: "opencode-go/grok-4.6", label: "Go · Grok 4.6" },
      { value: "opencode-go/hy3", label: "Go · Hy3" },
      { value: "opencode-go/kimi-k2.6", label: "Go · Kimi K2.6" },
      { value: "opencode-go/kimi-k2.7-code", label: "Go · Kimi K2.7 Code" },
      { value: "opencode-go/kimi-k3", label: "Go · Kimi K3" },
      { value: "opencode-go/longcat-2.0", label: "Go · LongCat 2.0" },
      { value: "opencode-go/mimo-v2.5", label: "Go · MiMo V2.5" },
      { value: "opencode-go/mimo-v2.5-pro", label: "Go · MiMo V2.5 Pro" },
      { value: "opencode-go/minimax-m2.7", label: "Go · MiniMax M2.7" },
      { value: "opencode-go/minimax-m3", label: "Go · MiniMax M3" },
      { value: "opencode-go/muse-spark-1.2-contributor", label: "Go · Muse Spark 1.2 Contributor" },
      { value: "opencode-go/qwen3.6-plus", label: "Go · Qwen 3.6 Plus" },
      { value: "opencode-go/qwen3.7-max", label: "Go · Qwen 3.7 Max" },
      { value: "opencode-go/qwen3.7-plus", label: "Go · Qwen 3.7 Plus" },
      { value: "opencode-go/qwen3.8-max", label: "Go · Qwen 3.8 Max" },
    ],
    // advisor leans on a DIFFERENT model family than the executor — the whole
    // point of the advisor is a second opinion, not an echo.
    recommended: {
      planner: "opencode/big-pickle",
      executor: "opencode/big-pickle",
      advisor: "opencode/nemotron-3-ultra-free",
    },
    // verified: `echo "<prompt>" | opencode run --model <m>` answers the piped
    // prompt with no positional message at all.
    //
    // Load-bearing on Windows, not a preference. Every cli installed through
    // npm lands on PATH as a `.cmd` shim, so cross-spawn routes it through
    // cmd.exe and its ~8191 char command line — and an executor prompt carrying
    // a task plus accumulated reviewer feedback passes that on the FIRST
    // attempt, not eventually. cmd.exe refuses the whole command before
    // opencode exists, which surfaces as `exit=1 (0s)` with no output: the run
    // then burns its entire review budget re-reviewing a diff that no executor
    // was ever able to produce.
    promptVia: "stdin",
    buildCmd: ({ bin, prompt, model, autoApprove }) => {
      const cmd = [bin, "run"];
      if (model) cmd.push("--model", model);
      if (autoApprove) cmd.push("--auto");
      // UNREACHABLE while promptVia is "stdin": adapters.ts forces the argv
      // prompt to "" one frame up, so this branch never runs. Kept identical to
      // codex's guard so the two stdin adapters read the same, and so that
      // turning promptVia off here needs no other edit.
      if (prompt) cmd.push(prompt); // opencode takes the prompt LAST, after the flags
      return cmd;
    },
    // The grant rides in env, not argv (see reviewEnv): opencode has no
    // read-only flag on the command line — `--auto` is a blanket approve, which
    // is the one thing a review call must never carry.
    reviewEnv: opencodeReviewEnv,
    // `opencode auth list` exits 0 either way — the configured-credential count
    // is the answer. Auth IS per-provider, but any one credential means the cli
    // can run something; a provider-specific gap surfaces as the model's own
    // runtime error, which is no worse than the old "unknown" posture offered.
    auth: {
      loginCommand: "opencode auth login",
      check: (bin) => {
        const out = execSync(`${bin} auth list`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const m = out.match(/(\d+) credentials/);
        return !!m && Number(m[1]) > 0;
      },
    },
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
