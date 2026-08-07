// git.integration.test.ts — REAL repositories. git.test.ts mocks spawnSync, so
// it proves the ARGUMENTS are right and nothing else. This is the test that
// proves the behaviour: that a commit carries the task's files and leaves the
// user's own uncommitted work alone.
//
// It is the only check that would catch git changing the meaning of
// --pathspec-from-file, a stray rename detection resurrecting a deleted path, or
// a baseline that quietly includes what was already dirty.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureReviewBase, commitPaths, headCommit, taskChangedPaths } from "./git.js";
import { createTaskWorktree, mergeBackTaskWork, reapOrphanWorktrees, removeTaskWorktree } from "./worktree.js";

let ws: string;

function run(...args: string[]): string {
  return runIn(ws, ...args);
}

function runIn(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function write(name: string, body: string): void {
  writeFileSync(join(ws, name), body);
}

/** what the last commit actually contains, sorted for a stable comparison */
function committedFiles(): string[] {
  return run("show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean).sort();
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "ralphrun-git-it-"));
  run("init", "-q", ".");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("scoped task commits", () => {
  it("commits the task's files and leaves the user's pre-existing changes alone", () => {
    write("tracked.ts", "original\n");
    write("deleted-by-task.ts", "doomed\n");
    run("add", "-A");
    run("commit", "-q", "-m", "base");

    // the user's own work, uncommitted BEFORE the task starts
    write("user-wip.ts", "mine\n");
    write("tracked.ts", "original\nmy own edit\n");

    const base = captureReviewBase(ws);
    expect(base).toBeTruthy();

    // the task runs: adds a file and deletes another
    write("task-added.ts", "new\n");
    unlinkSync(join(ws, "deleted-by-task.ts"));

    const paths = taskChangedPaths(ws, base);
    expect(paths?.sort()).toEqual(["deleted-by-task.ts", "task-added.ts"]);
    expect(commitPaths(ws, paths!, "T1: title")).toBe(true);

    expect(committedFiles()).toEqual(["deleted-by-task.ts", "task-added.ts"]);
    // the user's file and their edit are STILL uncommitted, exactly as left
    expect(run("status", "--porcelain")).toBe(" M tracked.ts\n?? user-wip.ts\n");
  });

  it("stages a rename as both sides, so the old path does not survive the commit", () => {
    write("old.ts", "body\n");
    run("add", "-A");
    run("commit", "-q", "-m", "base");

    const base = captureReviewBase(ws);
    write("new.ts", "body\n");
    unlinkSync(join(ws, "old.ts"));

    // rename detection would report only new.ts, and old.ts would linger forever
    const paths = taskChangedPaths(ws, base);
    expect(paths?.sort()).toEqual(["new.ts", "old.ts"]);
    commitPaths(ws, paths!, "T1: rename");

    expect(run("ls-files").trim().split("\n")).toEqual(["new.ts"]);
  });

  it("works on the very first commit, when there is no HEAD to diff against", () => {
    const base = captureReviewBase(ws); // empty repo: the empty tree
    write("first.ts", "hello\n");

    const paths = taskChangedPaths(ws, base);
    expect(paths).toEqual(["first.ts"]);
    expect(commitPaths(ws, paths!, "T1: first")).toBe(true);
    expect(committedFiles()).toEqual(["first.ts"]);
  });

  it("does not commit a file the user staged but the task never touched", () => {
    write("a.ts", "a\n");
    run("add", "-A");
    run("commit", "-q", "-m", "base");

    write("user-staged.ts", "theirs\n");
    run("add", "user-staged.ts"); // sitting in the index before the task starts

    const base = captureReviewBase(ws);
    write("task.ts", "task\n");

    const paths = taskChangedPaths(ws, base);
    expect(paths).toEqual(["task.ts"]);
    commitPaths(ws, paths!, "T1: title");

    expect(committedFiles()).toEqual(["task.ts"]);
    expect(run("status", "--porcelain")).toBe("A  user-staged.ts\n");
  });

  it("reports failure instead of committing when a path resolves to nothing", () => {
    write("a.ts", "a\n");
    run("add", "-A");
    run("commit", "-q", "-m", "base");
    const before = run("rev-parse", "HEAD").trim();

    // a path in neither the worktree nor the index — what an executor that
    // staged its own rename leaves behind
    expect(commitPaths(ws, ["never-existed.ts"], "T1: title")).toBe(false);
    expect(run("rev-parse", "HEAD").trim()).toBe(before);
  });
});

// The merge-back is the step that did not exist before worktrees, and every
// interesting thing about it is a git behaviour — an empty range that exits
// 128, an abort that discriminates a conflict from a refusal, a removal that
// must not follow a symlink. Mocked spawnSync cannot see any of it.
describe("per-task worktrees", () => {
  /** a repo with one commit, which is what createTaskWorktree needs to exist */
  function seed(): string {
    write("a.txt", "line\n");
    write("b.txt", "b\n");
    run("add", "-A");
    run("commit", "-q", "-m", "base");
    return run("rev-parse", "HEAD").trim();
  }

  function commitIn(dir: string, name: string, body: string, msg: string): void {
    writeFileSync(join(dir, name), body);
    runIn(dir, "add", "-A");
    runIn(dir, "commit", "-q", "-m", msg);
  }

  it("lands two disjoint worktrees onto a DIRTY trunk without touching the user's work", () => {
    const base = seed();
    // ralphrun is built to run on a dirty tree — a clean-trunk precondition
    // would disable the whole feature for the common case
    write("a.txt", "line\nmy own edit\n");
    write("scratch.txt", "mine\n");

    const wt1 = createTaskWorktree(ws, "T1", [])!;
    const wt2 = createTaskWorktree(ws, "T2", [])!;
    commitIn(wt1, "x.txt", "x\n", "T1");
    commitIn(wt2, "y.txt", "y\n", "T2");

    expect(mergeBackTaskWork(ws, wt1, base).status).toBe("ok");
    expect(mergeBackTaskWork(ws, wt2, base).status).toBe("ok");

    expect(existsSync(join(ws, "x.txt"))).toBe(true);
    expect(existsSync(join(ws, "y.txt"))).toBe(true);
    // the user's edit is byte-identical and their untracked file is still there;
    // .ralphrun/ does not show up at all, which is the .git/info/exclude line
    // doing its job rather than being cosmetic
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("line\nmy own edit\n");
    expect(run("status", "--porcelain")).toBe(" M a.txt\n?? scratch.txt\n");
  });

  it("keeps the worktree directories out of the trunk's own baseline and commits", () => {
    seed();
    createTaskWorktree(ws, "T1", []);
    // without the exclude line the temp-index `git add -A` inside these two
    // would sweep an entire checkout into the trunk's next task commit
    const paths = taskChangedPaths(ws, captureReviewBase(ws));
    expect(paths).toEqual([]);
  });

  it("carries EVERY commit in the range, not just the last one", () => {
    const base = seed();
    const wt = createTaskWorktree(ws, "T1", [])!;
    // the executor commits on its own (loop.ts logs when it does) and the task
    // commit follows — a single-sha pick would silently drop the first
    commitIn(wt, "first.txt", "1\n", "executor");
    commitIn(wt, "second.txt", "2\n", "T1: title");

    expect(mergeBackTaskWork(ws, wt, base).status).toBe("ok");
    expect(existsSync(join(ws, "first.txt"))).toBe(true);
    expect(existsSync(join(ws, "second.txt"))).toBe(true);
    expect(run("rev-list", "--count", `${base}..HEAD`).trim()).toBe("2");
  });

  it("skips an empty range instead of handing it to cherry-pick", () => {
    const base = seed();
    const wt = createTaskWorktree(ws, "T1", [])!;
    // `git cherry-pick a..a` exits 128 with "empty commit set passed", so a
    // task that committed nothing must never reach the command at all
    expect(mergeBackTaskWork(ws, wt, base)).toEqual({ status: "nothing", head: base });
    expect(run("rev-parse", "HEAD").trim()).toBe(base);
  });

  it("reports a conflict and leaves the trunk at the winner's content", () => {
    const base = seed();
    const wt1 = createTaskWorktree(ws, "T1", [])!;
    const wt2 = createTaskWorktree(ws, "T2", [])!;
    commitIn(wt1, "a.txt", "one\n", "T1");
    commitIn(wt2, "a.txt", "two\n", "T2");

    expect(mergeBackTaskWork(ws, wt1, base).status).toBe("ok");
    const second = mergeBackTaskWork(ws, wt2, base);
    expect(second.status).toBe("conflict");
    // aborted cleanly: first-to-merge wins, and the loser's sha comes back so
    // the retry ladder can name recoverable work in the log
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("one\n");
    expect(run("status", "--porcelain")).toBe("");
    expect(second.head).toBe(runIn(wt2, "rev-parse", "HEAD").trim());
  });

  it("reports 'dirty' — not 'conflict' — when the USER has that file uncommitted", () => {
    const base = seed();
    const wt = createTaskWorktree(ws, "T1", [])!;
    commitIn(wt, "a.txt", "task\n", "T1");
    write("a.txt", "the user is editing this\n");

    // git refuses before starting the pick, so no CHERRY_PICK_HEAD is written:
    // that absence is what tells the loop to block instead of retrying, since a
    // retry cannot move the user's edit out of the way
    expect(mergeBackTaskWork(ws, wt, base).status).toBe("dirty");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("the user is editing this\n");
    expect(existsSync(join(ws, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
  });

  it("symlinks node_modules in, and removing the worktree does not follow it", () => {
    seed();
    mkdirSync(join(ws, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(ws, "node_modules", "dep", "index.js"), "module.exports = 1\n");

    // a fresh worktree has TRACKED files only, so without this every
    // `verify: "npm test"` fails before anything interesting is exercised
    const wt = createTaskWorktree(ws, "T1", ["node_modules"])!;
    expect(existsSync(join(wt, "node_modules", "dep", "index.js"))).toBe(true);

    removeTaskWorktree(ws, wt);
    expect(existsSync(wt)).toBe(false);
    // getting this wrong deletes the user's dependencies
    expect(existsSync(join(ws, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("reaps only ralphrun's own orphans and leaves a user's worktree alone", () => {
    seed();
    const wt = createTaskWorktree(ws, "T1", [])!;
    const mine = join(mkdtempSync(join(tmpdir(), "ralphrun-user-wt-")), "checkout");
    run("worktree", "add", "--detach", mine, "HEAD");

    try {
      // at boot no ralphrun worktree can legitimately be live, so a leftover one
      // is a crash's litter — but a worktree the user made is not ours to delete
      expect(reapOrphanWorktrees(ws)).toBe(1);
      expect(existsSync(wt)).toBe(false);
      expect(existsSync(join(mine, "a.txt"))).toBe(true);
      expect(headCommit(mine)).toBeTruthy();
    } finally {
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it("gives two ids that sanitize alike two different directories", () => {
    // "api:get" and "api/get" are distinct tasks that both fold to "api_get",
    // and `add` starts by DELETING whatever sits at the path — so in a wave the
    // second task would reap the first one's LIVE cell, mid-execution.
    const base = seed();
    const first = createTaskWorktree(ws, "api:get", [])!;
    writeFileSync(join(first, "wip.txt"), "in flight\n");

    const second = createTaskWorktree(ws, "api/get", [])!;

    expect(second).not.toBe(first);
    expect(existsSync(join(first, "wip.txt"))).toBe(true);
    expect(headCommit(first)).toBe(base);
    expect(headCommit(second)).toBe(base);
  });

  it("returns null rather than throwing when the repo has no commit to branch from", () => {
    // prepareRun inits a repo with no commit, and a task must degrade to the
    // main workspace instead of failing on infrastructure it cannot fix
    expect(createTaskWorktree(ws, "T1", [])).toBeNull();
  });
});
