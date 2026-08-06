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
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureReviewBase, commitPaths, taskChangedPaths } from "./git.js";

let ws: string;

function run(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: ws, encoding: "utf8" });
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
