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
  it("counts the commands that REMOVE from the tree, not just the installs", () => {
    // a shared node_modules is as broken by one task deleting a package as by
    // another adding one — both write the tree every parallel verify reads
    expect(
      tasksInstallingDeps([
        { id: "A", verify: "npm uninstall left-pad && npm test" },
        { id: "B", verify: "pnpm remove foo" },
        { id: "C", verify: "bun update" },
        { id: "D", verify: "yarn upgrade" },
        { id: "E", verify: "npm test" },
      ]),
    ).toEqual(["A", "B", "C", "D"]);
  });

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
