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
import {
  claimRunLock,
  cloneDir,
  createTaskWorktree,
  ignoredDirsWouldBeShared,
  mergeBackTaskWork,
  reapOrphanWorktrees,
  releaseRunLock,
  removeTaskWorktree,
  seedIgnoredDir,
  worktreeLoss,
} from "./worktree.js";

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
  // Windows git defaults to autocrlf=true, which rewrites line endings on
  // checkout and makes a content assertion compare 'one\r\n' with 'one\n'. This
  // repo is the test's own fixture, so pin it rather than normalise at every
  // assertion.
  run("config", "core.autocrlf", "false");
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

  // Discarding a cell is the rollback the serial loop never had, but it must not
  // be silent: a commit survives in the shared object database and is recoverable
  // by sha, while whatever the executor left uncommitted does not survive at all.
  it("says what discarding a worktree would throw away", () => {
    const base = seed();
    const wt = createTaskWorktree(ws, "T1", [])!;
    expect(worktreeLoss(wt, base)).toEqual({ head: null, dirty: false });

    writeFileSync(join(wt, "wip.txt"), "in flight\n");
    expect(worktreeLoss(wt, base)).toEqual({ head: null, dirty: true });

    commitIn(wt, "wip.txt", "in flight\n", "T1");
    expect(worktreeLoss(wt, base)).toEqual({ head: runIn(wt, "rev-parse", "HEAD").trim(), dirty: false });
  });

  it("returns null when git refuses the add, rather than costing the task a retry", () => {
    seed();
    const wt = createTaskWorktree(ws, "T1", [])!;
    // a LOCKED leftover survives `prune`, so the path stays registered and `add`
    // refuses it — infrastructure trouble no retry of the task could ever fix
    run("worktree", "lock", wt);
    rmSync(wt, { recursive: true, force: true });

    expect(createTaskWorktree(ws, "T1", [])).toBeNull();
  });

  it("returns null when the worktree path itself is unusable", () => {
    seed();
    // a file where the directory belongs makes the pre-emptive cleanup throw
    // before git is ever reached; the loop still has to degrade, not crash
    mkdirSync(join(ws, ".ralphrun"), { recursive: true });
    writeFileSync(join(ws, ".ralphrun", "worktrees"), "not a directory\n");

    expect(createTaskWorktree(ws, "T1", [])).toBeNull();
  });

  it("reaps nothing, and does not throw, outside a repository", () => {
    // --workspace can point at any directory, and the reap runs unconditionally
    // at boot — git's empty answer there must read as "no orphans"
    const plain = mkdtempSync(join(tmpdir(), "ralphrun-norepo-"));
    try {
      expect(reapOrphanWorktrees(plain)).toBe(0);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("writes its exclude line whether or not info/exclude already exists", () => {
    seed();
    const exclude = join(ws, ".git", "info", "exclude");
    unlinkSync(exclude);
    createTaskWorktree(ws, "T1", []);
    expect(readFileSync(exclude, "utf8")).toBe(".ralphrun/\n");

    // a file with no trailing newline: appending blind yields "*.log.ralphrun/",
    // which excludes nothing and silently sweeps the cells into the baseline
    writeFileSync(exclude, "*.log");
    createTaskWorktree(ws, "T2", []);
    expect(readFileSync(exclude, "utf8")).toBe("*.log\n.ralphrun/\n");
  });

  it("excludes the right directory when ralphrun itself runs inside a linked worktree", () => {
    const base = seed();
    const outer = join(mkdtempSync(join(tmpdir(), "ralphrun-linked-")), "checkout");
    run("worktree", "add", "--detach", outer, base);
    try {
      // from a linked worktree git answers --git-common-dir with an ABSOLUTE
      // path; resolving that against the workspace would aim the exclude line at
      // a directory that does not exist, and the write would be lost
      expect(createTaskWorktree(outer, "T1", [])).toBeTruthy();
      expect(readFileSync(join(ws, ".git", "info", "exclude"), "utf8")).toContain(".ralphrun/");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("returns null rather than throwing when the repo has no commit to branch from", () => {
    // prepareRun inits a repo with no commit, and a task must degrade to the
    // main workspace instead of failing on infrastructure it cannot fix
    expect(createTaskWorktree(ws, "T1", [])).toBeNull();
  });
});

// reapOrphanWorktrees force-deletes every cell at boot on the theory that none
// can legitimately be live. That theory is only true of ONE loop per workspace,
// and this is what makes it true — a second run used to delete the first one's
// cells while its executors were writing into them.
describe("the run lock", () => {
  it("refuses a second run and names the pid holding the workspace", () => {
    // a DIFFERENT pid that is genuinely alive — our parent. Reusing our own
    // would take the idempotent path and prove nothing.
    mkdirSync(join(ws, ".ralphrun"), { recursive: true });
    writeFileSync(join(ws, ".ralphrun", "run.lock"), String(process.ppid));
    expect(claimRunLock(ws)).toBe(process.ppid);
  });

  it("is idempotent for the process that already holds it", () => {
    expect(claimRunLock(ws)).toBeNull();
    expect(claimRunLock(ws)).toBeNull();
  });

  it("takes over a lock whose holder is gone, without needing a manual rm", () => {
    // a crash leaves the file behind; requiring the user to delete it would make
    // every crash need a manual step before the next run
    mkdirSync(join(ws, ".ralphrun"), { recursive: true });
    writeFileSync(join(ws, ".ralphrun", "run.lock"), "999999"); // no such pid
    expect(claimRunLock(ws)).toBeNull();
    expect(readFileSync(join(ws, ".ralphrun", "run.lock"), "utf8")).toBe(String(process.pid));
  });

  it("releases only its own claim", () => {
    claimRunLock(ws);
    releaseRunLock(ws);
    expect(existsSync(join(ws, ".ralphrun", "run.lock"))).toBe(false);

    // someone else's claim must survive our release — overrunning a stale lock
    // and then exiting must not unlock the run that legitimately holds it now
    writeFileSync(join(ws, ".ralphrun", "run.lock"), String(process.pid + 1));
    releaseRunLock(ws);
    expect(existsSync(join(ws, ".ralphrun", "run.lock"))).toBe(true);
  });

  it("does not throw when there is no lock to release", () => {
    expect(() => releaseRunLock(ws)).not.toThrow();
  });
});

// A gitignored directory is absent from a fresh worktree, so a cell has to be
// SEEDED with one or `verify: "npm test"` fails on every task. How it is seeded
// decides whether two parallel installs corrupt the user's real tree, and only
// a real filesystem can answer which shape you got.
describe("seeding a cell's gitignored directories", () => {
  function seedRepo(): void {
    write("a.txt", "x\n");
    mkdirSync(join(ws, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(ws, "node_modules", "dep", "index.js"), "module.exports = 1\n");
    writeFileSync(join(ws, ".gitignore"), "node_modules/\n");
    run("add", "-A");
    run("commit", "-q", "-m", "base");
  }

  // Asserts what the filesystem UNDER IT actually does, because that is what
  // differs: APFS and btrfs clone, and CI's ext4/NTFS cannot. Pinning isolation
  // unconditionally passed on the machine this was written on and failed
  // everywhere else — the same shape as the bug the whole audit was about.
  it("seeds node_modules into the cell, and isolates it wherever a clone is possible", () => {
    seedRepo();
    const dir = createTaskWorktree(ws, "T1", [])!;
    const how = seedIgnoredDir(ws, dir, "node_modules");

    // present either way, or `verify: "npm test"` fails on every task before
    // anything interesting is exercised
    expect(existsSync(join(dir, "node_modules", "dep", "index.js"))).toBe(true);

    writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 2\n");
    const real = readFileSync(join(ws, "node_modules", "dep", "index.js"), "utf8");
    if (how === "cloned") {
      // the whole point: an install inside a cell cannot reach the real tree
      expect(real).toBe("module.exports = 1\n");
    } else {
      // and the fallback IS shared — not a defect, but the exact state that makes
      // a wave whose verify installs unsafe, which is why that is refused at load
      expect(how).toBe("linked");
      expect(real).toBe("module.exports = 2\n");
    }
  });

  it("removing a cell leaves the real dependency tree alone", () => {
    seedRepo();
    const dir = createTaskWorktree(ws, "T1", ["node_modules"])!;
    removeTaskWorktree(ws, dir);
    // true for both seeding shapes: a clone is the cell's own copy, and `rm`
    // unlinks a symlink rather than following it. Getting this wrong deletes
    // the user's dependencies.
    expect(existsSync(join(ws, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("skips a name that is absent, and never overwrites one already there", () => {
    seedRepo();
    const dir = createTaskWorktree(ws, "T1", [])!;
    expect(seedIgnoredDir(ws, dir, "not-here")).toBe("absent");

    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "mine.js"), "kept\n");
    expect(seedIgnoredDir(ws, dir, "node_modules")).toBe("absent");
    expect(readFileSync(join(dir, "node_modules", "mine.js"), "utf8")).toBe("kept\n");
  });

  // This machine's filesystem clones, so the fallback is unreachable without
  // injecting the failure — and it is the branch that decides whether cells
  // share one dependency tree, so it cannot go untested.
  it("falls back to a symlink when the clone cannot be made", () => {
    seedRepo();
    const dir = createTaskWorktree(ws, "T1", [])!;
    expect(seedIgnoredDir(ws, dir, "node_modules", () => false)).toBe("linked");

    // it is a LINK, so writing through it reaches the real tree — which is
    // exactly the hazard the load-time refusal exists to catch
    writeFileSync(join(dir, "node_modules", "dep", "index.js"), "shared\n");
    expect(readFileSync(join(ws, "node_modules", "dep", "index.js"), "utf8")).toBe("shared\n");
  });

  // GNU cp creates the destination directory and only THEN discovers the
  // filesystem cannot reflink, so a failed clone can leave a partial dst behind.
  // The symlink fallback then hits EEXIST, createTaskWorktree catches it and
  // returns null, and the task silently loses its isolation — on Linux only,
  // which is why CI saw this and a macOS checkout never could.
  it("falls back cleanly even when the failed clone left a partial destination", () => {
    seedRepo();
    const dir = createTaskWorktree(ws, "T1", [])!;
    const partial = (_src: string, dst: string): boolean => {
      mkdirSync(dst, { recursive: true }); // what GNU cp does before it fails
      return false;
    };
    expect(seedIgnoredDir(ws, dir, "node_modules", partial)).toBe("linked");
    expect(readFileSync(join(dir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1\n");
  });

  it("cloneDir refuses rather than degrading to a byte copy", () => {
    seedRepo();
    // a silent slow copy would look like a hang at hundreds of megabytes per
    // task, so failure has to be visible to the caller
    expect(cloneDir(join(ws, "does-not-exist"), join(ws, "dst"))).toBe(false);
    expect(existsSync(join(ws, "dst"))).toBe(false);
  });

  it("probes the real filesystem for whether cells would share, and cleans up", () => {
    seedRepo();
    // on any dev machine this repo lives on a cloning filesystem (APFS, btrfs,
    // xfs, ext4); the assertion that matters everywhere is that the probe leaves
    // nothing behind, since it writes inside the user's workspace
    ignoredDirsWouldBeShared(ws);
    expect(existsSync(join(ws, ".ralphrun", "cow-probe"))).toBe(false);
  });

  it("assumes the unsafe answer when it cannot probe at all", () => {
    // no repo, no writable workspace: a probe that cannot run must not report
    // "isolated", because that is the answer that lets the hazard through
    expect(ignoredDirsWouldBeShared(join(ws, "nope", "\0bad"))).toBe(true);
  });
});
