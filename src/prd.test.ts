// prd.test.ts — nextTask, findTask (normalize/recovery cases live in prdload.test.ts)
import { describe, it, expect } from "vitest";
import { nextTask, findTask, readyTasks, sessionRunnableIds } from "./prd.js";
import { cloneArgs, linkKind, tasksInstallingDeps, verifyInstallsDeps } from "./worktree.js";
import type { PRD, Task } from "./prd.js";

function t(partial: Partial<Task> & { id: string }): Task {
  return {
    title: "t",
    status: "todo",
    deps: [],
    retries: 0,
    description: "",
    acceptance: [],
    ...partial,
  };
}

describe("nextTask", () => {
  it("returns first todo with satisfied deps", () => {
    const prd: PRD = {
      project: "", stack: "", architecture_notes: "",
      tasks: [t({ id: "A", status: "done" }), t({ id: "B", deps: ["A"] })],
    };
    expect(nextTask(prd)?.id).toBe("B");
  });

  it("skips todos with unmet deps -> null", () => {
    const prd: PRD = {
      project: "", stack: "", architecture_notes: "",
      tasks: [t({ id: "B", deps: ["A"] })],
    };
    expect(nextTask(prd)).toBeNull();
  });
});

describe("readyTasks", () => {
  const prd = (tasks: Task[]): PRD => ({ project: "", stack: "", architecture_notes: "", tasks });

  it("returns EVERY todo whose deps are all done — that set is what a wave dispatches", () => {
    const p = prd([t({ id: "A", status: "done" }), t({ id: "B", deps: ["A"] }), t({ id: "C" })]);
    expect(readyTasks(p).map((x) => x.id)).toEqual(["B", "C"]);
  });

  it("never admits a task whose dep is merely READY, only one that is done", () => {
    // the whole difference from sessionRunnableIds: admitting B here would put
    // two ordered tasks in the same wave, running B against a half-built A
    const p = prd([t({ id: "A" }), t({ id: "B", deps: ["A"] })]);
    expect(readyTasks(p).map((x) => x.id)).toEqual(["A"]);
  });

  it("excludes doing/blocked tasks, so a wave never re-dispatches one in flight", () => {
    const p = prd([t({ id: "A", status: "doing" }), t({ id: "B", status: "blocked" }), t({ id: "C" })]);
    expect(readyTasks(p).map((x) => x.id)).toEqual(["C"]);
  });
});

describe("findTask", () => {
  it("finds by id or returns null", () => {
    const prd: PRD = { project: "", stack: "", architecture_notes: "", tasks: [t({ id: "A" })] };
    expect(findTask(prd, "A")?.id).toBe("A");
    expect(findTask(prd, "Z")).toBeNull();
  });
});

describe("sessionRunnableIds", () => {
  const prd = (tasks: Task[]): PRD => ({ project: "", stack: "", architecture_notes: "", tasks });

  it("admits a chain of todo tasks (each dep completes the next)", () => {
    const p = prd([t({ id: "A" }), t({ id: "B", deps: ["A"] }), t({ id: "C", deps: ["B"] })]);
    expect(sessionRunnableIds(p, false)).toEqual(new Set(["A", "B", "C"]));
  });

  it("counts already-done deps as satisfied", () => {
    const p = prd([t({ id: "A", status: "done" }), t({ id: "B", deps: ["A"] })]);
    expect(sessionRunnableIds(p, false)).toEqual(new Set(["B"])); // done A is not itself 'runnable'
  });

  it("EXCLUDES a todo task transitively gated by a non-promotable blocked dep (non-TTY)", () => {
    // the round-4 scenario: B (browser) depends on blocked A; C is independent.
    const p = prd([t({ id: "A", status: "blocked" }), t({ id: "B", deps: ["A"] }), t({ id: "C" })]);
    expect(sessionRunnableIds(p, false)).toEqual(new Set(["C"])); // B can never run this session
  });

  it("INCLUDES that chain on a TTY, where the blocked dep can be promoted", () => {
    const p = prd([t({ id: "A", status: "blocked" }), t({ id: "B", deps: ["A"] }), t({ id: "C" })]);
    expect(sessionRunnableIds(p, true)).toEqual(new Set(["A", "B", "C"]));
  });
});

// Two parallel installs into one shared dependency tree corrupt the user's real
// node_modules, and no worktree discard undoes that. This is the detector behind
// the refusal, so a false NEGATIVE lets the corruption through and a false
// POSITIVE refuses a backlog that was fine.
describe("verifyInstallsDeps", () => {
  it.each([
    "npm ci",
    "npm install",
    "npm i",
    "npm add left-pad",
    "pnpm install --frozen-lockfile",
    "pnpm i",
    "yarn install",
    "yarn add left-pad",
    "yarn", // classic yarn with no arguments installs
    "bun install",
    "bun i",
    "npm run build && npm ci && npm test", // not the first segment
    "npm test; npm install",
    "npm test\nnpm ci", // a multi-line verify
    // NOT node-only, because worktree_link is not: `.venv` is the documented
    // Python case and README names `uv sync` in the same breath as `npm ci`, so
    // a detector that knew only the JavaScript managers let the exact
    // combination this refusal exists for through
    "uv sync",
    "uv sync --frozen",
    "uv add httpx",
    "uv pip install -r requirements.txt",
    "uv pip sync requirements.txt",
    "poetry install",
    "poetry add httpx",
    "pip install -r requirements.txt",
    "pip3 install -e .",
    // The MODULE form, which pip's own docs recommend over bare `pip` because it
    // pins which environment gets written — the one worktree_link shares. The
    // first token is the interpreter, so a detector keyed on it alone let every
    // one of these install into the user's real `.venv` from every cell at once.
    "python -m pip install -r requirements.txt",
    "python3 -m pip install httpx",
    "py -m pip install -e .", // the Windows launcher
    "python3.12 -m pip install httpx", // a version suffix names the build, not another command
    "python.exe -m pip install httpx",
    "python -m pip install --upgrade pip && pytest", // not the only segment
    "bundle install",
    "npm.cmd ci", // the Windows shim's real name is the same install
    // A global flag sits LEFT of the verb, so the verb is not tokens[1]. Reading
    // it as tokens[1] called every one of these a non-install and let the
    // concurrent-install corruption run in every cell at once.
    "npm --prefix . install",
    "npm --silent ci", // a boolean flag, so the verb is one token further right
    "npm --loglevel error ci", // ...and this one carries a value, so it is two
    "npm --loglevel=error ci", // the `=` form carries its own value
    "pnpm -C packages/app install",
    // ...and a flag that carries a value for ONE manager must not swallow the
    // verb for another: `-w` is npm's `--workspace <name>` and pnpm's boolean
    // `--workspace-root`, so one flat option table read `add` as `-w`'s value
    // and reported the install as none at all.
    "pnpm -w add lodash",
    "pnpm -w install",
    "pnpm --filter app install", // and pnpm's --filter really does take one
    "npm --workspace pkg install", // as does npm's --workspace
    "yarn --cwd app install",
    "yarn --frozen-lockfile", // classic yarn installs with options and no verb
    "uv --directory svc sync",
    "uv --directory svc pip install -r requirements.txt", // a nested verb, two flags in
    "pip --quiet install -r requirements.txt",
    // The shell consumes all of this BEFORE the command runs, so the manager is
    // not the first token — and every one of these installs just the same. Read
    // as written, the segment's head is an assignment, a wrapper or punctuation,
    // which is in no table, so the segment was passed over entirely.
    "CI=1 npm ci",
    "NODE_ENV=production FOO=bar npm install",
    "env CI=1 npm ci",
    "set CI=1 & npm ci", // the Windows spelling, and a single `&` still separates
    "npm run build & npm ci",
    "(npm ci)", // a subshell
    "{ npm ci; }", // ...and a group
    'sh -c "npm ci"',
    "bash -lc 'uv sync'",
    'cmd /c "npm ci"',
    'powershell -Command "npm ci"',
    'sh -c "npm test && npm ci"', // the wrapper's command has segments of its own
    "NPM.CMD ci", // cmd.exe resolves the shim case-insensitively; so must this
    "PIP install -r requirements.txt",
  ])("detects %j as an install", (cmd) => {
    expect(verifyInstallsDeps(cmd)).toBe(true);
  });

  it.each([
    "npm test",
    "npm run test",
    "npm run install-check", // `run` makes the next token a SCRIPT name
    "npm run build",
    "pnpm test",
    "yarn test",
    "yarn run install-deps",
    "bun test",
    "cargo test",
    "echo npm ci", // named, not run
    "npm", // a manager with no sub-command installs nothing...
    "pnpm",
    "bun",
    "uv run pytest", // `run` makes the next token a command, not a verb
    "uv pip list", // reads the environment, never writes it
    "uv pip show httpx",
    "poetry run pytest",
    "pip list",
    "bundle exec rspec",
    // the flag-skipping must not degrade into "does the word appear anywhere":
    // the verb still has to be in the verb's POSITION
    "npm --silent run install-check",
    "npm test -- --grep install", // everything right of `--` is the sub-command's
    "uv --directory svc run pytest",
    // the interpreter is only an install when `pip install` is what follows it:
    // folding `python` into the tables must not make every python command one
    "python -m pip list",
    "python -m pytest",
    "python -m build",
    "python manage.py migrate",
    "py -m venv .venv", // makes an environment, never writes into a shared one
    // peeling the shell's prefixes must not degrade into "the word appears
    // somewhere": a false positive here refuses a backlog that was fine
    "CI=1 npm test",
    "env CI=1 npm run install-check",
    'sh -c "echo npm ci"', // named inside the wrapper, still not run
    "sh ./install.sh", // a SCRIPT this detector cannot read, so it must not guess
    "bash scripts/ci.sh",
    "(npm test)",
    // the separators only separate where the SHELL separates: inside a quoted
    // word they are text, and cutting there invents segments nobody runs
    "npm test -- --grep 'a&b'",
    'echo "a; npm ci"',
    "",
    "   ",
  ])("does not flag %j", (cmd) => {
    expect(verifyInstallsDeps(cmd)).toBe(false);
  });
});

// BSD cp has no --reflink and GNU cp has no -c, so the wrong arm does not clone
// slowly — it fails, and every cell silently falls back to a shared symlink.
describe("cloneArgs", () => {
  it("uses APFS clonefile on darwin and reflink everywhere else", () => {
    expect(cloneArgs("darwin", "a", "b")).toEqual(["-c", "-R", "a", "b"]);
    expect(cloneArgs("linux", "a", "b")).toEqual(["-R", "--reflink=always", "a", "b"]);
    expect(cloneArgs("win32", "a", "b")).toEqual(["-R", "--reflink=always", "a", "b"]);
  });
});

// On Windows a DIRECTORY symlink needs elevation, so the wrong arm here is not a
// slower cell — it is no cell at all, and NTFS cannot reflink either.
describe("linkKind", () => {
  it("asks for a junction on win32 and a plain symlink everywhere else", () => {
    expect(linkKind("win32")).toBe("junction");
    expect(linkKind("darwin")).toBeUndefined();
    expect(linkKind("linux")).toBeUndefined();
  });
});

describe("tasksInstallingDeps", () => {
  it("names only the tasks whose verify installs, and skips those with none", () => {
    expect(
      tasksInstallingDeps([
        { id: "A", verify: "npm test" },
        { id: "B", verify: "npm ci && npm test" },
        { id: "C" }, // no verify at all
        { id: "D", verify: "yarn" },
      ]),
    ).toEqual(["B", "D"]);
  });
});
