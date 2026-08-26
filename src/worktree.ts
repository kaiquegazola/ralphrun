// worktree.ts — a disposable git worktree per task, and the cherry-pick that
// brings its work back into the main workspace.
//
// The point is READ isolation, not write isolation. Two tasks with no
// dependency between them and overlapping `scope` are already refused at load
// (overlappingScopePairs), so executors do not write the same file. But a
// `verify` command shells `tsc` / `npm test` with cwd set to the workspace, and
// those read the WHOLE project — a task's gate would observe files it never
// asked about even with disjoint scopes. Do not "optimize" the worktree away
// for tasks whose scopes do not overlap; the scopes are not what it is for.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { git, gitOut, headCommit } from "./git.js";

const WORKTREES = join(".ralphrun", "worktrees");

export type MergeBackStatus = "ok" | "conflict" | "dirty" | "nothing";

/** how a gitignored directory got into a cell — "linked" is the SHARED one */
export type SeedResult = "cloned" | "linked" | "absent";

/**
 * The clone flags for a platform. Exported because they are the whole mechanism
 * and they are not interchangeable: BSD `cp` has no --reflink and GNU `cp` has
 * no -c, so the wrong arm does not clone slowly — it fails outright, silently
 * dropping every cell back to a shared symlink.
 */
export function cloneArgs(platform: string, src: string, dst: string): string[] {
  // -c is APFS clonefile; --reflink=always is btrfs/xfs/ext4. Both FAIL rather
  // than falling back to a byte copy, which is the point: a silent 400MB copy
  // per task would look like a hang.
  return platform === "darwin" ? ["-c", "-R", src, dst] : ["-R", "--reflink=always", src, dst];
}

/**
 * The link flavour a platform needs for a DIRECTORY.
 *
 * Exported for the same reason as cloneArgs: it is the whole mechanism, and the
 * wrong arm does not degrade — on Windows a plain directory symlink throws EPERM
 * for an unelevated user, which is not a slower cell but no cell at all.
 */
export function linkKind(platform: string): "junction" | undefined {
  return platform === "win32" ? "junction" : undefined;
}

/**
 * Copy-on-write clone of a directory: the whole tree in constant time, sharing
 * blocks with the original until something writes.
 *
 * This is what makes per-task `node_modules` affordable — a plain recursive copy
 * of a real dependency tree is hundreds of megabytes and tens of seconds per
 * task. Refuses rather than degrading to a slow copy: the caller has a cheaper
 * fallback and needs to KNOW which one it got, and a silent 400MB copy per task
 * would look like a hang.
 */
export function cloneDir(src: string, dst: string): boolean {
  return spawnSync("cp", cloneArgs(process.platform, src, dst), { stdio: "ignore" }).status === 0;
}

/**
 * Put a gitignored directory (node_modules and friends) into a fresh cell.
 *
 * A worktree holds TRACKED files only, so these are absent and `verify: "npm
 * test"` fails on every task before anything interesting runs. The fix used to
 * be a symlink at the real directory, which made every cell share ONE dependency
 * tree: a wave whose verify runs `npm ci` had two installs mutating the user's
 * real tree at once, and no worktree discard rolls that back.
 *
 * A clone is the same convenience with none of the sharing. The symlink survives
 * only as the fallback for a filesystem without copy-on-write, and the result
 * says which it got — but the boot refusal does NOT read it: it re-probes with
 * ignoredDirsWouldBeShared, because it has to answer before any cell exists. So
 * the return is an observation for callers and tests that need to know after the
 * fact, and nothing in the run branches on it.
 */
export function seedIgnoredDir(
  workspace: string,
  dir: string,
  name: string,
  /** injected only by tests: a filesystem that clones cannot exercise the fallback */
  clone: (src: string, dst: string) => boolean = cloneDir,
): SeedResult {
  const src = join(workspace, name);
  const dst = join(dir, name);
  if (!existsSync(src) || existsSync(dst)) return "absent";
  if (clone(src, dst)) return "cloned";
  // A failed clone is not always a clone that wrote nothing: GNU cp creates the
  // destination directory and only then discovers the filesystem cannot reflink,
  // so the fallback below would hit EEXIST — on exactly the filesystems the
  // fallback exists for. Whatever it left is a fragment of a copy nobody wants.
  rmSync(dst, { recursive: true, force: true });
  // "junction" on Windows, and it is not a nicety: a DIRECTORY symlink there
  // needs elevation or Developer Mode, so plain symlinkSync throws EPERM for an
  // ordinary user — and since NTFS cannot reflink either, that left Windows with
  // no way at all to seed a cell. A junction needs no privilege and behaves the
  // same for this purpose. It is also why the type is passed explicitly rather
  // than left to node's guess, which would pick "file" for a missing target.
  //
  // Left to throw on purpose when even that fails: createTaskWorktree catches it
  // and the task degrades to the main workspace. A cell seeded with NEITHER
  // shape has no dependencies, so every verify in it fails — calling that a
  // usable worktree would burn the task's whole retry budget on an empty tree.
  symlinkSync(src, dst, linkKind(process.platform));
  return "linked";
}

/**
 * A detached worktree at HEAD, or `null` when isolation is not available: no
 * repository, or a repository with no commit yet (prepareRun inits one).
 *
 * `null` means "run this task in the main workspace" — it must never be scored
 * as a task failure, which would burn the task's retry budget on a problem the
 * task cannot fix.
 */
export function createTaskWorktree(workspace: string, taskId: string, links: string[]): string | null {
  const base = headCommit(workspace);
  if (!base) return null;
  const dir = worktreePath(workspace, taskId);
  try {
    excludeRalphrunDir(workspace);
    // a leftover directory or a stale administrative entry both make `add` refuse
    rmSync(dir, { recursive: true, force: true });
    git(workspace, "worktree", "prune");
    if (git(workspace, "worktree", "add", "--detach", dir, base) !== 0) return null;
    for (const name of links) seedIgnoredDir(workspace, dir, name);
    return dir;
  } catch {
    return null;
  }
}

/**
 * Of the names configured for seeding, the ones the workspace ACTUALLY has.
 *
 * A configured `worktree_link` is not by itself a shared tree: seedIgnoredDir
 * returns "absent" for a name the workspace does not have and puts nothing in
 * the cell, so on a checkout with no node_modules every cell's setup builds a
 * dependency tree of its very own and there is nothing to corrupt.
 *
 * Filtering on the same condition the seeding uses is what keeps the boot
 * refusal honest — it refused the safest configuration there is (empty tree,
 * `worktree_setup: "npm ci"`) for a hazard that could not happen, and sent the
 * user editing config to fix it.
 */
export function linkedDirsPresent(workspace: string, links: string[]): string[] {
  return links.filter((name) => existsSync(join(workspace, name)));
}

/** the probe's own directory, inside a linked tree and inside a cell's parent */
const PROBE = ".ralphrun-cow-probe";

/**
 * Would these gitignored directories be SHARED between cells?
 *
 * Answered by trying the real thing in the real place — a clone can fail for the
 * filesystem, the platform, or a `cp` that does not take the flag, and only an
 * attempt distinguishes those from a guess. True is what makes a wave whose
 * verify installs unsafe, so this is the probe behind that refusal rather than a
 * platform check.
 *
 * Two things make a probe MEAN anything, and the first version had neither.
 *
 * It must clone a real FILE. `cp -R --reflink=always` reflinks regular files and
 * merely CREATES directories, so cloning an empty tree copies nothing, exits 0,
 * and reports every filesystem on earth as clone-capable — NTFS included, which
 * is the exact platform this refusal exists for. The guard was dead on Windows,
 * and the test that covered it passed.
 *
 * And it must clone BETWEEN THE TWO PLACES the seeding uses: out of the linked
 * directory, into where a cell lands. A reflink needs one filesystem, and
 * `node_modules` is routinely a junction or a mount onto another volume while
 * `.ralphrun` sits on the repo's own — probing inside `.ralphrun` alone answers
 * for a copy nobody performs, and every cell then gets the shared symlink the
 * caller was told could not happen.
 *
 * `clone` is injected only by tests: a machine either reflinks or does not, so
 * both answers cannot be exercised on one filesystem.
 */
export function ignoredDirsWouldBeShared(
  workspace: string,
  links: string[],
  clone: (src: string, dst: string) => boolean = cloneDir,
): boolean {
  // Where a CELL lands, because the destination's filesystem is half of what
  // decides whether a reflink is possible at all.
  const dst = join(workspace, WORKTREES, PROBE);
  const clean = (src: string): void => {
    // its own guard: a cleanup that throws would REPLACE the answer the catch
    // below already decided, turning "assume shared" into a crash
    for (const path of [src, dst]) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* a probe directory we could not remove is not worth failing a run over */
      }
    }
  };
  // Per NAME, not once: two linked directories can live on two filesystems, and
  // one shared tree is enough to corrupt. No names is no seeding and so nothing
  // to share. The probe adds a directory inside the linked tree for an instant
  // and never conjures the tree itself — the mkdir below is NOT recursive, so a
  // name the workspace does not have throws ENOENT and keeps the unsafe answer
  // rather than leaving an empty `node_modules` behind as a side effect of
  // asking. (The caller filters with linkedDirsPresent, but that is then an
  // optimisation rather than a precondition this function relies on.)
  for (const name of links) {
    const src = join(workspace, name, PROBE);
    // The unsafe answer stands unless the probe positively disproves it, so a
    // throw anywhere below leaves it. Written as a variable rather than a
    // `finally` because the cleanup has to run on BOTH paths and a `return`
    // inside `try` makes that an implicit branch nothing can exercise.
    let shared = true;
    try {
      clean(src);
      mkdirSync(src);
      // the cell's parent may not exist yet at boot; `cp` needs it to
      mkdirSync(join(workspace, WORKTREES), { recursive: true });
      writeFileSync(join(src, "probe"), "ralphrun cow probe\n");
      shared = !clone(src, dst);
    } catch {
      /* cannot even probe: keep the unsafe answer */
    }
    clean(src);
    if (shared) return true;
  }
  return false;
}

/**
 * Cherry-pick `base..worktreeHead` into the main workspace.
 *
 * A RANGE, not a single sha: executors commit on their own (loop.ts logs when
 * they do) and a single-sha pick would silently drop those commits. An EMPTY
 * range is not a no-op to git — `cherry-pick a..a` exits 128 — hence the guard.
 *
 * This survives a dirty trunk on purpose: ralphrun is built to run on one (it
 * is the whole reason captureReviewBase exists), so a clean-tree precondition
 * would disable the feature for the common case.
 */
export function mergeBackTaskWork(
  workspace: string,
  dir: string,
  base: string | null,
): { status: MergeBackStatus; head: string | null } {
  const head = headCommit(dir);
  if (!base || !head || head === base) return { status: "nothing", head };
  if (git(workspace, "cherry-pick", `${base}..${head}`) === 0) return { status: "ok", head };
  // Two very different failures, and which one it is decides retry vs block.
  // A pick that STARTED and hit a textual conflict leaves CHERRY_PICK_HEAD
  // behind: work landed first, and a retry cut from the new HEAD can win. One
  // git refused outright — the user has that file uncommitted, so applying it
  // would overwrite their work — never gets that far, and no number of retries
  // moves their edit out of the way.
  //
  // NOT the abort's exit status: a RANGE pick writes .git/sequencer either way,
  // so `--abort` returns 0 for both (verified on git 2.50).
  const started = !!gitOut(workspace, "rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD");
  git(workspace, "cherry-pick", "--abort");
  return { status: started ? "conflict" : "dirty", head };
}

/**
 * What removing this worktree would throw away. Discarding a cell is the
 * rollback the serial loop never had, but it must not be silent: a commit
 * survives in the shared object database and is recoverable by sha, while
 * whatever the executor left uncommitted does not survive the removal.
 */
export function worktreeLoss(dir: string, base: string | null): { head: string | null; dirty: boolean } {
  const head = headCommit(dir);
  return { head: head && head !== base ? head : null, dirty: !!gitOut(dir, "status", "--porcelain") };
}

/**
 * --force because the executor leaves build output behind and the seeded
 * directories make the tree look dirty.
 *
 * Safe for BOTH seeding shapes, which is worth a test because getting it wrong
 * deletes the user's dependencies: a clone is this cell's own copy and removing
 * it is the point, and on the symlink fallback `rm` unlinks the link rather than
 * following it into the real directory.
 *
 * Never throws, and that is not defensive habit: every caller is on a path where
 * the cell is being DROPPED — a task that blocked, was skipped, quit, crashed,
 * or whose worktree_setup failed — and most of them are outside any try/finally,
 * so a throw here turns a degradation into a crashed run and leaks the very cell
 * it was called to remove. Windows hands out EBUSY/EPERM for exactly this shape:
 * a just-killed install's process tree still holding a handle in the tree.
 */
export function removeTaskWorktree(workspace: string, dir: string): void {
  try {
    git(workspace, "worktree", "remove", "--force", dir);
    // The retries ARE the fix for the common Windows case — the handle is
    // released a moment after the process dies, so backing off clears it — and
    // what survives them is litter the next boot's reapOrphanWorktrees retries.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* a cell we could not delete is not a reason to fail the run that dropped it */
  }
}

/**
 * THE RUN LOCK, as one protocol rather than as a sequence of rebuttals.
 *
 *   1. A claim is a JSON record `{pid, stamp, since}` at .ralphrun/run.lock.
 *   2. It is HELD while its pid is alive and its stamp is younger than
 *      LOCK_STALE_MS; the holder re-stamps every HEARTBEAT_MS (startLockHeartbeat).
 *   3. It is PUBLISHED by writing the whole record elsewhere and moving it onto a
 *      FREE path in one step (publishClaim), never by creating an empty file and
 *      filling it — an empty record reads as corrupt, and corrupt is takeable.
 *   4. A claim judged dead is TAKEN OVER by renaming it aside, re-reading what
 *      was actually moved, and putting it back if it turned out to be live
 *      (evictLock, dropOwnClaim, restoreClaim). A rename can only be won once; an
 *      overwrite tells every racer it won.
 *   5. `since` never moves while a claim is held, so it — not the pid — settles
 *      ties between a live run and the zombie it replaced (wroteOverOurClaim).
 *
 * Every function below is one of those five sentences, and each one's docblock
 * names the single hazard it owns.
 */
const LOCK = join(".ralphrun", "run.lock");

/**
 * How often the holder re-stamps its lock, and how long a stamp stays trusted.
 *
 * The gap between them is deliberate slack, not a round number: a run whose
 * event loop is busy spawning agents must never have its own claim declared
 * stale under it, so the trust window is an order of magnitude wider than the
 * beat. Widening it costs only how long a CRASHED run's pid stays believable
 * once something else inherits that pid.
 */
const HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 120_000;

/**
 * What the lock file holds.
 *
 * `stamp: null` is a lock an older ralphrun wrote — the whole file was the pid.
 * `since` is when the claim BEGAN and never moves while it is held, so it is an
 * identity for the CLAIM where the pid is only an identity for the process, and
 * pid reuse is exactly what makes that distinction load-bearing. It is null on a
 * record written before the field existed.
 */
interface LockRecord {
  pid: number;
  stamp: number | null;
  since: number | null;
}

/** The live claim's refresher. Module state because the lock is: one per process. */
let beat: NodeJS.Timeout | undefined;

/** When THIS process's claim began; 0 = we hold nothing. Cleared on release. */
let claimedAt = 0;

function lockBody(since: number): string {
  return JSON.stringify({ pid: process.pid, stamp: Date.now(), since });
}

/**
 * Replace whatever is at `file` with our record, in ONE step.
 *
 * Write-then-rename rather than a write in place: `writeFileSync` truncates
 * before it fills, and a reader that catches the file in between sees a record
 * that makes no sense — which this module classifies as corrupt, and corrupt is
 * TAKEABLE. So an in-place refresh of a perfectly live claim is an invitation to
 * evict it. A rename swaps the whole file, so every reader sees either the old
 * record or the new one and never the seam.
 */
function writeLock(file: string, since: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, lockBody(since));
    renameSync(tmp, file);
  } catch {
    // Windows refuses a rename while anything at all holds the target open — a
    // scanner, another run mid-read. Keeping the claim matters more than the
    // atomicity of this one write, and an in-place write is what every version
    // before this one did, so the fallback is a step back and not a new risk.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* a temp file we could not remove is litter, never a reason to fail */
    }
    writeFileSync(file, lockBody(since));
  }
}

/**
 * publishClaim's fallback for a filesystem with no hard links (FAT32, some
 * network shares), where the seam it exists to close cannot be closed: nothing
 * there puts a whole record at a fresh path in one step, so `wx` makes the ENTRY
 * exclusive and the file sits EMPTY until the write lands.
 *
 * What can still be done is to stop BELIEVING the claim. A claimant that caught
 * the file empty reads it as corrupt, evicts it — a rename, which moves the
 * inode we are still filling out from under the path — and publishes its own
 * record; our own write then completes into a file nobody can see and we would
 * report a claim we never won. Two runs then hold the workspace, and each one's
 * boot reap force-deletes the other's live cells while its executors write into
 * them.
 *
 * So the read-back is believed ONLY when it positively names us. The two empty
 * answers are both losses, and each is reachable: "missing" is precisely the
 * racing evict above (renamed aside, judged corrupt, deleted) — counting it as a
 * win is what left both runs holding the workspace — and "unreadable" is a
 * record we cannot attribute, which may be the racer's own half-written one.
 * Refusing costs a pass and never a run: claimRunLock re-reads the path on the
 * very next line and takes the idempotent branch when the record turns out to
 * have been ours after all.
 *
 * `write` is injected only by tests — the whole subject is what another run does
 * BETWEEN the create and the read, and that window cannot be opened from
 * outside. Exported for those tests only; nothing in production imports it.
 */
export function claimWithoutLink(
  file: string,
  since: number,
  write: (path: string, body: string) => void = (path, body) => writeFileSync(path, body, { flag: "wx" }),
): boolean {
  write(file, lockBody(since));
  const back = inspectLock(file);
  return back.kind === "read" && back.rec.pid === process.pid;
}

/**
 * Put a NEW claim at `file`, or report that the path is already taken.
 *
 * `wx` alone is not this, and the difference is the whole reason this function
 * exists: create-exclusive makes the directory ENTRY atomic, not the record. The
 * file exists EMPTY between the open and the write, and an empty record reads as
 * corrupt — which this module treats as takeable. A racing claimant that catches
 * that instant evicts the file its owner is still filling and deletes it, its
 * own `wx` then succeeds, and two runs hold the workspace while each one's boot
 * reap force-deletes the other's live cells.
 *
 * Writing the record to a temp file and LINKING it into place closes it: the
 * path goes from absent to whole in one step, and `link` refuses an existing
 * target, so it is exactly as exclusive as `wx` was. It is the same doctrine as
 * writeLock's write-then-rename — no reader ever sees a seam — applied to the
 * one write that was still doing it the other way.
 *
 * Falls back to `wx` where the filesystem has no hard links (FAT32, some network
 * shares), and reads the path back before calling that a claim: the write cannot
 * be made atomic there, but publishing a claim we did not actually win can be
 * refused, and "two runs both told they hold it" is the outcome that matters.
 *
 * `put` is injected only by tests. The window this closes is a race, and the
 * only way to assert it is gone is to look at the path at the instant before the
 * record becomes visible. Exported for those tests only; nothing in production
 * imports it.
 */
export function publishClaim(
  file: string,
  since: number,
  put: (from: string, to: string) => void = linkSync,
): boolean {
  const tmp = `${file}.${process.pid}.new`;
  try {
    writeFileSync(tmp, lockBody(since));
    put(tmp, file);
    return true;
  } catch (e) {
    // EEXIST is the answer this function exists to give: someone else holds the
    // path. Anything else is a filesystem that cannot link at all, and refusing
    // every run there would be far worse than the seam.
    if ((e as NodeJS.ErrnoException | null)?.code === "EEXIST") return false;
    try {
      return claimWithoutLink(file, since);
    } catch {
      return false;
    }
  } finally {
    try {
      // after a successful link the record lives at `file` as well, so dropping
      // our own copy leaves the claim standing
      rmSync(tmp, { force: true });
    } catch {
      /* a temp file we could not remove is litter, never a reason to fail a run */
    }
  }
}

/**
 * Put a record we moved ASIDE back where it came from — but only while the path
 * is still free, and never on top of a claim someone made in the meantime.
 *
 * Both put-backs below (evictLock's, dropOwnClaim's) run after the path has been
 * briefly ABSENT, and that absence is the price of doing the move as a rename.
 * A third run can win the free path with publishClaim inside it, and by the time
 * we look again that run has already been told it holds the workspace. Renaming
 * our copy back over its record does not undo that: it leaves the file naming a
 * run that is no longer the claimant while the actual claimant carries on
 * reaping — the file agrees with nobody, and the `since` protocol then has to
 * thrash a full beat to sort out which of the two stands.
 *
 * Linking refuses an occupied path, which is exactly the question being asked:
 * restore only into the hole we made. It makes true what evictLock's docblock
 * already claims about that window — a third run that slips into it simply wins,
 * and we refuse on the strength of what we read.
 *
 * Falls back to the rename where the filesystem has no hard links (FAT32, some
 * network shares): dropping a claim we are only holding for its owner is worse
 * there than the race, and the rename is what every version before this did.
 */
function restoreClaim(aside: string, file: string): void {
  try {
    linkSync(aside, file);
  } catch (e) {
    // EEXIST is the answer this exists to respect: a newer claim stands there,
    // and our copy is now litter. Anything else is a filesystem that cannot link.
    if ((e as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
      renameSync(aside, file);
      return;
    }
  }
  rmSync(aside, { force: true });
}

/**
 * What a read of the lock file found. The DISTINCTION between the two empty
 * answers is the whole reason this is a union rather than `LockRecord | null`.
 *
 * "missing" is no file at that path at all — deleted by hand, or a workspace
 * directory that went away (and possibly came back) while we were running. It
 * means this process no longer owns anything here. "unreadable" is a file that
 * EXISTS and made no sense: a torn write, a half-flushed beat, an EACCES from a
 * scanner holding it open. That is still our claim, damaged.
 *
 * Collapsing both into null is what let the heartbeat re-CREATE a lock for a run
 * whose cells were long gone, so a later run at that path was refused — or
 * reaped — by a ghost.
 */
type LockRead = { kind: "read"; rec: LockRecord } | { kind: "missing" } | { kind: "unreadable" };

/**
 * Read the lock, accepting BOTH shapes: the JSON record written now, and the
 * bare pid an older ralphrun wrote.
 *
 * A lock that cannot be made sense of is litter, not a holder — so one corrupt
 * file does not refuse every future run in this workspace, which is the manual
 * `rm` this lock exists to avoid.
 */
function inspectLock(file: string): LockRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch (e) {
    // ENOENT is the ONLY errno that means "there is nothing here". EACCES,
    // EBUSY, EPERM and friends are a file we cannot read *right now* — treating
    // those as ownership lost would hand the workspace away over a virus
    // scanner's momentary lock on Windows.
    return (e as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
  // legacy first: the whole file is the pid, and Number() settles it in one step
  let pid = Number(raw);
  let stamp: number | null = null;
  let since: number | null = null;
  if (!Number.isInteger(pid)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { kind: "unreadable" };
      const rec = parsed as { pid?: unknown; stamp?: unknown; since?: unknown };
      if (!Number.isInteger(rec.pid)) return { kind: "unreadable" };
      // A JSON record whose stamp is not a number is CORRUPT, not legacy. The
      // legacy shape is a bare pid and never reaches this branch, so falling
      // back to `stamp: null` here would give a garbled record the pid-only
      // answer — and pin the workspace shut for as long as some unrelated
      // process happens to hold that pid, which is the manual `rm` this whole
      // file exists to avoid.
      if (!isTime(rec.stamp)) return { kind: "unreadable" };
      // `since` is younger than the rest of the record: ABSENT is a lock a
      // previous ralphrun wrote and costs only the heartbeat's zombie check,
      // while PRESENT-but-garbled is the same corruption as above.
      if (rec.since !== undefined && !isTime(rec.since)) return { kind: "unreadable" };
      pid = rec.pid as number;
      stamp = rec.stamp as number;
      since = rec.since === undefined ? null : (rec.since as number);
    } catch {
      return { kind: "unreadable" };
    }
  }
  return pid > 0 ? { kind: "read", rec: { pid, stamp, since } } : { kind: "unreadable" };
}

function isTime(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The answer for callers that only need "who holds it, if anyone" — claiming and
 * releasing both treat every empty answer identically, and spelling the union
 * out at those two sites would only obscure that.
 */
function readLock(file: string): LockRecord | null {
  const r = inspectLock(file);
  return r.kind === "read" ? r.rec : null;
}

/**
 * Is the run that wrote this lock still the run behind that pid?
 *
 * A LIVE pid is not enough, and that gap is a real failure and not a theoretical
 * one: pids are recycled, on Windows within minutes, so a crashed run's pid gets
 * handed to something unrelated and the lock then names a live process that
 * never heard of ralphrun. pidAlive says "held", every later run refuses, and
 * the only way out is deleting the file by hand.
 *
 * The stamp closes it. Only the real holder refreshes its lock (see
 * startLockHeartbeat), so a process that merely INHERITED the pid leaves the
 * stamp frozen at the crash, and the claim expires on its own.
 *
 * A legacy lock has no stamp to compare, so it keeps the old pid-only answer:
 * refusing is the conservative half of the trade, and the shape disappears the
 * first time this version claims the workspace.
 */
function lockIsHeld(rec: LockRecord): boolean {
  if (!pidAlive(rec.pid)) return false;
  if (rec.stamp === null) return true;
  // A stamp from the FUTURE (a clock that moved backwards) reads as held rather
  // than expired: between two wrong answers, refusing a run is the recoverable
  // one — reaping a live run's cells is not.
  return Date.now() - rec.stamp <= LOCK_STALE_MS;
}

/**
 * Claim this workspace for one run. Returns null on success, the pid holding it
 * when there is one, or "unknown" when the path could be neither claimed nor
 * read out.
 *
 * publishClaim is the whole mechanism on a free path: the record is written to a
 * temp file and hard-LINKED onto the path, so the path goes from absent to whole
 * in one step and `link` refuses an occupied target — as exclusive as `wx`,
 * without ever making an empty file visible. `wx` survives only as the fallback
 * where the filesystem has no hard links (see claimWithoutLink). A lock whose
 * holder is no longer live — or no longer stamping — is a crash's litter,
 * exactly like an orphan worktree, and is taken over rather than reported;
 * otherwise every crash would need a manual `rm` before the next run.
 *
 * The takeover gets its own exclusivity from evictLock, and needs it: deciding
 * a claim is dead and replacing it are two syscalls, so overwriting the file
 * between them let every racer conclude it had won.
 *
 * Not advisory: reapOrphanWorktrees force-deletes every cell under .ralphrun at
 * boot, so a second run WILL delete the first one's live worktrees while its
 * executors are writing into them.
 */
export function claimRunLock(workspace: string): number | "unknown" | null {
  const file = join(workspace, LOCK);
  mkdirSync(join(workspace, ".ralphrun"), { recursive: true });
  // PASSES, because taking over is create-or-evict-then-create and the eviction
  // can lose its race. Every pass ends in a claim, a refusal, or exactly one
  // eviction, so this is not a spin: a run that keeps finding the path it just
  // freed already taken must refuse, since starting twice in one workspace is
  // the single outcome this function exists to prevent.
  for (let pass = 0; pass < 3; pass++) {
    const since = Date.now();
    // The one write here that cannot be a plain rename: the exclusivity has to
    // land on the real path, and a rename would REPLACE whatever is there
    // instead of refusing. publishClaim is how it stays exclusive without ever
    // making an empty file visible at that path.
    if (publishClaim(file, since)) {
      claimedAt = since;
      startLockHeartbeat(workspace);
      return null;
    }
    // occupied — by whom, and whether it is still alive, is the rest of the pass
    const rec = readLock(file);
    if (rec?.pid === process.pid) {
      // Ours already. A second claim inside one process is idempotent and is not
      // a takeover, so the claim keeps the `since` it started with — the beat
      // uses that to tell this claim from the one that replaces it.
      claimedAt = rec.since ?? (claimedAt || since);
      writeLock(file, claimedAt);
      startLockHeartbeat(workspace);
      return null;
    }
    if (rec && lockIsHeld(rec)) return rec.pid;
    // Dead, expired, or unreadable — all three are ours to take, but taking has
    // to be EXCLUSIVE or two runs both take it. See evictLock.
    const live = evictLock(file);
    if (live !== null) return live;
  }
  // Three passes and no claim: another run keeps taking the path we free, or the
  // file is one we can neither read nor move. Refusing is the only safe end —
  // but there is no pid to name. The only candidates are a record we positively
  // judged DEAD and our own pid, so a number here would tell the user to wait
  // for a process that is not running, or to wait for themselves. "unknown" is
  // what the caller renders as "delete the lock file if no run is active".
  return "unknown";
}

/**
 * Move the record at `file` out of the way, and settle what becomes of it.
 *
 * The one shape shared by both takeovers here — evictLock's (take a claim we
 * judged dead) and dropOwnClaim's (delete a claim of our own). A rename can only
 * move a file once: of N runs that read the same record and all concluded it was
 * theirs to move, exactly one moves it and the rest get ENOENT. Overwriting or
 * deleting in place instead — one syscall — told every one of them it had won,
 * and reapOrphanWorktrees then force-deletes the others' live cells at boot,
 * mid-edit.
 *
 * Judged BEFORE the move by the caller and verified AFTER it here, because the
 * two reads can disagree: the record may have been replaced by a real claim in
 * between, or have been a half-written file that has since become a whole one.
 * Only what we actually moved is evidence.
 *
 * The move leaves the path briefly ABSENT, and a third run can win it with
 * publishClaim in there — so the put-back is a LINK (restoreClaim), which
 * refuses an occupied path. A record that is foreign AND still live goes back; a
 * dead one is litter on both paths, which is the rule dropOwnClaim used to get
 * wrong by replanting a foreign record it had never checked for life.
 */
function moveAsideAndSettle(
  file: string,
  aside: string,
  take: (from: string, to: string) => void,
): number | null {
  try {
    take(file, aside);
  } catch {
    // Already moved by whoever won this race, or a file Windows will not let us
    // move while another process holds it open. Neither is ours to replace — the
    // caller's next pass reads whatever is there now and refuses if it is alive.
    return null;
  }
  const moved = inspectLock(aside);
  const live = moved.kind === "read" && moved.rec.pid !== process.pid && lockIsHeld(moved.rec) ? moved.rec.pid : null;
  try {
    if (live !== null) restoreClaim(aside, file);
    else rmSync(aside, { force: true });
  } catch {
    /* the copy we set aside is litter at worst; never a reason to fail a run */
  }
  return live;
}

/**
 * Take a claim we judged DEAD out of the way so the path can be claimed with
 * publishClaim again. Returns the pid of a claim that turned out to be LIVE, or
 * null when the path is now free to try for.
 *
 * The hazard it owns is the LOSING half of the race: by the time we look again
 * the winner's claim may already stand, and taking a live run's lock away from
 * it is what leaves two runs reaping each other's cells. A third run that slips
 * into the absent window simply wins the path with publishClaim, our own
 * publishClaim then fails, and we read its fresh claim and refuse — one holder
 * either way.
 *
 * Exported for the tests, like stampLockOnce and for the same reason: that
 * losing half has to be assertable without two ralphruns and a stopwatch. `take`
 * is injected there too, since the absent window cannot be opened from outside.
 * Nothing in production imports either.
 */
export function evictLock(file: string, take: (from: string, to: string) => void = renameSync): number | null {
  return moveAsideAndSettle(file, `${file}.${process.pid}.dead`, take);
}

/**
 * Keep this run's claim alive for as long as the process is.
 *
 * Started by claimRunLock and by nothing else, deliberately: a lock that is held
 * but never refreshed goes stale under its own holder after LOCK_STALE_MS and
 * then invites a second run to reap its live cells. "Holds the lock" and "stamps
 * the lock" must not be separable, so they are one call.
 *
 * unref'd: this timer must never be the reason the process stays alive.
 */
function startLockHeartbeat(workspace: string): void {
  stopLockHeartbeat();
  const file = join(workspace, LOCK);
  beat = setInterval(() => {
    if (stampLockOnce(file) === "lost") stopLockHeartbeat();
  }, HEARTBEAT_MS);
  beat.unref?.();
}

/**
 * One beat: refresh a lock we still own, or report that we do not.
 *
 * The rule is REFRESH, never resurrect — a beat may only stamp a file it can
 * see is ours. The earlier version stopped solely on a positively-read foreign
 * pid and re-wrote the lock on every other outcome, which meant a missing file
 * was re-created: delete the workspace directory under a still-live run (or let
 * a tool recreate it) and a later beat plants a claim for a run whose cells no
 * longer exist, so the next legitimate run at that path is refused by a ghost.
 *
 * The outcomes, and why each is what it is:
 *   - missing — the file is gone, so our claim is gone with it. Stop for good,
 *     and write NOTHING: recreating it is exactly the resurrection above.
 *   - a NEWER claim — a run overran our stale claim. It must not have its lock
 *     stamped by the run it replaced, so stop.
 *   - an OLDER claim under a foreign pid — a run WE replaced woke up and wrote
 *     its dead record back on top of ours. Re-assert; see wroteOverOurClaim.
 *   - ours, or present-but-unreadable — still our claim, and a torn or corrupt
 *     file at our own path is ours to REPAIR. Not repairing it would let a
 *     perfectly healthy run's claim expire under it over one bad read.
 *   - no claim of ours at all (claimedAt 0) — nothing to refresh, so nothing is
 *     written. This is the same "refresh, never resurrect" rule from the other
 *     side: minting a fresh `since` for a file we never claimed is exactly the
 *     ghost the first outcome exists to prevent.
 *
 * Exported for the tests: what a beat decides per lock shape is the whole
 * behaviour, and it must be assertable without ten seconds of wall clock each.
 * Nothing in production imports it.
 */
export function stampLockOnce(file: string): "stamped" | "lost" {
  const read = inspectLock(file);
  if (read.kind === "missing") return "lost";
  if (read.kind === "read" && read.rec.pid !== process.pid && !wroteOverOurClaim(read.rec)) return "lost";
  if (!claimedAt) return "lost";
  try {
    writeLock(file, claimedAt);
  } catch {
    /* a workspace that went away mid-run is not worth crashing the loop over */
  }
  return "stamped";
}

/**
 * Is this foreign record a claim we ALREADY replaced, written back on top of
 * ours?
 *
 * The read-then-write in a beat is not one operation and no filesystem here
 * offers a CAS to make it one, so a window exists: a run whose event loop was
 * blocked past LOCK_STALE_MS wakes, reads its own record, is legitimately
 * overrun in the microseconds that follow, and then stamps its dead claim back
 * over the new one.
 *
 * `since` settles who is who. It is fixed for the life of a claim, so the record
 * carrying the OLDER `since` is the older claim whatever pid the file names —
 * and a claim that was replaced can only be older than the one that replaced it.
 * The run that finds an older claim sitting on top of its own is the live holder
 * and re-asserts; the zombie's own next beat then reads a `since` newer than its
 * own and stands down for good.
 *
 * Standing down on BOTH sides instead — what a pid-only comparison does — gets
 * it exactly backwards: the zombie reads its own pid and keeps beating, while
 * the run that actually holds the workspace sees a foreign pid, stops beating,
 * and lets its claim age out under it. Its cells then become reapable orphans
 * while its executors are still writing into them.
 */
function wroteOverOurClaim(rec: LockRecord): boolean {
  return claimedAt > 0 && rec.since !== null && rec.since < claimedAt;
}

function stopLockHeartbeat(): void {
  if (beat) clearInterval(beat);
  beat = undefined;
}

export function releaseRunLock(workspace: string): void {
  stopLockHeartbeat();
  // We hold nothing from here on, and that has to be said out loud: a leftover
  // `claimedAt` would make a LATER claim of ours look older than it is, and the
  // beat's zombie rule would then re-assert a claim we had already given up.
  claimedAt = 0;
  try {
    dropOwnClaim(join(workspace, LOCK));
  } catch {
    /* no lock to release is not a failure */
  }
}

/**
 * Delete the claim at `file`, and only while it is still the one WE made.
 *
 * Reading the pid and then deleting the path is two operations, and the gap
 * between them is not free: our own stamp may already be stale, so a run that
 * judged it dead can evict our record and put its own there in that gap — and
 * the delete then unlocks a workspace whose live holder is mid-run, leaving its
 * cells for the next run to reap out from under its executors.
 *
 * So the delete goes through moveAsideAndSettle, exactly as evictLock's takeover
 * does: a file can only be moved once, what we moved is re-read BEFORE it is
 * dropped, and a record that turns out to be someone else's LIVE claim goes
 * straight back. "unreadable" is our own claim damaged — a torn beat, an EACCES
 * — and still ours to drop, and a foreign record that is itself dead is litter
 * either way; replanting one only costs the next run an extra eviction pass.
 *
 * The plain read up front is not made redundant by that — it is what keeps the
 * ordinary "we lost the lock long ago" case from touching the file at all, so a
 * foreign claim never spends even an instant absent from its own path.
 *
 * `take` is injected only by tests: what makes this safe is what happens in the
 * window between the check and the move, and that window cannot be opened from
 * outside. Exported for those tests only; nothing in production imports it.
 */
export function dropOwnClaim(file: string, take: (from: string, to: string) => void = renameSync): void {
  if (readLock(file)?.pid !== process.pid) return;
  moveAsideAndSettle(file, `${file}.${process.pid}.gone`, take);
}

/** signal 0 asks "does this pid exist", kills nothing */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A leftover worktree is a crash's litter, and recovery needs no state file:
 * this is the exact sibling of normalizePrd resetting a stuck `doing` task, one
 * layer down. It runs even when worktree_per_task is off this run, so turning
 * the feature off after a crash still cleans up.
 *
 * "No ralphrun worktree can legitimately be live at boot" is true of ONE loop
 * per workspace, and that is what claimRunLock enforces — without it a second
 * run in the same repo reaped the first one's live cells out from under its
 * executors, mid-edit.
 */
export function reapOrphanWorktrees(workspace: string): number {
  // `git worktree list --porcelain` prints POSIX separators even on Windows,
  // while WORKTREES is built with join() and so uses the platform's. Comparing
  // them directly matched nothing on Windows, which silently disabled crash
  // recovery there — the reap counted zero and left every orphan cell behind.
  const marker = "/" + WORKTREES.split(sep).join("/") + "/";
  let n = 0;
  for (const line of gitOut(workspace, "worktree", "list", "--porcelain")?.split("\n") ?? []) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.slice("worktree ".length);
    // path match rather than realpath comparison: a repo checked out under a
    // symlinked temp dir reports its real path, and a user's own worktree
    // elsewhere is not ours to delete.
    if (!dir.split(sep).join("/").includes(marker)) continue;
    removeTaskWorktree(workspace, dir);
    n += 1;
  }
  // `remove --force` handles a directory that still exists, `prune` handles an
  // administrative entry whose directory is already gone. Both crash shapes.
  if (n > 0) git(workspace, "worktree", "prune");
  return n;
}

// ---------------------------------------------------------------------------
// THE INSTALL DETECTOR, and what it is NOT.
//
// Everything from here to tasksInstallingDeps is a heuristic warning for the
// common SPELLINGS of an install, and the limit is structural rather than a gap
// to be closed: it cannot see inside a script file (`sh ./setup.sh`), a
// package.json script (`npm run bootstrap`), a Makefile, a Justfile or a docker
// step, and it must not guess at them (see unwrapShell). The supply of bypasses
// is unbounded, so the tables below are NOT a standing obligation to grow — a
// manager nobody listed is a bug report, not a debt.
//
// The actual protection against the corruption is `worktree_setup` with an empty
// `worktree_link`: no shared tree means nothing to corrupt, whatever the verify
// command spells. This detector only decides whether to REFUSE the shared-tree
// configuration up front, so a miss costs the warning, not the guarantee.
// ---------------------------------------------------------------------------

// Each manager and the sub-commands of it that WRITE the dependency tree. Bare
// `yarn` is in the list because classic yarn with no arguments installs.
//
// NOT node-only, because the hazard is not node-only: worktree_link takes any
// gitignored directory, and `.venv` is the documented Python case — README names
// `uv sync` in the same breath as `npm ci`. A detector that knew only the
// JavaScript managers let the exact combination it exists to refuse (a shared
// `.venv`, a wave, an installing setup) start and corrupt the user's real
// environment, which is the one failure no worktree discard rolls back.
const INSTALL_VERBS: Record<string, string[]> = {
  npm: ["ci", "install", "i", "add"],
  pnpm: ["install", "i", "add"],
  yarn: ["install", "add"],
  bun: ["install", "i", "add"],
  uv: ["sync", "add"],
  poetry: ["install", "add"],
  pip: ["install"],
  pip3: ["install"],
  bundle: ["install"],
};

// `uv pip install`/`uv pip sync` write the environment through a sub-command of
// a sub-command, so the verb sits one token further right. Listed apart rather
// than folded into the table above because `uv pip list` and `uv pip show` are
// read-only and must not be flagged.
//
// `python -m pip install` is the same shape, and it is the form pip's own docs
// recommend over bare `pip` precisely BECAUSE it pins which environment gets
// written — the exact environment `worktree_link` shares. The first token is the
// interpreter, so the manager table above never sees it: `py -m pip install -r
// requirements.txt` in a wave with a linked `.venv` used to sail past this
// detector and install into the user's real environment from every cell at once.
const NESTED_INSTALL_VERBS: Record<string, Record<string, string[]>> = {
  uv: { pip: ["install", "sync"] },
  python: { pip: ["install"] },
};

// Options that carry a SEPARATE value, so the value is not read as the
// sub-command: `npm --prefix . install` must not tokenise to a verb of ".".
// Deliberately only what can legitimately stand LEFT of an install verb —
// guessing wide is how a boolean flag swallows the verb behind it, turning an
// install into a false negative, which is the failure that corrupts a tree.
//
// Keyed BY MANAGER, because the tokens are not manager-agnostic even when they
// look it. One flat set was written against npm's spelling and then applied to
// all nine: `-w` is npm's `--workspace <name>` and takes a value, but pnpm's
// `--workspace-root` and takes none — so `pnpm -w add lodash` swallowed `add`
// as if it were the flag's value, came back with a sub-command of "lodash", and
// was reported as NOT an install. That is precisely the false negative the
// paragraph above warns about, committed by the table meant to prevent it.
const PIP_VALUE_OPTIONS = new Set(["-c", "--constraint", "--cache-dir", "--log", "--proxy", "--python"]);
const VALUE_OPTIONS: Record<string, Set<string>> = {
  npm: new Set(["-C", "--prefix", "--workspace", "-w", "--loglevel", "--registry", "--cache", "--userconfig"]),
  // no `-w`: pnpm's is --workspace-root, a boolean
  pnpm: new Set(["-C", "--dir", "--filter", "-F", "--loglevel", "--registry", "--config"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd", "--config", "-c"]),
  uv: new Set(["--directory", "--project", "--python", "-p", "--cache-dir", "--config-file"]),
  poetry: new Set(["-C", "--directory"]),
  pip: PIP_VALUE_OPTIONS,
  pip3: PIP_VALUE_OPTIONS,
  // `python -m pip install`: `-m` is deliberately absent, since its value IS the
  // sub-command this detector is looking for
  python: PIP_VALUE_OPTIONS,
  bundle: new Set(["--gemfile"]),
};

/**
 * The sub-commands of one segment, with the manager's own options stripped.
 *
 * Reading tokens[1] as the verb was wrong for every invocation that carries a
 * global flag — `npm --prefix . install` and `pnpm -C app install` are installs,
 * and calling them anything else lets the concurrent-install corruption this
 * detector refuses run in every cell at once.
 *
 * Scanning for the first NON-option token rather than searching every token for
 * an install word is what keeps `npm run install-check` and `npm test -- --grep
 * install` false: the verb has to be in the verb's POSITION.
 */
function subCommands(tokens: string[], bin: string): string[] {
  // only ever called for a bin that is in one of the manager tables, so an empty
  // set here means "this manager has no value-carrying global flags"
  const values = VALUE_OPTIONS[bin];
  const out: string[] = [];
  for (let i = 1; i < tokens.length && out.length < 2; i++) {
    const tok = tokens[i] ?? "";
    // everything right of `--` belongs to the sub-command, not to the manager
    if (tok === "--") break;
    if (!tok.startsWith("-")) {
      out.push(tok);
      continue;
    }
    // `--flag=value` carries its own value; `--flag value` eats the next token
    if (!tok.includes("=") && values?.has(tok)) i += 1;
  }
  return out;
}

// The shells that take a command as a STRING argument, so the install is inside
// a quoted word rather than in the command position. `sh -c "npm ci"` runs the
// install exactly as `npm ci` does, and reading only the first token called it a
// non-install — the direction that corrupts the tree.
const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash", "ksh", "cmd", "powershell", "pwsh"]);

/** `-c`, `-lc`, `--command`, and cmd.exe's `/c` — the flag whose value IS a command */
const COMMAND_FLAG = /^(?:-{1,2}(?:[a-z]*c|command)|\/[ck])$/i;

/**
 * The command a shell wrapper was asked to run, or null when this is not one.
 *
 * Stops at the first non-flag token that is not the command flag's value: that
 * is a SCRIPT path (`sh ./ci.sh`), whose contents this detector cannot see and
 * must not guess at.
 */
function unwrapShell(tokens: string[]): string | null {
  if (!SHELL_BINS.has(normalizeBin(tokens[0] ?? ""))) return null;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (COMMAND_FLAG.test(tok)) {
      // the tokens were split on whitespace, so the quoted command comes back in
      // pieces; rejoining and unquoting gives the string the shell would run
      return tokens
        .slice(i + 1)
        .join(" ")
        .replace(/^(['"])([\s\S]*)\1$/, "$2");
    }
    if (!tok.startsWith("-") && !tok.startsWith("/")) return null;
  }
  return null;
}

/**
 * The command's own tokens, with what the SHELL consumes before it peeled off.
 *
 * `FOO=1 npm ci` is an install; `env FOO=1 npm ci` is the same install spelled
 * out. Both used to tokenise to a first token of "FOO=1" or "env", which is in
 * neither manager table, so the segment was passed over — with a shared tree and
 * a parallel wave that is the concurrent install this detector exists to refuse.
 */
function peelPrefixes(tokens: string[]): string[] {
  const consumed = (tok: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok) || normalizeBin(tok) === "env";
  let i = 0;
  while (i < tokens.length && consumed(tokens[i] ?? "")) i++;
  return tokens.slice(i);
}

/**
 * The commands a shell would run separately, splitting on the operators only
 * where they ARE operators.
 *
 * Quote-aware, because a wrapper's command is one quoted word: splitting `sh -c
 * "npm test && npm ci"` on the `&&` inside it cuts a string the shell never
 * cuts, and both halves then read as nonsense — one wrapper with no command, one
 * manager with a torn verb — so the install disappears. The same care keeps
 * `echo "a; npm ci"` a single segment that names an install without running one.
 *
 * A single `&` is a separator too: on Windows `set CI=1 & npm ci` is the ordinary
 * way to write this, and splitting only on `&&` left the install in a segment
 * whose first token was `set`.
 */
function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] ?? "";
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const pair = cmd.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      out.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Does this verify command write the dependency tree?
 *
 * Tokenised per shell segment rather than matched as a substring, so `npm run
 * install-check` and `echo "npm ci"` are not installs — a false positive here
 * refuses a backlog that was fine, which is worse than the hazard when the tree
 * is not actually shared.
 *
 * A segment is what the shell would run, not what it looks like: grouping
 * parentheses, leading variable assignments and a `sh -c` wrapper all put the
 * manager somewhere other than the first token, and every one of them still
 * installs. `depth` bounds the wrapper recursion — a `sh -c` chain long enough to
 * matter is not a verify command anyone wrote.
 */
export function verifyInstallsDeps(verify: string, depth = 0): boolean {
  for (const segment of shellSegments(verify)) {
    // `(npm ci)` and `{ npm ci; }` run the install in a subshell or a group; the
    // punctuation is the shell's and never part of the command's name
    const bare = segment.trim().replace(/^[\s({]+/, "").replace(/[\s)}]+$/, "");
    const tokens = peelPrefixes(bare.split(/\s+/).filter(Boolean));
    const inner = depth < 3 ? unwrapShell(tokens) : null;
    if (inner && verifyInstallsDeps(inner, depth + 1)) return true;
    const bin = normalizeBin(tokens[0] ?? "");
    const verbs = INSTALL_VERBS[bin];
    const nested = NESTED_INSTALL_VERBS[bin];
    // NEITHER table, not just the flat one: `python` has no verbs of its own and
    // testing only the flat table returned early on every module-form install.
    if (!verbs && !nested) continue;
    const subs = subCommands(tokens, bin);
    if (subs.length === 0) {
      // options only, no verb at all. Classic yarn installs that way, and it
      // does so just the same with `--frozen-lockfile` in front of nothing.
      if (bin === "yarn") return true;
      continue;
    }
    if (verbs?.includes(subs[0] ?? "")) return true;
    if (nested?.[subs[0] ?? ""]?.includes(subs[1] ?? "")) return true;
  }
  return false;
}

/**
 * The command's name, with what the SHELL would have resolved stripped off.
 *
 * Windows resolves `npm` to `npm.cmd`, and a user who writes the shim's real
 * name means the same install — the extension is the shell's business, not a
 * different command.
 *
 * The interpreters fold together for the same reason: `python`, `python3`,
 * `python3.12` and Windows' `py` launcher all run `-m pip install` against the
 * environment this detector is guarding, and a version suffix names the BUILD,
 * never a different command. One table entry rather than one per suffix, since
 * the suffixes are unbounded and a missing one is a false negative — the
 * direction that corrupts the tree.
 *
 * Lower-cased for the same reason the extension goes: `NPM.CMD ci` is what
 * cmd.exe resolves and runs as `npm ci`, and stripping the extension without
 * folding the case left "NPM", which is in no table. Folded everywhere rather
 * than on win32 only — a case-varied manager name is not a different tool on any
 * platform, and the cost of being wrong here is a refusal, while the cost of
 * missing an install is the one corruption no worktree discard rolls back. The
 * VERB is left alone on purpose: npm dispatches its own sub-commands
 * case-sensitively, so `npm CI` is not an install to flag.
 */
function normalizeBin(tok: string): string {
  const bin = tok.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");
  return /^(?:python[\d.]*|py)$/.test(bin) ? "python" : bin;
}

/**
 * The ids whose verify installs. Combined by the caller with "the tree is
 * actually shared" and "more than one task runs at a time", those three
 * together are the only combination that corrupts the user's real node_modules
 * — and it is the one thing here no worktree discard can roll back.
 */
export function tasksInstallingDeps(tasks: { id: string; verify?: string }[]): string[] {
  return tasks.filter((t) => t.verify && verifyInstallsDeps(t.verify)).map((t) => t.id);
}

/** Derived from the id, so crash recovery needs no bookkeeping file. */
function worktreePath(workspace: string, taskId: string): string {
  // a task id is free text in prd.json; keep it inside the directory we own
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  // Sanitizing is many-to-one — "api:get" and "api/get" are two distinct tasks
  // that both fold to "api_get" — and `add` starts by DELETING whatever sits at
  // the path, so in a wave the second task would reap the first one's live cell.
  // The digest makes the mapping injective again while staying derived.
  const dir = safe === taskId ? safe : `${safe}-${createHash("sha1").update(taskId).digest("hex").slice(0, 8)}`;
  return join(workspace, WORKTREES, dir);
}

/**
 * Repo-local, so the user's tracked .gitignore is never touched. Load-bearing,
 * not cosmetic: without it the temporary-index `git add -A` inside
 * captureReviewBase / taskChangedPaths sweeps the worktree directories into the
 * trunk's own baseline and commits.
 */
function excludeRalphrunDir(workspace: string): void {
  // createTaskWorktree already read a commit out of this repository before
  // calling, so rev-parse cannot come back empty — and if it somehow did, the
  // throw lands in that same caller's catch and the task degrades to the main
  // workspace, which is exactly what a silent ".git" guess would have hidden.
  const common = gitOut(workspace, "rev-parse", "--git-common-dir")!;
  const info = join(isAbsolute(common) ? common : resolve(workspace, common), "info");
  const file = join(info, "exclude");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur.split("\n").includes(".ralphrun/")) return;
  mkdirSync(info, { recursive: true });
  appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + ".ralphrun/\n");
}
