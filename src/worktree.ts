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
  mkdirSync,
  readFileSync,
  realpathSync,
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
 * Copy-on-write clone of a directory: the whole tree in constant time, sharing
 * blocks with the original until something writes.
 *
 * This is what makes per-task `node_modules` affordable — a plain recursive copy
 * of a real dependency tree is hundreds of megabytes and tens of seconds per
 * task. Refuses rather than degrading to a slow copy: the caller has a cheaper
 * fallback and needs to KNOW which one it got, and a silent 400MB copy per task
 * would look like a hang.
 */
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
 * only as the fallback for a filesystem without copy-on-write, and the caller is
 * told which it got — because "shared" is the state that has to be refused when
 * a wave might install.
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
    try {
      for (const name of links) seedIgnoredDir(workspace, dir, name);
    } catch (err) {
      // the cell EXISTS now: leaving it behind keeps an administrative entry
      // git will refuse to `add` over next time, for a task that is about to
      // degrade to the main workspace anyway
      removeTaskWorktree(workspace, dir);
      throw err;
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * Would this workspace's gitignored directories be SHARED between cells?
 *
 * Answered by trying the real thing in the real place — a clone can fail for the
 * filesystem, the platform, or a `cp` that does not take the flag, and only an
 * attempt distinguishes those from a guess. Cheap: one empty directory.
 *
 * True is what makes a wave whose verify installs unsafe, so this is the probe
 * behind that refusal rather than a platform check that would be wrong on a
 * repository sitting on a mounted volume.
 */
export function ignoredDirsWouldBeShared(workspace: string): boolean {
  const probe = join(workspace, ".ralphrun", "cow-probe");
  const src = join(probe, "src");
  const dst = join(probe, "dst");
  const clean = (): void => {
    // its own guard: a cleanup that throws would REPLACE the answer the catch
    // below already decided, turning "assume shared" into a crash
    try {
      rmSync(probe, { recursive: true, force: true });
    } catch {
      /* a probe directory we could not remove is not worth failing a run over */
    }
  };
  // The unsafe answer stands unless the probe positively disproves it, so a
  // throw anywhere below leaves it. Written as a variable rather than a
  // `finally` because the cleanup has to run on BOTH paths and a `return`
  // inside `try` makes that an implicit branch nothing can exercise.
  let shared = true;
  try {
    clean();
    mkdirSync(src, { recursive: true });
    // With a FILE in it. An empty directory has nothing to reflink, so
    // `cp --reflink=always` trivially succeeds on filesystems that cannot
    // reflink at all — the probe would answer "isolated" and the real clone of
    // node_modules would then fall back to a SHARED symlink, which is the exact
    // hazard this refuses to run into.
    writeFileSync(join(src, "probe"), "cow\n");
    shared = !cloneDir(src, dst) || !existsSync(join(dst, "probe"));
  } catch {
    /* cannot even probe: keep the unsafe answer */
  }
  clean();
  return shared;
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
 */
export function removeTaskWorktree(workspace: string, dir: string): void {
  git(workspace, "worktree", "remove", "--force", dir);
  rmSync(dir, { recursive: true, force: true });
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
const LOCK = join(".ralphrun", "run.lock");

/**
 * Claim this workspace for one run. Returns the pid holding it, or null on
 * success.
 *
 * `wx` is the whole mechanism: the create-exclusive flag makes "test and claim"
 * ONE syscall, so two ralphruns starting together cannot both win. A lock whose
 * pid is no longer alive is a crash's litter, exactly like an orphan worktree,
 * and is taken over rather than reported — otherwise every crash would need a
 * manual `rm` before the next run.
 *
 * Not advisory: reapOrphanWorktrees force-deletes every cell under .ralphrun at
 * boot, so a second run WILL delete the first one's live worktrees while its
 * executors are writing into them.
 */
export function claimRunLock(workspace: string): number | null {
  const file = join(workspace, LOCK);
  mkdirSync(join(workspace, ".ralphrun"), { recursive: true });
  const steal = `${file}.steal`;

  // Bounded, because every path that loops here re-reads the lock: a takeover
  // that lost its race has to look again rather than assume the corpse it saw
  // is still there — that assumption is how two runs both became the owner.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return null;
    } catch {
      // taken — by whom, and are they alive?
    }
    const holder = pidIn(file);
    if (holder === process.pid) return null; // already ours
    if (holder && pidAlive(holder)) return holder;
    if (!holder) continue; // the file vanished under us: try the claim again

    // Stale. The TAKEOVER needs its own lock, or two runs that both find the
    // same corpse both write their pid and both proceed — and the second one's
    // reap deletes the first one's live worktrees.
    try {
      writeFileSync(steal, String(process.pid), { flag: "wx" });
    } catch {
      const thief = pidIn(steal);
      if (thief && thief !== process.pid && pidAlive(thief)) return thief;
      // litter from a crash INSIDE a takeover, or a winner that already
      // finished — either way the lock itself is the source of truth, so drop
      // the sidecar and read it again.
      rmSync(steal, { force: true });
      continue;
    }
    try {
      // Under the steal lock, and only now: whoever won an earlier race has
      // written their pid by this point, so a live one is the real owner.
      const now = pidIn(file);
      if (now && now !== process.pid && pidAlive(now)) return now;
      writeFileSync(file, String(process.pid));
    } finally {
      rmSync(steal, { force: true });
    }
    return null;
  }
  // Contention that never settled. `null` MUST NOT come back here: every caller
  // reads it as "the lock is yours", and the whole point of this file is that a
  // second run in the same workspace reaps the first one's live worktrees.
  // BUSY_UNKNOWN is the honest answer when no pid can be named.
  const last = pidIn(file);
  return last && last !== process.pid ? last : BUSY_UNKNOWN;
}

/**
 * "Somebody has this workspace and we could not find out who" — a lock we
 * neither took nor could attribute, after repeated contention. Not a real pid:
 * callers print it, and printing it is better than running unlocked.
 */
export const BUSY_UNKNOWN = -1;

/** The pid a lock file names, or 0 when it is absent or unreadable. */
function pidIn(file: string): number {
  try {
    return Number(readFileSync(file, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Run `fn` while this process holds the workspace, or report who does.
 *
 * For a HOST outside the loop (the desktop app) writing prd.json: checking the
 * lock and then writing leaves a window in which a run claims the workspace
 * between the two, and the write then rolls back statuses that run has already
 * advanced. Never call it from a process that already holds the lock for a run
 * of its own — the release at the end would drop that claim.
 */
export function withRunLock<T>(
  workspace: string,
  fn: () => T,
): { ok: true; value: T } | { ok: false; holder: number } {
  const holder = claimRunLock(workspace);
  if (holder !== null) return { ok: false, holder };
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseRunLock(workspace);
  }
}

/**
 * Who is running in this workspace right now — a pid, or null for nobody.
 *
 * READ-ONLY, unlike claimRunLock, which takes the lock as a side effect. A host
 * that wants to write prd.json from outside needs to know whether a loop owns
 * it first: the run may be a `ralphrun` in another terminal, which no desktop
 * bookkeeping knows about.
 */
export function runLockHolder(workspace: string): number | null {
  try {
    const holder = Number(readFileSync(join(workspace, LOCK), "utf8").trim());
    if (!holder || holder === process.pid) return null;
    return pidAlive(holder) ? holder : null; // a dead holder is a crash's litter
  } catch {
    return null; // no lock file: nobody is running here
  }
}

export function releaseRunLock(workspace: string): void {
  const file = join(workspace, LOCK);
  try {
    // only if it is still OURS: a run that overran a stale claim must not delete
    // the lock of whoever legitimately holds it now
    if (Number(readFileSync(file, "utf8").trim()) === process.pid) rmSync(file, { force: true });
  } catch {
    /* no lock to release is not a failure */
  }
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

export function reapOrphanWorktrees(workspace: string): number {
  // `git worktree list --porcelain` prints POSIX separators even on Windows,
  // while WORKTREES is built with join() and so uses the platform's. Comparing
  // them directly matched nothing on Windows, which silently disabled crash
  // recovery there — the reap counted zero and left every orphan cell behind.
  // ANCHORED at this workspace, not matched anywhere in the path: the same repo
  // can have the user's own worktrees elsewhere, and `remove --force` on one of
  // those would delete work nobody asked us to touch. BOTH spellings, because a
  // repo under a symlinked directory reports its real path to git.
  const slash = (p: string): string => p.split(sep).join("/");
  let real = workspace;
  try {
    real = realpathSync.native(workspace);
  } catch {
    // a workspace that cannot be resolved is one the literal path still names
  }
  const homes = [...new Set([slash(workspace), slash(real)])].map((w) => `${w}/${slash(WORKTREES)}/`);
  let n = 0;
  for (const line of gitOut(workspace, "worktree", "list", "--porcelain")?.split("\n") ?? []) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.slice("worktree ".length);
    // path match rather than realpath comparison: a repo checked out under a
    // symlinked temp dir reports its real path, and a user's own worktree
    // elsewhere is not ours to delete.
    if (!homes.some((home) => slash(dir).startsWith(home))) continue;
    removeTaskWorktree(workspace, dir);
    n += 1;
  }
  // `remove --force` handles a directory that still exists, `prune` handles an
  // administrative entry whose directory is already gone. Both crash shapes.
  if (n > 0) git(workspace, "worktree", "prune");
  return n;
}

// Each manager and the sub-commands of it that WRITE the dependency tree. Bare
// `yarn` is in the list because classic yarn with no arguments installs.
// REMOVALS count too: `npm uninstall` and friends write the same tree, and a
// parallel wave sharing it would have one task delete what another is using.
const INSTALL_VERBS: Record<string, string[]> = {
  npm: ["ci", "install", "i", "add", "update", "up", "uninstall", "remove", "rm", "un", "prune", "dedupe"],
  pnpm: ["install", "i", "add", "update", "up", "remove", "rm", "uninstall", "un", "prune", "dedupe"],
  yarn: ["install", "add", "up", "upgrade", "remove"],
  bun: ["install", "i", "add", "update", "remove", "rm"],
};

/**
 * Does this verify command write the dependency tree?
 *
 * Tokenised per shell segment rather than matched as a substring, so `npm run
 * install-check` and `echo "npm ci"` are not installs — a false positive here
 * refuses a backlog that was fine, which is worse than the hazard when the tree
 * is not actually shared.
 */
export function verifyInstallsDeps(verify: string): boolean {
  for (const segment of verify.split(/&&|\|\||;|\||\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const verbs = INSTALL_VERBS[tokens[0]];
    if (!verbs) continue;
    if (tokens.length === 1) {
      if (tokens[0] === "yarn") return true;
      continue;
    }
    if (verbs.includes(tokens[1])) return true;
  }
  return false;
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

/** DOS device names: on Windows a directory can never be called one of these. */
const WIN32_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;

/**
 * The directory name a task's cell gets. EXPORTED because a host that wants to
 * find the cell of a task has to ask the same rule rather than reimplement it —
 * a second copy is one free to drift, and it did.
 */
export function taskWorktreeName(taskId: string): string {
  // a task id is free text in prd.json; keep it inside the directory we own
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  // Sanitizing is many-to-one — "api:get" and "api/get" are two distinct tasks
  // that both fold to "api_get" — and `add` starts by DELETING whatever sits at
  // the path, so in a wave the second task would reap the first one's live cell.
  // The digest makes the mapping injective again while staying derived.
  // ".", ".." and "" survive the sanitizer unchanged and then resolve OUTSIDE
  // the cell: join(ws, WORKTREES, "..") is `.ralphrun` itself, and the rmSync
  // that clears the path would take run.lock and every other cell with it.
  //
  // The lowercase check is the same argument on a case-INSENSITIVE filesystem:
  // "A" and "a" are two tasks in prd.json and one directory on macOS and
  // Windows, so a wave's second `add` would clear the first one's live cell.
  // Win32 folds more than case — it strips trailing dots and spaces ("foo." IS
  // "foo") and reserves the DOS device names, where the create fails outright.
  const plain =
    safe === taskId &&
    safe === safe.toLowerCase() &&
    safe !== "" &&
    safe !== "." &&
    safe !== ".." &&
    !/[. ]$/.test(safe) &&
    !WIN32_DEVICE.test(safe);
  return plain ? safe : `${safe}-${createHash("sha1").update(taskId).digest("hex").slice(0, 8)}`;
}

/** Derived from the id, so crash recovery needs no bookkeeping file. */
function worktreePath(workspace: string, taskId: string): string {
  return join(workspace, WORKTREES, taskWorktreeName(taskId));
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
