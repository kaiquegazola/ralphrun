# ralphrun

Autonomous build loop — CLI-agnostic executor + advisor. Installable npm CLI.

Inspired by [`snarktank/ralph`](https://github.com/snarktank/ralph). A
TypeScript / Node ESM CLI built with **Commander + Ink** (fullscreen TUI).
UI in English and Português (pt-BR).

- **Fresh context per task** (the ralph reset): each task is a brand-new headless
  session. State lives in `prd.json` — the executor forgets everything between
  tasks.
- **Real file editing**: the coding CLI (`claude` / `grok` / `cursor`) does the
  work.
- **Advisor**: a stronger model steers. Two paths, picked automatically:

| Mode | When | How |
|---|---|---|
| **NATIVE** | executor **and** advisor are both `claude` | one `claude -p ... --advisor <model>`; the advisor tool runs server-side, Claude decides when to consult mid-task and reviews before declaring done. |
| **CROSS** | different CLIs (e.g. `grok`/`cursor` executor + `claude` advisor) | **planner before** → executor → **review-after** loop (`APPROVE` / `CHANGES`, re-run with fixes), up to `max_review_rounds`. |

Both CLIs auth by their own subscription login — **no API keys**.

## Install

```bash
# use without installing
npx ralphrun --help

# or install globally
npm install -g ralphrun
ralphrun --help
```

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
  "heartbeat_secs": 30,
  "commit_per_task": true,
  "stop_on_blocked": false,
  "extra_executor_args": []
}
```

Inspect or edit interactively:

```bash
ralphrun config show        # print resolved config (defaults + file)
ralphrun config edit        # Clack wizard over the key knobs
```

- Flags override the file: `--executor cli:model`, `--advisor cli:model|none`.
- `cli` is `claude`, `grok`, or `cursor`. To add another, extend `buildCmd()` in
  `src/adapters.ts`.
- Model shorthand: `--executor grok` → `grok:grok-4.5`, `--executor claude` →
  `claude:sonnet`. `--executor cursor` (no model) lets Cursor pick its own default.
- Only `claude` + `claude` runs NATIVE (server-side advisor). Any `grok`/`cursor`
  → CROSS.

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

- `claude` — Claude Code >= 2.1.170 (needed for native `--advisor`).
- `grok` — Grok CLI (`x.ai/cli`), browser login. Only if you use a grok executor.
- `cursor` — Cursor CLI (`cursor-agent` via `cursor.com/install`). Router CLI.
  Always CROSS — no native advisor.

Preflight fails fast if a named CLI isn't on PATH, with a clear message instead
of burning every task's retry budget.

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
that stops the loop from lying).

```json
{
  "id": "T2-data-model",
  "title": "Core data model",
  "deps": ["T1-scaffold"],
  "retries": 0,
  "description": "Define the core entities and schema.",
  "acceptance": ["schema/migration files present", "migration runs clean"],
  "verify": "npm run migrate && npm run typecheck"
}
```

## Development

```bash
npm install
npm run build       # tsup -> dist/index.js (ESM)
npm run typecheck    # tsc --noEmit (strict)
npm run dev          # watch rebuild
node dist/index.js --help
```

Layout:

```
src/
  index.ts      # shebang entry
  cli.ts        # Commander program: run (root) + init + config (+ --lang)
  config.ts     # DEFAULTS, parse_agent, load_config (global < project < flags)
  userconfig.ts # per-user global config (sanitize + atomic write)
  i18n.ts       # en + pt-br dicts, typed t()
  prd.ts        # backlog types, recover/normalize, next_task
  adapters.ts   # build_cmd for each CLI (claude/grok/cursor)
  prompts.ts    # executor/advisor prompt templates (always English)
  log.ts        # stdout/reporter + progress.md with timestamps
  git.ts        # git + capture_diff
  executor.ts   # streaming executor + heartbeat + AbortSignal cancel
  advisor.ts    # get_advice + advisor_review (CROSS)
  verify.ts     # objective gate + assembled feedback
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