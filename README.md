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
| **NATIVE** | executor **and** advisor are both `claude` | one `claude -p ... --advisor <model>`; the advisor tool runs server-side, Claude decides when to consult mid-task and reviews before declaring done. No ralphrun-side review call, so no review round counters and no `## Learned during runs` notes. |
| **CROSS** | different CLIs (e.g. `grok`/`cursor` executor + `claude` advisor) | **planner before** → executor → **review-after** loop (`APPROVE` / `CHANGES`, re-run with fixes), up to `max_review_rounds`. |

Every CLI authenticates with its own subscription login — **no API keys**. The
one exception is the optional in-process `cursorsdk` backend, which takes a
`CURSOR_API_KEY` and nothing else (see [below](#cursorsdk--cursor-in-process-optional)).

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
| `prd.json` | The backlog — tasks with `deps`, `acceptance`, `scope`, `verify` command. **The memory.** |
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

# headless: accept a review-blocked task whose tests passed instead of blocking it
ralphrun --prd ./prd.json --on-review-blocked accept
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
  "advisor_plan_threshold": 3,
  "heartbeat_secs": 30,
  "stream_output": true,
  "commit_per_task": true,
  "commit_message_template": "{id}: {title}",
  "stop_on_blocked": false,
  "max_cost_usd": 0,
  "review_blocked_policy": "block",
  "review_runs_commands": false,
  "review_timeout": 900,
  "worktree_per_task": false,
  "worktree_link": ["node_modules"],
  "max_parallel_tasks": 1,
  "extra_executor_args": []
}
```

- `task_timeout` bounds **one executor call**, not a whole task. See the note on
  idle timeouts further down for the other two clocks — the advisor/review
  budgets, and the fixed 600s cap on every `verify` command.

- `advisor_plan_threshold` is how much task a plan has to be worth. CROSS scores
  every task on measured facts — acceptance criteria, deps, declared `scope`
  paths, description length — and calls the advisor when the score reaches this
  number, which at the default skips only the tasks that are small on every axis.
  A task with no `verify` command is always planned, whatever you set here.
  Raise it to buy fewer advisor calls, lower it to plan everything. Skips are
  logged with the numbers behind them.

- `stream_output` turns on the executor CLI's own event stream, so the live pane
  shows tool calls and answers **as they happen**. Without it a `-p` style CLI
  buffers everything and delivers it in one chunk when the turn ends — measured
  at 25s of total silence for a 25s task. It applies to the **spawn** backends
  that have a verified event parser (today: `claude`); the in-process
  `cursorsdk` backend always streams through its own parser, and the rest ignore
  the knob. The advisor never streams, because its stdout *is* its verdict.

  It is **not only a display setting**: the cost figure rides on that same event
  stream and on nothing else, so turning it off for `claude` also turns off the
  only spend metering a spawn backend has — see `max_cost_usd` below.

- `max_cost_usd` stops the run once the measured spend reaches that many dollars.
  `0` (the default) is no ceiling, so an existing setup keeps running exactly as
  it did. It is read **once**, before the first task: the config menu is reachable
  mid-run, and a re-read per iteration would let a run raise its own budget from
  the inside. It is checked **between** tasks and never mid-task — killing a task
  that is already paid for throws the result away and still leaves the bill — so
  the task that crosses the line finishes, and the run stops before the next one.
  Each task logs its own cost, and the run ends with the total and the cost per
  accepted change.

- **The reported total is a floor, not a total.** The ceiling only counts spend
  the executor *reports*, which today is `claude` **with the event stream on**:
  `total_cost_usd` rides on that stream, so `stream_output: false` turns
  `claude`'s reporting off along with its live pane, and no other backend reports
  a USD figure at all — the in-process `cursorsdk` gets token counts from the SDK,
  not dollars, whatever `stream_output` says. *No* CLI meters the advisor either,
  so part of nearly every run is unmeasured: costs print as `≥$1.2345` when some
  of the spend was never reported and `unknown` when none of it was.
  `max_cost_usd` therefore bounds only the spend ralphrun can *see* — with an
  unmetered executor, or a metered one with the stream off, it never fires at
  all. It is a backstop against a runaway loop, not a billing limit; your
  provider's own spend cap is the only real one.

- `review_blocked_policy` is the approval gate for a task the reviewer refused,
  on runs with no dashboard to ask. On a TTY you get the prompt you always got —
  retry, approve, quit. Headless there used to be no gate at all: the task simply
  went blocked and the run moved on, because the decision lived in the UI layer
  and therefore did not exist without a UI. A headless run cannot wait on a human,
  so its gate is a *policy*: `"block"` (the default, and exactly today's behaviour)
  or `"accept"`, which marks the task done and commits it. `--on-review-blocked
  block|accept` sets it per run.

- **`"accept"` cannot accept a task whose tests failed.** It is bounded by the
  same rule as the dashboard's approve key: the override is only ever offered
  when verification passed, so `"accept"` overrides a *reviewer's* judgement and
  never an objective gate. A task that fails `verify` blocks under every policy.
  Every headless decision — accepted, or refused and why — is written to
  `progress.md`, since that log is the only audit trail a run nobody watched
  leaves behind.

- **`review_runs_commands` multiplies what every round costs.** It is `false` by
  default and it should stay that way unless you want it. Off, a review round is
  one agent turn that reads a diff and answers. On, it is an agent that runs the
  acceptance scenario, a reproduction, an edge case — real work, real tool calls,
  real minutes — and it happens on *every* round of *every* task, up to
  `max_review_rounds`. Assume a several-fold jump in both wall clock and spend.
  What you buy is the integration bug: a reviewer that only reads a diff never
  catches the one where each piece is fine and the assembly is not.

- It does **not** re-run `verify`. The loop's own gate already ran that command
  and hands the reviewer the result, and the prompt says so explicitly: running it
  again buys a slower copy of an answer it was given. Its budget goes on what the
  suite does *not* cover.

- `review_timeout` (seconds, default `900`) is that reviewer's own wall clock,
  used **only** when `review_runs_commands` is on. A reviewer running a suite
  needs the budget of a test run rather than of an answer; a read-only one still
  dies at `advisor_timeout`, because raising that ceiling for every review would
  only make a hung one three times more expensive.

- **The reviewer's spend is unmetered, like every other advisor call.** No CLI
  reports what an advisor turn cost, so an executing reviewer counts toward
  `max_cost_usd` exactly the way the rest of the advisor does: by marking the
  run's total a floor (`≥$…`). The ceiling still fires between tasks — on money
  ralphrun could see. With this on, more of the bill is money it cannot.

- `worktree_per_task` runs each task in its own detached `git worktree` cut from
  `HEAD`, then cherry-picks the resulting commit(s) back into your workspace. It
  buys two things. **Read isolation**: a `verify` command shells `tsc` or
  `npm test`, and those read the *whole* project, so without a worktree the gate
  sees whatever else is lying around. And **rollback**: a blocked task is a
  directory that gets deleted, instead of a mess smeared across your workspace
  with nothing to undo it.

- **It changes what a task can see, so it is `false` by default.** A worktree is
  checked out from `HEAD`, which means a task in worktree mode **no longer sees
  your uncommitted work**. That is inherent to isolation, not a bug, and it is
  the reason nothing changes for you until you turn this on. It also requires
  `commit_per_task` (the default) — the commit is *how* work leaves a worktree,
  so the two are refused as a pair at config load.

- **`worktree_link` is not optional if your project needs it.** A fresh worktree
  contains **tracked files only** — no `node_modules`, no `.venv`, no `target/`.
  Every listed name is seeded into each cell, and the default
  (`["node_modules"]`) is Node-shaped: a Python, Rust, Go or Java project must
  set its own before enabling worktrees, or every task fails its gate for a
  reason it cannot fix.

  Seeding is a **copy-on-write clone** (APFS `cp -c`, or `--reflink` on
  btrfs/xfs/ext4): the whole tree in milliseconds, costing disk only for what
  changes, and **isolated** — an install inside a cell cannot reach your real
  dependencies. Note this is not a git property. A worktree is isolated because
  it holds no ignored files at all; the clone is what makes it *usable* without
  giving that isolation back.

  On a filesystem that cannot clone, seeding falls back to a **symlink at the
  real directory**, which is shared. That is fine serially — it is what you would
  have run by hand — but with `max_parallel_tasks > 1` two installs at once
  corrupt the tree, and discarding a worktree cannot undo it. ralphrun probes the
  filesystem at startup and **refuses the run** when all three hold at once
  (shared tree, parallel tasks, and a `verify` that installs), naming the tasks.

- **The wave integration gate.** Every cell verifies against the trunk it was
  *cut from*, so two tasks can each pass alone and be broken the moment they land
  together — A renames a function, B adds a caller of the old name, their scopes
  never overlap, both are green, the merged trunk is not. The cherry-pick only
  refuses *textual* conflicts and the reviewer only saw one task's diff, so
  nothing else catches it.

  After a wave lands, ralphrun re-runs the **distinct** `verify` commands of the
  tasks that reached `done`, in the main workspace. Nothing to configure — the
  commands are already in the backlog — and a wave whose five tasks all say
  `npm test` costs one run, not five. Only fires for a real wave: with one task
  in flight there is nothing to combine.

  If it fails, the **run stops** and the commits are **not reverted**. They are
  merged and each task's commit is its own, so undoing them is your call. Going
  on is the worse option: every later wave is cut from the broken trunk and fails
  the same way, at full agent price.

- **What happens when the pick fails.** If the work conflicts with something
  that landed first, the task goes back into the normal retry ladder and the
  next attempt is cut from the new `HEAD` — re-execution on top of the result,
  bounded by `max_retries_per_task`. If git refuses the pick outright because
  your workspace has **staged or uncommitted changes** it would overwrite, or if
  it refuses the task's *commit* (a `pre-commit` hook, an unset identity, a
  signing key it cannot use), the task blocks and **the whole run stops**: the
  cause is your workspace, not the task, so every remaining task would execute in
  full and be refused the same way. Commit or stash, and start again. Either way
  the workspace is left byte-identical, and the log carries the commit sha, so
  the task's work is still recoverable by hand (`git cherry-pick <sha>`) even
  after its worktree is gone. Orphan worktrees from a killed run are reclaimed
  at the next startup, whether or not the feature is still on.

- **Worktrees isolate the filesystem, not the machine.** Ports, dev databases
  and code generators are shared no matter what this setting says.

- `max_parallel_tasks` is how many tasks may execute at once. It is `1` by
  default — the serial loop, unchanged — and clamped to `[1, 8]`, because the
  binding constraint is agent spend and provider rate limits, not cores. Above
  `1` it is **refused unless `worktree_per_task` is on**: two executors editing
  one checkout is data loss, not a configuration. So parallelism is opted into
  twice, on purpose.

- **What actually runs together.** Every task whose dependencies are all `done`
  is eligible; the loop takes up to `max_parallel_tasks` of them, waits for the
  whole wave, then picks the next one. Tasks in a wave are unordered by
  construction, and the plan compiler already refused any unordered pair with
  overlapping `scope`, so they provably cannot collide on a file. A task that
  declares **no** `scope` runs alone — a backlog written before `scope` existed
  has nothing protecting it, so it behaves exactly as it does today.

- **The speedup is bounded by the plan, not by this number.** A chain-shaped
  backlog, or one whose planner declared dependencies it did not need, gets
  exactly zero benefit from raising it. That is a planner problem, not a bug.

- **Semantic conflicts still merge cleanly.** Two tasks can each pass their own
  gate and break the build together — filesystem isolation cannot see that.
  Integration tasks whose `verify` runs the whole suite are the fix, and they
  come from the plan. Do not raise this knob far before your backlog has them.

- **`scope` is a GATE at runtime.** A task that edits paths its declared `scope`
  does not cover **fails** — it invalidated the proof its wave was scheduled on,
  so the merge is no longer known to be safe. In worktree mode the cell is
  discarded, so the escaped work never reaches the trunk, and the next attempt is
  told which paths escaped and what the scope was.

  A task with **no** `scope` declares nothing and cannot escape, so a backlog
  written before the field existed runs exactly as before. But once you declare
  scopes, declare them honestly: a shared file every task must touch has to be in
  the scope of every task that touches it. In this repo `MsgKey` derives from the
  `en` dict, so any task adding a message must list `src/i18n.ts`.

- **What parallelism costs you.** The budget is checked *between* waves, so
  `max_cost_usd` can be overshot by up to one wave's worth of tasks — killing
  work already paid for does not refund it. `s`kip and `q`uit abort **every**
  task in flight, because the dashboard has no per-task selection — so a skip
  marks the whole wave skipped, not just the first task to notice it. And the
  interactive "review blocked" prompt is skipped during a wave (it would freeze
  every sibling behind one human answer), so those tasks fall through to
  `review_blocked_policy` — default `block`. Nothing unverified is ever
  accepted either way, and a task with no `verify` command counts as unverified:
  a missing gate is not a passing one.

There is deliberately **no** idle timeout. A silence-based kill sounds obvious
but measurement says otherwise: a buffered CLI is silent for the entire task, and
even a streaming one goes quiet while a tool runs — a 40s foreground command
produced a 25.9s gap with no events at all, and that gap grows with the command.
Any value small enough to catch a wedged run is small enough to kill a healthy
test suite.

The clocks that *do* bound a task are wall-clock ones, and `task_timeout` is not
the only one. It bounds **a single executor call**, not a task: in CROSS mode a
task pays it once up front and once per fix round, so an attempt can legitimately
run up to `max_review_rounds + 1` times that, plus its advisor and review calls
(`advisor_timeout`, `review_timeout`). And every `verify` command is killed at a
**fixed 600s** — not configurable, so a suite that takes longer than ten minutes
fails its gate on every backend and in every mode.

Inspect or edit interactively:

```bash
ralphrun config show        # print resolved config (defaults + file)
ralphrun config edit        # Clack wizard over the key knobs
```

- Flags override the file: `--executor cli:model`, `--advisor cli:model|none`.
- `cli` is `claude`, `grok`, `cursor`, `cursorsdk`, `codex`, `agy`, or
  `opencode`. **To add another, drop a JSON manifest in your config dir** (see
  [Registering a CLI](#registering-a-cli-agent-manifests)) — no fork, no
  rebuild. A CLI whose command line does not fit that shape gets an entry in
  `AGENTS` in `src/agents.ts` instead; the registry is the single source of
  truth, and the adapters, preflight, pickers and NATIVE/CROSS routing all
  derive from it. (An in-process backend like `cursorsdk` also needs a runner
  module: it has no argv to build.)
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

## Registering a CLI (agent manifests)

Any coding CLI with an ordinary command line can be registered as **data**, in
an `agents/` folder next to that same global config — `~/.config/ralphrun/agents/`
(`%APPDATA%\ralphrun\agents\` on Windows). One file per CLI; **the file name is
the CLI id**, so `mycli.json` is used as `--executor mycli:fast`.

```json
{
  "label": "My CLI",
  "bin": "mycli",
  "models": ["fast", "slow"],
  "modelFlag": "--model",
  "args": ["run", "-p"],
  "autoApproveArgs": ["--yolo"],
  "defaultModel": "fast",
  "promptVia": "argv",
  "promptLast": false,
  "reviewArgs": ["--read-only"]
}
```

It builds exactly this command line:

```
<bin> <args…> [prompt] [modelFlag <model>] [autoApproveArgs…] [reviewArgs…]
```

- `label`, `bin`, `models`, `modelFlag` are required; the rest are optional.
- `promptVia: "stdin"` keeps the prompt out of the argv and pipes it in — use it
  if the CLI reads stdin when given no prompt argument (it is what makes a 25k
  review prompt survive Windows' ~8191 char command line limit).
- `promptLast: true` puts the prompt after the flags instead of after `args`.
- `reviewArgs` are added **only** on the review call and must be a read-only
  grant: a manifest that puts an approve-everything flag there is refused.
- `defaultModel` must be one of `models`, or `""` to let the CLI choose. The
  wizard recommends it (or the first model) for all three roles.

A registered CLI appears in the pickers, gets the same preflight PATH check as
a built-in, and runs. A manifest **cannot redefine a built-in CLI** — name it
`claude.json` and it is refused, so nothing in `~/.config` can silently repoint
what your existing `prd.json` runs. Anything invalid is refused the same way,
with the file and the field printed on stderr at startup, and registers nothing.

**Where the line is.** A manifest covers the common shape only. Streaming event
parsers, headless auth probes, server-side advisor flags (NATIVE mode) and
in-process SDK backends are *functions*, so a CLI that needs one still gets an
entry in `AGENTS` in `src/agents.ts` — as does one whose argv does not fit the
template above (`grok` weaves `--cwd <cwd>` into the middle of its own).

## Requirements

The CLIs you name must be installed and logged in:

- `claude` — Claude Code >= 2.1.170 (needed for native `--advisor`). The only CLI
  with a NATIVE advisor today.
- `grok` — Grok CLI (`x.ai/cli`), browser login.
- `cursor` — Cursor CLI (`cursor-agent` via `cursor.com/install`). Router CLI.
- `cursorsdk` — the same Cursor agent, but driven **in-process** through the
  optional [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) package
  instead of spawning `cursor-agent`. See below; it is not a drop-in for
  `cursor` and needs its own setup.
- `codex` — Codex CLI (`codex exec`).
- `agy` — Antigravity CLI. Model names contain spaces — quote them
  (`--advisor "agy:Claude Opus 4.6 (Thinking)"`).
- `opencode` — opencode CLI (`opencode run`). Models are `provider/model`
  (`--executor opencode:opencode/big-pickle`); no model = its configured default.
  Auth is per-provider, so login is reported "unknown" like grok/agy/codex.

Preflight fails fast if a named CLI isn't on PATH, with a clear message instead
of burning every task's retry budget. `cursorsdk` has no binary, so preflight
checks that its package resolves instead (by resolution only — it is never
imported or run there). Login is only *verified* for `claude`, `cursor` and
`cursorsdk` — the others have no reliable headless auth probe, so they report
"unknown" and are never blocked on it.

### `cursorsdk` — Cursor in-process (optional)

Same agent as `cursor`, no per-call process boot, native cancel and typed
events. **There is no benchmark of this backend yet** — the only measured number
is that `cursor-agent --version` alone costs 1.07s per invocation, and ralphrun
calls the executor up to `max_review_rounds + 1` times per task. Treat the
speedup as unproven.

Setup, all three parts required:

```bash
npm i -g @cursor/sdk          # drop the -g for a local checkout of ralphrun
export CURSOR_API_KEY=<key from cursor.com/dashboard → Integrations>
```

- The package is an **optional peer dependency**: it is never installed for you
  (~7.6MB of platform binaries plus a telemetry client), and it requires
  **Node >= 22.13** while ralphrun itself runs on Node >= 20. Both problems
  surface as the same error naming your Node version.
- Auth is the **API key only**. An existing `cursor-agent login` session does
  **not** work for the SDK.
- **SDK model ids are not the `cursor:` CLI ids** — CLI `cursor-grok-4.5-high`
  is SDK `grok-4.5`. A wrong id fails every task with "Cannot use this model".
  `Cursor.models.list()` enumerates the real set.
- Models take an optional variant pin: `cursorsdk:grok-4.5[fast=false,effort=high]`.
  This is a **billing** knob — with no params Cursor picks the model's default
  variant, which for some models (grok-4.5 among them) is the FAST tier at about
  twice the standard rate. Running without one prints a warning once.

One Agent per call, exactly like the CLI path. Holding one across a task's fix
rounds was tried and removed: it only ever helped inside a single attempt, while
the per-attempt **handoff** below carries the same information, works the same on
every backend, and survives a retry — where a held agent is already gone.

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

**The review call gets read-only tools.** The reviewer used to judge a diff
truncated at 12k chars — and, when the executor changed nothing, no evidence at
all. It now runs with an explicit per-CLI allowlist so it can open the files that
view left out. Today that is `claude` only (`--allowedTools Read,Grep,Glob`);
every other CLI reviews the diff text alone, unchanged, because a guessed flag
would fail the whole review on an unknown argument. Auto-approve stays **off** on
this call, and the allowlist is never a blanket approve flag — that is what keeps
the reviewer from writing.

> **The "read-only" is the target CLI's, not ralphrun's.** ralphrun spawns
> `claude -p`; the agent's tool calls happen inside that process and never pass
> through ralphrun, so there is nothing here that could inspect or refuse them.
> If the CLI's allowlist leaks, ralphrun cannot tell and cannot stop it. Adding a
> CLI to this list means verifying its flag grants reads *without* writes and
> *without* prompting — nobody is on the other end of a review to answer a
> permission prompt, so a CLI that asks just burns `advisor_timeout`.

**With `review_runs_commands` on, the reviewer gets a wider, scoped grant.** The
decision of what it may run is one pure function over `(program, args)`
(`src/reviewexec.ts`), and the per-CLI flags are *generated* from its own lists,
so neither the program list nor the denials are maintained twice. It is
default-deny:

- **Allowed**: reads (`cat`, `grep`, `rg`, `ls`, `git log|diff|show|blame|…`),
  builds and tests (`node`, `npm`, `pnpm`, `npx`, `pytest`, `go`, `cargo`, `make`,
  `mvn`, …). A reviewer that cannot run the test suite is pointless, so
  over-blocking is treated as a failure, not as a safe default.
- **Refused**: everything not on the list, which is where `kubectl`, `docker`,
  `terraform`, `aws`, `ssh`, `curl` and every deploy tool shipped next year land
  without anyone maintaining a denylist. Plus, explicitly: `git push`/`commit`/
  `reset`/`clean`, `npm publish`, `npm version`, *any* install (`npm ci`,
  `pnpm add`, … — the reviewer usually runs in your own checkout, and even in a
  cell a `node_modules` the filesystem could not clone is a symlink to it),
  inline interpreter code (`node -e`, `python3 -c`: a shell by another name), and
  any command carrying a shell metacharacter — `npm test; git push` is not the
  command it claims to be.
- **A runner is decided on its real program**: `npx wrangler deploy` is a deploy,
  not an `npx`, so the decision looks through `npx`/`bunx`/`pnpm dlx`/`uv run`/
  `bundle exec` to what actually runs.
- **The flags are coarser than the function.** A CLI allowlist matches a command
  by PREFIX, so what it can carry is "this program, plus these spelled-out
  denials". The lookthrough above, the shell-metacharacter refusal and the
  "`./node` is a path, not the allowed `node`" refusal are the *function's*, and
  a CLI that is handed the flags alone does not enforce them. That is why the
  program list contains nothing whose own flags write (`find` is off it) — the
  prefix matcher could not take those back.

> **Same limitation, one size larger.** This is still the target CLI's
> enforcement, not ralphrun's — the function decides, the CLI's allowlist flags
> enforce, and nothing in between can see a tool call. A CLI with no execution
> grant silently stays read-only rather than being handed a blanket "run
> anything", which would be the opposite of the point.

## Live feedback

On a TTY the run loop mounts a fullscreen Ink dashboard: task sidebar with
overall progress, the current task's subphase (advising → executing →
verifying → reviewing → fixing), review round / attempt counters, gate results,
elapsed-vs-timeout — with `[p]ause` (no confirm), `[s]kip` and `[q]uit` (both
confirmed; skip kills whichever child is running — executor, `verify` command or
reviewer — and moves on). Piped/CI runs fall
back to plain log lines.

Everything is also appended to `progress.md` behind a stable `- [HH:MM:SS] `
prefix — the durable log. The lines themselves are the same strings the dashboard
shows, so they render in the **active UI language**, which resolves from `--lang`,
then your saved `language`, then your system locale. Run with `--lang en` if you
need the log in English; the samples below are the `en` rendering.

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
  (`status` / `retries` / `deps` / `acceptance` / `scope`). Re-running always
  resumes. Any per-task worktree a kill left under `.ralphrun/worktrees/` is
  reclaimed in the same pass — including when `worktree_per_task` has since been
  turned back off, so a crash never leaves the repository littered.
- **Git isolation**: the workspace gets its own `.git`, so commits/diffs never
  leak into a parent repo (auto-initialized when `commit_per_task` or
  `review_after` is on).
- **The loop commits, not the executor**: the task prompt tells the executor to
  leave its work uncommitted. When a task passes, `commit_per_task` stages
  **only the paths that task changed** — measured against a snapshot taken when
  it started — so files you already had uncommitted stay yours instead of
  landing in a commit named after a task that never touched them.

  **With one fallback.** When the scoped stage itself fails — git refuses the
  pathspec, most commonly for a file that was untracked when the task started and
  removed by it — the loop stages everything (`git add -A`) and says so in the
  log rather than losing the task's work. That commit *can* sweep in unrelated
  dirty files. Committing beats dropping the work; in worktree mode the sweep is
  confined to the cell anyway.
- **The review gate fails closed**: a reviewer that timed out or crashed, and an
  answer that is neither `APPROVE` nor `CHANGES`, both count as *not approved*.
  Each used to pass as an approval, which let a task reach `done` with nothing
  having judged it. A task blocked this way is offered for manual approval in
  the TUI (only if its tests passed) and the reason is in `progress.md`.
- **An empty diff is the reviewer's call**: when the executor changes nothing,
  the review still runs — it is told there is no diff and decides whether this
  task's acceptance can hold without one. A task that only asks to confirm
  something already works can be approved; one that asks for work to be done
  cannot.
- **Truncated review diffs say so**: the diff handed to the reviewer is capped,
  and now carries an explicit marker when it was cut, so an approval is never
  given over a change the reviewer only half saw. Where the CLI supports it (see
  [Permissions](#permissions)) the reviewer can also open the real files instead
  of judging the cut view.

> **Workspace default is the current directory.** Run ralphrun from inside your
> project dir (or pass `--workspace`), *not* from the tool dir.

## The one rule that makes or breaks it

Fresh context = the executor forgets everything between tasks. All durable state
must live in `prd.json`, especially `architecture_notes`. Anything not written
there gets reinvented next task. Keep those notes short and load-bearing.

**A run can now write there too — in CROSS mode.** When the reviewer approves a
task, it may add one line under a `## Learned during runs` heading — but only for
a fact a later task would waste an agent run without: a constraint you can only
learn by hitting it, an approach that cannot work here and why. It is gated hard
against the obvious failure, which is a reviewer that narrates. What the task
did, where code lives, which library is used, that the tests pass — none of those
are notes, and writing nothing is the correct and usual answer.

It rides on the review call the task already makes, so it costs no extra model
call — which is also why **NATIVE mode never writes one**. There the advisor runs
server-side inside the single `claude` process and ralphrun has no review call of
its own to carry the note back on; buying one would be the extra call the design
refuses.

The section is **capped**. Past the cap the run stops appending and says so,
rather than dropping the oldest line — you may have promoted that one there
yourself. This is deliberately not "keep a summary of every task": that would
rebuild, one honest line at a time, exactly the accumulating context the fresh
reset exists to prevent. The repository is already the durable record of what was
built; these notes are only for what the repository cannot tell you.

## Writing the backlog

Each task needs `id`, `deps`, `description`, `acceptance`, and `verify` — a
shell command that exits 0 only when the task is truly done (the objective gate
that stops the loop from lying). `verify` should be a stack-aware quality gate:
for typed/tested projects, include the relevant static check plus focused tests,
and add build or integration tests when the task changes integration surface.

`scope` is optional: the paths or globs the task is allowed to edit. Two tasks
with no dependency path between them may not declare overlapping scope — see
below. At run time it is **a gate**: a task that edits outside its declared scope
fails and retries with the escaped paths named in its feedback. An empty `scope`
declares nothing and cannot escape. It also gives the reviewer a checkable
contract (paths changed outside `scope`) instead of a judgement call.

`deps` is the other half of the plan's quality. Declare an edge only when a task
**consumes** something the earlier one produces — "comes later in the narrative"
is not a dependency, and a plan that chains everything sequentially cannot be
parallelized later. Where parallel branches converge, add an integration task
whose `verify` runs the whole suite: N tasks each passing their own isolated
gate can still be broken together.

```json
{
  "id": "T2-data-model",
  "title": "Core data model",
  "deps": ["T1-scaffold"],
  "retries": 0,
  "description": "Define the core entities and schema.",
  "acceptance": ["schema/migration files present", "migration runs clean"],
  "scope": ["src/db/**", "migrations/**"],
  "verify": "npm run typecheck && npm run test -- tests/data-model.test.ts && npm run migrate"
}
```

### What validation refuses

The backlog is treated as untrusted input; a broken plan is rejected before the
loop starts, not diagnosed halfway through it.

- **Dependency cycles.** `A → B → A` used to pass every check, and then the run
  died with *"no runnable tasks"* — a message that blames the tasks when the PRD
  is the thing that cannot be satisfied. It is now a load error that names the
  tasks in the cycle.
- **Unverified tasks, while authoring.** The planner and the studio refuse to
  finalize a PRD where any task has no `verify`: a task whose gate can never fail
  is a hole in the loop. Loading an existing backlog stays permissive — it warns
  once with the count (`3/8 tasks have no verify command`) and runs.
- **Overlapping editor scopes.** Two tasks with no dependency path between them
  (direct or transitive) that declare `scope` globs sharing a file are refused:
  nothing orders them, so both could edit that file at once. Tasks that *do*
  depend on each other may overlap freely — the graph already sequences them.
- **Shape.** Unknown dep ids, duplicate ids, wrong field types, an empty task
  list, and a `scope` that is not an array of strings.

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
  prd.ts        # backlog types, ready/next task selection
  prdload.ts    # THE intake pipeline: parse -> normalize -> validate. Cycle,
                #   scope-overlap and verify refusals live here.
  agents.ts     # THE agent registry: one entry per CLI (bin, models, buildCmd,
                #   auth probe, native-advisor capability) + the JSON manifest
                #   loader that lets a user register a CLI without forking.
  adapters.ts   # build_cmd — thin seam over the registry
  prompts.ts    # executor/advisor prompt templates (always English)
  log.ts        # stdout/reporter + progress.md with timestamps
  git.ts        # git plumbing: scoped commits, review baselines, diffs
  worktree.ts   # per-task cell: create, seed, merge back, reap + the run lock
  spawn.ts      # process-tree spawn/kill (the whole group, not just the child)
  stream.ts     # cli event parsing, tool-call rendering, cost tallies
  executor.ts   # streaming executor + heartbeat + AbortSignal cancel
  cursor-sdk.ts # the in-process `cursorsdk` backend (optional @cursor/sdk)
  advisor.ts    # get_advice + advisor_review (CROSS)
  reviewexec.ts # what the reviewer is allowed to run, as a pure decision
  verify.ts     # objective gate + assembled feedback
  browser.ts    # dev-browser validation tool: opt-in detection + prompt guide
  plan-cache.ts # advisor plan provenance + the measured-facts router
  elapsed.ts    # per-task/global clocks, pause-aware
  run.ts        # NATIVE vs CROSS per task
  startrun.ts   # everything true BEFORE the first task: config, intake, menu,
                #   preflight, workspace lock, dashboard mount
  loop.ts       # the outer loop: budget ceiling between waves, wave dispatch,
                #   dry-run, stalled/manual-retry, config-menu remount
  taskrun.ts    # one task cell end to end: worktree, scope gate, retry ladder,
                #   review-blocked gate, scoped commit — plus pickWave and the
                #   wave integration gate
  wizard.ts     # ralphrun init glue (non-TTY fallback + finalize writes)
  configcmd.ts  # ralphrun config show/edit (+ --global show/reset)
  picker.ts     # fuzzy file search ('@' picker) + attachment reader
  diagnostics.ts# CLI installed/logged-in preflight
  userconfig.ts # global preferences (~/.config/ralphrun)
  i18n.ts       # the en / pt-br dicts; MsgKey derives from `en`
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
