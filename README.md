# ralphrun

Autonomous build loop — CLI-agnostic executor + advisor. Installable npm CLI.

Inspired by [`snarktank/ralph`](https://github.com/snarktank/ralph). A
TypeScript / Node ESM CLI built with **Commander + Ink** (fullscreen TUI).
UI in English and Português (pt-BR).

- **Fresh context per task** (the ralph reset): each task is a brand-new headless
  session. State lives in `prd.json` — the executor forgets everything between
  tasks.
- **Real file editing**: the coding CLI (`claude` / `grok` / `cursor` / `codex` /
  `agy` / `opencode`) does the work.
- **Advisor**: a stronger model steers. Two paths, picked automatically:

| Mode | When | How |
|---|---|---|
| **NATIVE** | executor **and** advisor are both `claude` | one `claude -p ... --advisor <model>`; the advisor tool runs server-side, Claude decides when to consult mid-task and reviews before declaring done. |
| **CROSS** | different CLIs (e.g. `grok`/`cursor` executor + `claude` advisor) | **planner before** → executor → **review-after** loop (`APPROVE` / `CHANGES`, re-run with fixes), up to `max_review_rounds`. |

Both CLIs auth by their own subscription login — **no API keys**.

## Install

```bash
# use without installing
npx @kaiquegazola/ralphrun --help

# or install globally
npm install -g @kaiquegazola/ralphrun
ralphrun --help
```

Published as [`@kaiquegazola/ralphrun`](https://www.npmjs.com/package/@kaiquegazola/ralphrun); the CLI binary is `ralphrun`.

Requires Node >= 20.

## Files

| File | Role |
|---|---|
| `prd.json` | The backlog — tasks with `deps`, `acceptance`, `verify` command. **The memory.** |
| `ralph.config.json` | Executor + advisor (`cli:model`), limits, timeouts. Auto-loaded next to the PRD. |
| `progress.md` | Append-only run log (auto-created next to the PRD) with `[HH:MM:SS]` timestamps. |
| `CLAUDE.md` / `AGENTS.md` | Project standards, injected into BOTH executor and advisor prompts. |

## Quick start

```bash
# 1) fullscreen setup wizard + PRD Studio: pick CLIs/models, then draft the
#    backlog by CHATTING with the planner (attach requirement docs with '@')
ralphrun init

# 2) run the loop (fullscreen dashboard on a TTY; plain log when piped)
ralphrun --prd ./prd.json
tail -f progress.md
```

`ralphrun init` opens a single fullscreen app: agent preflight → CLI/model
selection → the **PRD Studio**, a chat with the planner that drafts and refines
`prd.json` in memory (numbered tasks, `@` file attach, undo, validation gate —
nothing touches disk until you press `f` to finalize).

## Run

```bash
# NATIVE: claude:sonnet executor + claude:fable advisor (default)
ralphrun --prd ./prd.json

# CROSS: grok executor, claude:fable advisor
ralphrun --prd ./prd.json --executor grok:grok-4.5

# no advisor
ralphrun --prd ./prd.json --advisor none

# inspect routing without running anything
ralphrun --prd ./prd.json --executor grok:grok-4.5 --dry-run
#  -> mode: CROSS | executor grok:grok-4.5 | advisor claude:fable

# run a single task / build elsewhere
ralphrun --prd ./prd.json --workspace ~/proj/src --task T2-data-model

# disable the review-after loop (on by default in CROSS mode)
ralphrun --prd ./prd.json --no-review-after
```

Long runs (survive closing the terminal):

```bash
cd ~/my-project
nohup ralphrun --prd ./prd.json > ralph.out 2>&1 &
tail -f ralph.out
```

## Config (`ralph.config.json`)

```json
{
  "executor": { "cli": "claude", "model": "sonnet" },
  "advisor":  { "cli": "claude", "model": "fable" },
  "task_timeout": 1800,
  "advisor_timeout": 300,
  "max_retries_per_task": 3,
  "review_after": true,
  "max_review_rounds": 3,
  "max_stalled_review_rounds": 2,
  "heartbeat_secs": 30,
  "stream_output": true,
  "commit_per_task": true,
  "stop_on_blocked": false,
  "extra_executor_args": []
}
```

- `stream_output` turns on the executor CLI's own event stream, so the live pane
  shows tool calls and answers **as they happen**. Without it a `-p` style CLI
  buffers everything and delivers it in one chunk when the turn ends — measured
  at 25s of total silence for a 25s task. Only applied to CLIs with a verified
  event parser (today: `claude`); the rest ignore it. The advisor never streams,
  because its stdout *is* its verdict.

There is deliberately **no** idle timeout. A silence-based kill sounds obvious
but measurement says otherwise: a buffered CLI is silent for the entire task, and
even a streaming one goes quiet while a tool runs — a 40s foreground command
produced a 25.9s gap with no events at all, and that gap grows with the command.
Any value small enough to catch a wedged run is small enough to kill a healthy
test suite, so only `task_timeout` bounds a task.

Inspect or edit interactively:

```bash
ralphrun config show        # print resolved config (defaults + file)
ralphrun config edit        # Clack wizard over the key knobs
```

- Flags override the file: `--executor cli:model`, `--advisor cli:model|none`.
- `cli` is `claude`, `grok`, `cursor`, `codex`, `agy`, or `opencode`. **To add
  another, add one entry to `AGENTS` in `src/agents.ts`** — the registry is the
  single source of truth, and the adapters, preflight, pickers and NATIVE/CROSS
  routing all derive from it.
- Model shorthand: `--executor grok` → `grok:grok-4.5`, `--executor claude` →
  `claude:sonnet`. `--executor cursor` / `codex` / `agy` / `opencode` (no model)
  lets that CLI pick its own default.
- Model names with spaces need quoting in the shell:
  `--executor "agy:Gemini 3.1 Pro (High)"`.
- NATIVE (server-side advisor) requires the same CLI on both sides *and* a CLI that
  supports it — today only `claude` + `claude`. Everything else → CROSS.

## Global config

Preferences (UI language, default planner/executor/advisor, loop knobs) are
saved per user and prefill the init wizard. Layering: defaults < global config
< project `ralph.config.json` < CLI flags.

- macOS/Linux: `$XDG_CONFIG_HOME/ralphrun/config.json` (default `~/.config/ralphrun/config.json`)
- Windows: `%APPDATA%\ralphrun\config.json`

```bash
ralphrun config show --global    # print the global config path + contents
ralphrun config reset --global   # delete it (the language screen shows again on next init)
ralphrun --lang pt-br            # force the UI language for one run (not saved)
```

## Requirements

The CLIs you name must be installed and logged in:

- `claude` — Claude Code >= 2.1.170 (needed for native `--advisor`). The only CLI
  with a NATIVE advisor today.
- `grok` — Grok CLI (`x.ai/cli`), browser login.
- `cursor` — Cursor CLI (`cursor-agent` via `cursor.com/install`). Router CLI.
- `codex` — Codex CLI (`codex exec`).
- `agy` — Antigravity CLI. Model names contain spaces — quote them
  (`--advisor "agy:Claude Opus 4.6 (Thinking)"`).
- `opencode` — opencode CLI (`opencode run`). Models are `provider/model`
  (`--executor opencode:opencode/big-pickle`); no model = its configured default.
  Auth is per-provider, so login is reported "unknown" like grok/agy/codex.

Preflight fails fast if a named CLI isn't on PATH, with a clear message instead
of burning every task's retry budget. Login is only *verified* for `claude` and
`cursor` — the others have no reliable headless auth probe, so they report
"unknown" and are never blocked on it.

## Browser validation (optional)

For UI tasks, a `verify` gate can drive a real browser via
[`dev-browser`](https://github.com/SawyerHood/dev-browser) — a Playwright-backed
CLI that runs a JS script from stdin and exits non-zero when it throws:

```json
"verify": "npm run build && dev-browser --headless < e2e/login.mjs"
```

It's **not bundled** (Playwright + Chromium is ~300MB, and a bundled dep wouldn't
be on the PATH where a `verify` shell command resolves it). It's an external tool
you install once, like the coding CLIs:

```bash
npm i -g dev-browser && dev-browser install   # installs Playwright + Chromium
npm update -g dev-browser                      # it does NOT self-update — refresh manually
```

How it wires up, with zero extra config:

- A task **opts in** simply by naming `dev-browser` in its `verify` command —
  that's the only switch. The planner emits these for UI tasks (never for
  backend/lib/config).
- The executor prompt then gets a short guide pointing at `dev-browser --help`
  (the binary's own always-current API docs — nothing is vendored, so nothing
  rots). Works for every executor CLI, not just `claude`.
- Preflight fails fast with the install command if any task needs `dev-browser`
  and it's missing, and logs a one-line update reminder when it's present.

## Permissions

The executor runs with auto-approve (`--dangerously-skip-permissions` /
`--always-approve` / `--force`) — writes files and runs commands with no prompts.
**Not sandboxed.** Run in a throwaway dir or a VM/container. The advisor call
runs *without* auto-approve (guidance text only).

## Live feedback

On a TTY the run loop mounts a fullscreen Ink dashboard: task sidebar with
overall progress, the current task's subphase (advising → executing →
verifying → reviewing → fixing), review round / attempt counters, gate results,
elapsed-vs-timeout — with `[p]ause` (no confirm), `[s]kip` and `[q]uit` (both
confirmed; skip kills the running executor and moves on). Piped/CI runs fall
back to plain log lines.

Everything is also appended to `progress.md` with an `[HH:MM:SS]` timestamp
(the durable log — English, stable format).

- **Live executor stream**: the executor CLI's output is echoed line-by-line as
  it runs (`  T1› …`), not buffered until the task ends.
- **Heartbeat**: during silence, a `…working (Ns)` pulse every `heartbeat_secs`
  (default 30).
- **Durations**: each executor run and each task log elapsed seconds
  (`DONE T1 (142s)`).
- **Fix-loop verdicts**: `round N → PASS` / `round N → fixing (exec_ok=… tests_ok=… approved=…)`.

## Robustness

- **Crash recovery**: on startup, any task stuck in `doing` (killed mid-run) is
  reset to `todo`, and hand-written backlogs get missing fields filled
  (`status` / `retries` / `deps` / `acceptance`). Re-running always resumes.
- **Git isolation**: the workspace gets its own `.git`, so commits/diffs never
  leak into a parent repo (auto-initialized when `commit_per_task` or
  `review_after` is on).

> **Workspace default is the current directory.** Run ralphrun from inside your
> project dir (or pass `--workspace`), *not* from the tool dir.

## The one rule that makes or breaks it

Fresh context = the executor forgets everything between tasks. All durable state
must live in `prd.json`, especially `architecture_notes`. Anything not written
there gets reinvented next task. Keep those notes short and load-bearing.

## Writing the backlog

Each task needs `id`, `deps`, `description`, `acceptance`, and `verify` — a
shell command that exits 0 only when the task is truly done (the objective gate
that stops the loop from lying). `verify` should be a stack-aware quality gate:
for typed/tested projects, include the relevant static check plus focused tests,
and add build or integration tests when the task changes integration surface.

```json
{
  "id": "T2-data-model",
  "title": "Core data model",
  "deps": ["T1-scaffold"],
  "retries": 0,
  "description": "Define the core entities and schema.",
  "acceptance": ["schema/migration files present", "migration runs clean"],
  "verify": "npm run typecheck && npm run test -- tests/data-model.test.ts && npm run migrate"
}
```

## Development

```bash
npm install
npm run build       # tsup -> dist/index.js (ESM)
npm run typecheck    # tsc --noEmit (strict)
npm run dev          # watch rebuild
npm test             # vitest
npm run test:winpaths # same suite, with Windows path semantics, on any OS
node dist/index.js --help
```

`test:winpaths` aliases `node:path` to its win32 flavour, so `join`, `resolve`,
`relative` and `sep` behave as they do on Windows. Every path bug this project
has hit lived there, and this turns a CI round trip into a two-second check. It
does **not** simulate the filesystem (case-insensitivity, drive letters, UNC) or
process spawning — the `windows-latest` job in CI stays the source of truth.

Layout:

```
src/
  index.ts      # shebang entry
  cli.ts        # Commander program: run (root) + init + config (+ --lang)
  config.ts     # DEFAULTS, parse_agent, load_config (global < project < flags)
  userconfig.ts # per-user global config (sanitize + atomic write)
  i18n.ts       # en + pt-br dicts, typed t()
  prd.ts        # backlog types, recover/normalize, next_task
  agents.ts     # THE agent registry: one entry per CLI (bin, models, buildCmd,
                #   auth probe, native-advisor capability). Add a CLI here, only here.
  adapters.ts   # build_cmd — thin seam over the registry
  prompts.ts    # executor/advisor prompt templates (always English)
  log.ts        # stdout/reporter + progress.md with timestamps
  git.ts        # git + capture_diff
  executor.ts   # streaming executor + heartbeat + AbortSignal cancel
  advisor.ts    # get_advice + advisor_review (CROSS)
  verify.ts     # objective gate + assembled feedback
  browser.ts    # dev-browser validation tool: opt-in detection + prompt guide
  run.ts        # NATIVE vs CROSS per task
  loop.ts       # main loop: recover, preflight, route, run, retry, commit
  wizard.ts     # ralphrun init glue (non-TTY fallback + finalize writes)
  configcmd.ts  # ralphrun config show/edit (+ --global show/reset)
  picker.ts     # fuzzy file search ('@' picker) + attachment reader
  diagnostics.ts# CLI installed/logged-in preflight
  tui/
    fullscreen.ts        # alt-screen + alternate-scroll escape codes
    events.ts            # structured run events bus
    controller.ts        # run-loop dashboard reducer (pure)
    App.tsx / mount.ts   # run-loop Ink dashboard (view)
    wizard/              # fullscreen init app: screens state machine + view
    prd/                 # PRD Studio: controller, planner chat, validator,
                         #   markdown-lite renderer, view
```

Tests: vitest, 100% line/branch/function coverage enforced on all non-view code
(`npm run test:cov`). Ink view components are excluded by design.

## License

MIT.
