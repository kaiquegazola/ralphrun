// git.integration.test.ts — REAL repositories. git.test.ts mocks spawnSync, so
// it proves the ARGUMENTS are right and nothing else. This is the test that
// proves the behaviour: that a commit carries the task's files and leaves the
// user's own uncommitted work alone.
//
// It is the only check that would catch git changing the meaning of
// --pathspec-from-file, a stray rename detection resurrecting a deleted path, or
// a baseline that quietly includes what was already dirty.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureReviewBase, commitPaths, headCommit, taskChangedPaths } from "./git.js";
import {
  claimRunLock,
  claimWithoutLink,
  cloneDir,
  createTaskWorktree,
  dropOwnClaim,
  evictLock,
  ignoredDirsWouldBeShared,
  linkedDirsPresent,
  mergeBackTaskWork,
  publishClaim,
  reapOrphanWorktrees,
  releaseRunLock,
  removeTaskWorktree,
  seedIgnoredDir,
  stampLockOnce,
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
  const lockPath = (): string => join(ws, ".ralphrun", "run.lock");

  /** write a lock by hand, the way another run would have left it */
  function plantLock(body: string): void {
    mkdirSync(join(ws, ".ralphrun"), { recursive: true });
    writeFileSync(lockPath(), body);
  }

  function readLockFile(): { pid: number; stamp: number; since: number } {
    return JSON.parse(readFileSync(lockPath(), "utf8"));
  }

  // a run that stops holding the lock must also stop stamping it: the heartbeat
  // is module state, so a test that claimed and never released would keep
  // re-creating the next test's lock underneath it
  afterEach(() => releaseRunLock(ws));

  it("refuses a second run and names the pid holding the workspace", () => {
    // a DIFFERENT pid that is genuinely alive — our parent. Reusing our own
    // would take the idempotent path and prove nothing.
    plantLock(JSON.stringify({ pid: process.ppid, stamp: Date.now() }));
    expect(claimRunLock(ws)).toBe(process.ppid);
  });

  it("is idempotent for the process that already holds it", () => {
    expect(claimRunLock(ws)).toBeNull();
    expect(claimRunLock(ws)).toBeNull();
  });

  it("takes over a lock whose holder is gone, without needing a manual rm", () => {
    // a crash leaves the file behind; requiring the user to delete it would make
    // every crash need a manual step before the next run
    plantLock(JSON.stringify({ pid: 999999, stamp: Date.now() })); // no such pid
    expect(claimRunLock(ws)).toBeNull();
    expect(readLockFile().pid).toBe(process.pid);
  });

  // THE pid-reuse case, and the reason the stamp exists at all. A crashed run
  // leaves its pid behind; the OS hands that number to something unrelated —
  // on Windows within minutes — and a pid-only check then reports a live
  // holder that never heard of ralphrun. That refuses every future run in the
  // workspace until someone deletes the file by hand.
  it("takes over a live pid that stopped stamping (a recycled pid)", () => {
    plantLock(JSON.stringify({ pid: process.ppid, stamp: Date.now() - 10 * 60_000 }));
    expect(claimRunLock(ws)).toBeNull();
    expect(readLockFile().pid).toBe(process.pid);
  });

  it("keeps refusing a live holder whose stamp is merely a little old", () => {
    // the slack is deliberate: a run busy spawning agents must not have its own
    // claim declared stale under it between two beats
    plantLock(JSON.stringify({ pid: process.ppid, stamp: Date.now() - 30_000 }));
    expect(claimRunLock(ws)).toBe(process.ppid);
  });

  it("refuses a live holder on a legacy bare-pid lock", () => {
    // written by an older ralphrun: no stamp to compare, so the old pid-only
    // answer stands. Refusing is the conservative half of that trade.
    plantLock(String(process.ppid));
    expect(claimRunLock(ws)).toBe(process.ppid);
  });

  it("takes over a legacy bare-pid lock whose holder is gone", () => {
    plantLock("999999");
    expect(claimRunLock(ws)).toBeNull();
    expect(readLockFile().pid).toBe(process.pid);
  });

  it("takes over a corrupt lock instead of refusing every run forever", () => {
    // one unreadable file must not be a workspace that can never run again —
    // that manual rm is the whole thing the lock exists to avoid
    plantLock("{not json at all");
    expect(claimRunLock(ws)).toBeNull();
    expect(readLockFile().pid).toBe(process.pid);
  });

  it("takes over a JSON lock whose stamp is garbled, rather than reading it as legacy", () => {
    // a record with a stamp we cannot read is CORRUPT, and corrupt is takeable.
    // Falling back to the pid-only answer instead gave one garbled field the
    // power to pin the workspace shut for as long as an unrelated process
    // happens to hold that pid — the manual rm again, by another route.
    plantLock(JSON.stringify({ pid: process.ppid, stamp: "soon" }));
    expect(claimRunLock(ws)).toBeNull();
    expect(readLockFile().pid).toBe(process.pid);
  });

  it("leaves no temp file and no half-written record behind", () => {
    // the record is swapped in by rename, never truncated and refilled in place:
    // a reader that catches the seam calls the file corrupt, and corrupt is
    // takeable — so an in-place refresh invites the eviction of a live claim
    claimRunLock(ws);
    stampLockOnce(lockPath());
    expect(readdirSync(join(ws, ".ralphrun"))).toEqual(["run.lock"]);
    expect(readLockFile().pid).toBe(process.pid);
  });

  // Two runs that read the SAME expired record both conclude it is theirs to
  // take. Overwriting it told BOTH of them they had won, and each one's boot
  // reap then force-deletes the other's live cells. So the takeover is a rename,
  // which only one racer can win — and this is the LOSER's half, the half that
  // used to do the damage: by the time it acts, the winner's claim is in place.
  describe("evicting a claim to take the workspace over", () => {
    it("puts back a claim that turned out to be live, and names its holder", () => {
      // what the winner wrote in the window between our read and our move
      plantLock(JSON.stringify({ pid: process.ppid, stamp: Date.now(), since: Date.now() }));
      const winner = readLockFile();

      expect(evictLock(lockPath())).toBe(process.ppid);
      expect(readLockFile()).toEqual(winner); // untouched, byte for byte
    });

    // The move leaves the path ABSENT for an instant, and a third run can win it
    // with `wx` in there — it has already been told it holds the workspace by
    // the time we look again. Renaming our copy back over its record used to
    // take that lock away from it: the file then named a run that was not the
    // claimant while the claimant went on reaping, so the file agreed with
    // nobody. The put-back is a LINK, which refuses an occupied path.
    it("leaves a claim made in the window it opened standing, rather than restoring over it", () => {
      plantLock(JSON.stringify({ pid: process.ppid, stamp: Date.now(), since: Date.now() }));
      const third = JSON.stringify({ pid: process.ppid + 1, stamp: Date.now(), since: Date.now() });
      // the window itself, which cannot be opened from outside
      const take = (from: string, to: string): void => {
        renameSync(from, to);
        writeFileSync(from, third); // a third run claims the path we just freed
      };

      expect(evictLock(lockPath(), take)).toBe(process.ppid);

      expect(readFileSync(lockPath(), "utf8")).toBe(third); // untouched, byte for byte
      expect(readdirSync(join(ws, ".ralphrun"))).toEqual(["run.lock"]); // and nothing set aside
    });

    it("frees the path when the claim really is dead", () => {
      plantLock(JSON.stringify({ pid: 999999, stamp: 0, since: 0 }));
      expect(evictLock(lockPath())).toBeNull();
      expect(existsSync(lockPath())).toBe(false);
    });

    it("has nothing to move once another run evicted it first", () => {
      expect(evictLock(lockPath())).toBeNull();
      expect(existsSync(lockPath())).toBe(false);
    });
  });

  // `wx` makes the directory ENTRY exclusive, not the RECORD: the file exists
  // EMPTY between the open and the write, an empty record reads as corrupt, and
  // corrupt is takeable — so a racing claimant evicts and deletes the very file
  // its owner is still filling, and both runs then hold the workspace while each
  // one's boot reap force-deletes the other's live cells.
  describe("publishing a new claim", () => {
    it("never makes an empty lock file visible while it is still being filled", () => {
      mkdirSync(join(ws, ".ralphrun"), { recursive: true });
      let seen: string | null | undefined;
      const put = (from: string, to: string): void => {
        // what a racing run would read at the last instant before we publish
        seen = existsSync(to) ? readFileSync(to, "utf8") : null;
        linkSync(from, to);
      };

      expect(publishClaim(lockPath(), Date.now(), put)).toBe(true);

      // create-then-fill left "" here, and "" is takeable
      expect(seen).toBeNull();
      expect(readLockFile().pid).toBe(process.pid);
      expect(readdirSync(join(ws, ".ralphrun"))).toEqual(["run.lock"]);
    });

    it("reports a taken path instead of replacing the claim standing on it", () => {
      plantLock(JSON.stringify({ pid: process.ppid, stamp: Date.now(), since: 1 }));
      const holder = readLockFile();

      expect(publishClaim(lockPath(), Date.now())).toBe(false);

      expect(readLockFile()).toEqual(holder); // untouched, byte for byte
      expect(readdirSync(join(ws, ".ralphrun"))).toEqual(["run.lock"]);
    });

    it("still claims where the filesystem cannot hard-link at all", () => {
      // FAT32, some network shares. The seam comes back with the fallback — but
      // so does every version before this one, and refusing to run there would
      // be far worse than the race the link closes.
      mkdirSync(join(ws, ".ralphrun"), { recursive: true });
      const noLinks = (): never => {
        throw Object.assign(new Error("no links here"), { code: "EPERM" });
      };

      expect(publishClaim(lockPath(), Date.now(), noLinks)).toBe(true);

      expect(readLockFile().pid).toBe(process.pid);
      expect(readdirSync(join(ws, ".ralphrun"))).toEqual(["run.lock"]);
    });

    // ...but the seam is real there, so the claim is CHECKED instead of assumed.
    // A racing claimant reads our empty file as corrupt, evicts it — a rename,
    // which moves the inode we are still filling out from under the path — and
    // publishes its own. Reporting a claim on top of that record is what leaves
    // two runs live, each one's boot reap force-deleting the other's cells.
    it("refuses when a racing run won the path while the record was still empty", () => {
      mkdirSync(join(ws, ".ralphrun"), { recursive: true });
      const raced = (path: string, body: string): void => {
        writeFileSync(path, body, { flag: "wx" }); // ours lands...
        // ...and the run that caught it empty has already taken the path
        writeFileSync(path, JSON.stringify({ pid: process.ppid, stamp: Date.now(), since: 1 }));
      };

      expect(claimWithoutLink(lockPath(), Date.now(), raced)).toBe(false);

      // and the winner's record is left exactly as it stands
      expect(readLockFile().pid).toBe(process.ppid);
    });

    it("claims when the record it reads back is its own", () => {
      mkdirSync(join(ws, ".ralphrun"), { recursive: true });
      expect(claimWithoutLink(lockPath(), Date.now())).toBe(true);
      expect(readLockFile().pid).toBe(process.pid);
    });

    // The same racing evict as above, one instant earlier: the racer has moved
    // our still-empty file aside and DELETED it, so our write lands in an inode
    // nothing points at and the path is simply gone. Reading "nothing here" as a
    // win is the outcome this whole function exists to refuse — the racer
    // publishes, we report a claim, and both runs hold the workspace.
    it("refuses when the record it wrote is no longer at the path at all", () => {
      mkdirSync(join(ws, ".ralphrun"), { recursive: true });
      const evicted = (path: string, body: string): void => {
        writeFileSync(path, body, { flag: "wx" }); // ours lands...
        rmSync(path, { force: true }); // ...and the racer took it away again
      };

      expect(claimWithoutLink(lockPath(), Date.now(), evicted)).toBe(false);
      expect(existsSync(lockPath())).toBe(false);
    });

    it("refuses a read-back it cannot attribute, which costs a pass and not a run", () => {
      // a torn record at our own path may be ours OR the racer's half-written
      // one, and there is no evidence here to tell them apart. claimRunLock
      // re-reads the path on its very next line and takes the idempotent branch
      // when it turns out to have been ours, so refusing here is free.
      mkdirSync(join(ws, ".ralphrun"), { recursive: true });
      expect(claimWithoutLink(lockPath(), Date.now(), (path) => writeFileSync(path, "{torn"))).toBe(false);
    });
  });

  it("stamps the claim it writes, so the next run can age it", () => {
    const before = Date.now();
    expect(claimRunLock(ws)).toBeNull();
    const { pid, stamp } = readLockFile();
    expect(pid).toBe(process.pid);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
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

  // Reading the pid and deleting the file are two operations, and our own stamp
  // may already be stale — so a run that judged it dead can evict our record and
  // put ITS OWN there in the gap. Deleting that leaves a live run holding a
  // workspace with no lock on it, and the next run walks in and reaps its cells
  // mid-edit. Hence the rename: what we moved is re-read before it is dropped.
  it("puts back a claim that replaced ours in the window before the delete", () => {
    claimRunLock(ws);
    const winner = JSON.stringify({ pid: process.ppid, stamp: Date.now(), since: Date.now() });
    // the window itself, which cannot be opened from outside
    const take = (from: string, to: string): void => {
      writeFileSync(from, winner);
      renameSync(from, to);
    };

    dropOwnClaim(lockPath(), take);

    expect(readFileSync(lockPath(), "utf8")).toBe(winner);
    expect(readdirSync(join(ws, ".ralphrun"))).toEqual(["run.lock"]); // and nothing set aside
  });

  it("leaves a claim made in the window it opened standing, rather than restoring over it", () => {
    // the same absent window as evictLock's, and the same rule: what we hand
    // back is only handed back into the hole we made
    claimRunLock(ws);
    const winner = JSON.stringify({ pid: process.ppid, stamp: Date.now(), since: Date.now() });
    const third = JSON.stringify({ pid: process.ppid + 1, stamp: Date.now(), since: Date.now() });
    const take = (from: string, to: string): void => {
      writeFileSync(from, winner); // a run overran our claim before the delete...
      renameSync(from, to);
      writeFileSync(from, third); // ...and a third took the path our move freed
    };

    dropOwnClaim(lockPath(), take);

    expect(readFileSync(lockPath(), "utf8")).toBe(third);
    expect(readdirSync(join(ws, ".ralphrun"))).toEqual(["run.lock"]);
  });

  // The put-back is for a claim that is FOREIGN AND STILL LIVE, which is the
  // same rule evictLock applies. This one used to put back any foreign record at
  // all, so a run that overran us and then died itself got its dead record
  // re-planted on the way out — and the next run paid an extra eviction pass to
  // clear litter we had already moved out of the way.
  it("does not replant a foreign record that is itself dead", () => {
    claimRunLock(ws);
    const dead = JSON.stringify({ pid: 999999, stamp: Date.now(), since: Date.now() });
    const take = (from: string, to: string): void => {
      writeFileSync(from, dead);
      renameSync(from, to);
    };

    dropOwnClaim(lockPath(), take);

    expect(existsSync(lockPath())).toBe(false);
    expect(readdirSync(join(ws, ".ralphrun"))).toEqual([]);
  });

  it("drops its own claim through that same move", () => {
    claimRunLock(ws);
    dropOwnClaim(lockPath());
    expect(existsSync(lockPath())).toBe(false);
    expect(readdirSync(join(ws, ".ralphrun"))).toEqual([]);
  });

  // A claim that is not refreshed goes stale under its own holder and invites a
  // second run to reap its live cells, so the beat has to keep stamping. What it
  // must NEVER do is stamp a lock it no longer owns: the earlier version stopped
  // only on a positively-read foreign pid and re-wrote the file on every other
  // outcome, so a lock that was GONE came back — a claim for a run whose cells
  // no longer exist, refusing (or reaping) the next legitimate run at that path.
  describe("the heartbeat that keeps a claim alive", () => {
    it("re-stamps a lock that is still ours", () => {
      // CLAIMED first, which is the production shape: a beat only ever runs
      // inside a run that holds the lock, and a test that stamps without one
      // exercises a state startLockHeartbeat cannot produce.
      claimRunLock(ws);
      const stale = Date.now() - 60_000;
      plantLock(JSON.stringify({ pid: process.pid, stamp: stale }));
      const before = Date.now();

      expect(stampLockOnce(lockPath())).toBe("stamped");

      // MOVED FORWARD, which is the whole reason a beat exists: this number is
      // what the next run reads to decide we are still here
      const { pid, stamp } = readLockFile();
      expect(pid).toBe(process.pid);
      expect(stamp).toBeGreaterThanOrEqual(before);
    });

    it("stands down instead of stamping a lock another run now holds", () => {
      plantLock(JSON.stringify({ pid: process.ppid, stamp: Date.now() }));
      expect(stampLockOnce(lockPath())).toBe("lost");
      // and the overrunning run's claim is left exactly as it found it
      expect(readLockFile().pid).toBe(process.ppid);
    });

    // A beat is read-then-write and no filesystem here makes that one operation,
    // so a run whose event loop was blocked past the stale window can wake, read
    // the record it wrote before it froze, be legitimately overrun in the
    // microseconds that follow, and stamp its DEAD claim back on top of the live
    // one. `since` is what tells the two apart: it never moves while a claim is
    // held, so the older `since` is the older claim, whatever pid is on the file.
    it("re-asserts when a run it replaced writes its own dead claim back on top", () => {
      claimRunLock(ws); // we are the run that legitimately took over
      const ours = readLockFile();
      plantLock(JSON.stringify({ pid: process.ppid, stamp: Date.now(), since: ours.since - 60_000 }));

      expect(stampLockOnce(lockPath())).toBe("stamped");

      // Standing down here instead is the damage: the zombie reads its own pid
      // and keeps beating, while the run that actually holds the workspace stops
      // — and its live cells age into orphans the next run reaps out from under
      // its executors.
      expect(readLockFile().pid).toBe(process.pid);
      expect(readLockFile().since).toBe(ours.since);
    });

    it("still stands down for a claim made after its own", () => {
      claimRunLock(ws);
      const ours = readLockFile();
      plantLock(JSON.stringify({ pid: process.ppid, stamp: Date.now(), since: ours.since + 60_000 }));

      expect(stampLockOnce(lockPath())).toBe("lost");
      expect(readLockFile().pid).toBe(process.ppid);
    });

    it("does not recreate a lock file that is gone", () => {
      // deleted by hand, or the whole workspace directory went away and came
      // back. Either way this process owns nothing at that path any more, and
      // re-creating the file plants a ghost claim for a run with no cells left.
      claimRunLock(ws);
      unlinkSync(lockPath());
      expect(stampLockOnce(lockPath())).toBe("lost");
      expect(existsSync(lockPath())).toBe(false);
    });

    it("does not rebuild a workspace directory that was removed under it", () => {
      claimRunLock(ws);
      rmSync(join(ws, ".ralphrun"), { recursive: true, force: true });
      expect(stampLockOnce(lockPath())).toBe("lost");
      expect(existsSync(join(ws, ".ralphrun"))).toBe(false);
    });

    it("repairs a corrupt lock at its own path rather than abandoning the claim", () => {
      // a file that EXISTS but makes no sense is a torn write or a read we lost,
      // not a claim someone else took — and letting it stand would age out a
      // perfectly healthy run's lock over one bad read
      claimRunLock(ws); // the claim this repair is FOR — the whole production shape
      const ours = readLockFile();
      plantLock("{not json at all");

      expect(stampLockOnce(lockPath())).toBe("stamped");

      expect(readLockFile().pid).toBe(process.pid);
      // the REPAIR keeps the claim it repairs: minting a fresh `since` here
      // would make the beat look like a newer claim than the one it belongs to,
      // and the zombie rule reads `since` to tell those two apart
      expect(readLockFile().since).toBe(ours.since);
    });

    it("writes nothing at all when this process holds no claim", () => {
      // "refresh, never resurrect" from the other side: a beat that stamped a
      // file it never claimed would mint a fresh `since` for somebody else's
      // record. Unreachable from startLockHeartbeat, which is only ever started
      // by a successful claim — and that is exactly why it must not be a write.
      plantLock(JSON.stringify({ pid: process.pid, stamp: 0, since: 0 }));

      expect(stampLockOnce(lockPath())).toBe("lost");

      expect(readLockFile().stamp).toBe(0);
    });

    it("stops beating for good once the lock is gone, rather than resurrecting it", () => {
      // the wiring, not just the decision: "lost" has to clear the interval, or
      // the very next beat plants the file again ten seconds later
      vi.useFakeTimers();
      try {
        claimRunLock(ws);
        vi.advanceTimersByTime(30_000); // several beats while we legitimately hold it
        expect(readLockFile().pid).toBe(process.pid);

        unlinkSync(lockPath());
        vi.advanceTimersByTime(120_000);
        expect(existsSync(lockPath())).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// A CONFIGURED worktree_link is not a SHARED tree: seedIgnoredDir puts nothing
// in a cell for a directory the workspace does not have, so the boot refusal has
// to ask what is actually there — it refused the safest configuration there is
// (no node_modules at all, every cell installing its own) for a hazard that
// could not happen.
describe("which of the linked directories are actually there", () => {
  it("keeps only the names the workspace really has", () => {
    mkdirSync(join(ws, "node_modules"), { recursive: true });
    expect(linkedDirsPresent(ws, ["node_modules", ".venv"])).toEqual(["node_modules"]);
    expect(linkedDirsPresent(ws, [".venv"])).toEqual([]);
    expect(linkedDirsPresent(ws, [])).toEqual([]);
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

  it("never throws when the cell cannot be deleted", () => {
    // Windows is the case this stands for: a worktree_setup whose install was
    // just killed leaves its process tree holding a handle in the tree, and the
    // rm comes back EBUSY/EPERM. Every caller here is DROPPING the cell — a task
    // that blocked, was skipped, quit, or whose setup failed — and most of them
    // sit outside any try/finally, so a throw turns a degradation into a crashed
    // run and leaks the very cell it was called to remove. The only removal
    // failure a test can force on every platform is a path the runtime refuses
    // outright, but the guard it proves is the same one.
    expect(() => removeTaskWorktree(ws, join(ws, "cell" + String.fromCharCode(0) + "name"))).not.toThrow();
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
    // the answer depends on the filesystem under this checkout (APFS and btrfs
    // clone, NTFS and ext4 without reflink do not), so what is asserted
    // everywhere is that the probe leaves nothing behind — it writes inside the
    // user's workspace AND inside their real node_modules
    ignoredDirsWouldBeShared(ws, ["node_modules"]);
    expect(readdirSync(join(ws, "node_modules"))).toEqual(["dep"]);
    expect(existsSync(join(ws, ".ralphrun", "worktrees", ".ralphrun-cow-probe"))).toBe(false);
  });

  // The probe used to clone an EMPTY directory, and `cp -R --reflink=always`
  // reflinks regular files while merely creating directories — so it copied
  // nothing, exited 0, and reported NTFS as clone-capable. The refusal it feeds
  // was dead on the one platform it was built for, and this test passed anyway.
  it("clones a real file, from inside the linked directory, into where a cell lands", () => {
    seedRepo();
    const seen: { src: string; dst: string; files: string[] }[] = [];

    ignoredDirsWouldBeShared(ws, ["node_modules"], (src, dst) => {
      seen.push({ src, dst, files: readdirSync(src) });
      return true;
    });

    // INSIDE node_modules, not next to .ralphrun: a reflink needs one
    // filesystem, and node_modules is routinely a junction onto another volume
    expect(seen[0]?.src.startsWith(join(ws, "node_modules"))).toBe(true);
    // ...and into a cell's own parent, which is the other half of that pair
    expect(seen[0]?.dst.startsWith(join(ws, ".ralphrun", "worktrees"))).toBe(true);
    // the assertion that would have caught it: an empty tree proves nothing
    expect(seen[0]?.files).not.toEqual([]);
  });

  it("asks per linked directory, and one shared tree is enough", () => {
    seedRepo();
    mkdirSync(join(ws, ".venv"), { recursive: true });
    const asked: string[] = [];
    // the second name is the one on the filesystem that cannot clone — a probe
    // that answered once for the workspace would have missed it entirely
    const clone = (src: string): boolean => {
      asked.push(src);
      return !src.includes(".venv");
    };

    expect(ignoredDirsWouldBeShared(ws, ["node_modules", ".venv"], clone)).toBe(true);
    expect(asked).toHaveLength(2);
    expect(ignoredDirsWouldBeShared(ws, ["node_modules"], clone)).toBe(false);
  });

  // The probe writes INSIDE the linked directory, and its mkdir is not
  // recursive on purpose: with `recursive: true` a name the workspace does not
  // have was created as a side effect of asking about it, and the cleanup only
  // removed the probe directory — so asking left an empty `.venv` behind that
  // the user never had. The name is unprobeable, so it keeps the unsafe answer.
  it("never conjures a linked directory the workspace does not have", () => {
    seedRepo();
    expect(ignoredDirsWouldBeShared(ws, [".venv"])).toBe(true);
    expect(existsSync(join(ws, ".venv"))).toBe(false);
  });

  it("assumes the unsafe answer when it cannot probe at all", () => {
    // no repo, no writable workspace: a probe that cannot run must not report
    // "isolated", because that is the answer that lets the hazard through
    expect(ignoredDirsWouldBeShared(join(ws, "nope", "\0bad"), ["node_modules"])).toBe(true);
  });
});
