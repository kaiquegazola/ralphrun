// projectreg.ts — the list of FOLDERS ralphrun knows as projects.
//
// It lives in the core rather than in the desktop app because both write it:
// the app when you point it at a folder, and `ralphrun create .` from inside
// one. Two writers of one file means one implementation of the format.
//
// Preferences only — a project record is a path and a display name, never a
// secret and never anything a run needs to work.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { join } from "node:path";

import { configDir } from "./userconfig.js";

export interface ProjectRecord {
  id: string;
  name: string;
  dir: string;
  addedAt: number;
}

interface RegistryFile {
  version: 1;
  projects: ProjectRecord[];
}

export function projectsPath(): string {
  return join(configDir(), "projects.json");
}

/**
 * Derived from the CANONICAL path, so registering the same folder twice is a
 * no-op — including through a symlink or a different casing on a
 * case-insensitive filesystem. Two ids for one repository would let the desktop
 * app start two runs against it, and the core's run lock would then kill the
 * second one with an error the user cannot place.
 */
export function projectId(dir: string): string {
  return createHash("sha1").update(canonical(dir)).digest("hex").slice(0, 8);
}

/** realpath when the folder exists; the resolved path is the best we can do otherwise. */
export function canonical(dir: string): string {
  try {
    return realpathSync.native(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

function read(): RegistryFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(projectsPath(), "utf8"));
    const projects = (parsed as RegistryFile)?.projects;
    if (!Array.isArray(projects)) return { version: 1, projects: [] };
    // every field, not just `dir`: a record with no name reaches the desktop
    // app's project list and crashes the screen on `name.slice(...)`. A
    // half-written record is corruption, and corruption is dropped.
    return {
      version: 1,
      projects: projects.filter(
        (p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.dir === "string",
      ),
    };
  } catch {
    // absent or corrupt reads as empty: a broken preferences file must never
    // stop a run, and the next write repairs it.
    return { version: 1, projects: [] };
  }
}

function write(file: RegistryFile): void {
  mkdirSync(configDir(), { recursive: true });
  // Atomic, like the user config next to it, and for a sharper reason: the CLI
  // and the desktop app both write this file. A truncate-then-write would let a
  // reader see a half-file, and an interrupted write would leave the registry
  // corrupt. pid-unique tmp so two concurrent writers cannot rename-steal.
  const p = projectsPath();
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, p);
}

/**
 * Serialize the whole read-modify-write, not just the write.
 *
 * Atomic rename alone is not enough for a file with two writers: `ralphrun
 * create .` and the desktop app can both read the same old registry and the
 * second rename then erases the first one's project. The lock is a directory
 * because mkdir is atomic on every filesystem, and a STALE one (a crash mid
 * write) is broken after a second rather than wedging the CLI forever.
 */
function withLock<T>(fn: () => T): T {
  // BEFORE the lock: on a machine that has never run ralphrun the config dir
  // does not exist yet, and mkdir of the lock inside it fails with ENOENT —
  // which the retry loop below would spin on forever.
  mkdirSync(configDir(), { recursive: true });

  const lock = `${projectsPath()}.lock`;
  const owner = `${lock}/pid`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(owner, String(process.pid));
      break;
    } catch (err) {
      // EEXIST is CONTENTION — somebody else holds it. Anything else is the
      // filesystem saying no (read-only, no permission), and retrying that
      // forever would hang the CLI instead of reporting it.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline && !ownerAlive(owner)) {
        // the holder died mid-write. Breaking a lock whose owner is GONE is
        // recovery; breaking one whose owner is merely slow would put two
        // writers in the critical section, which is the bug the lock exists
        // for — so a live owner just means we keep waiting.
        //
        // RENAMED, not deleted: two waiters that both see the corpse would both
        // rmSync, and the second one would delete the lock the first has
        // already re-taken. Only one rename of a given directory can succeed,
        // and it leaves nothing behind that a crash could wedge us on.
        const dead = `${lock}.dead.${process.pid}`;
        try {
          renameSync(lock, dead);
        } catch {
          napMs(20); // another waiter got there first
          continue;
        }
        rmSync(dead, { recursive: true, force: true });
        continue;
      }
      napMs(20); // a spin with no pause would burn a core while it waits
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Sleep, synchronously. The critical section is two file operations and the
 * callers are sync (a CLI action, an RPC handler), so a real wait beats both a
 * busy loop and turning the whole registry async for a millisecond of contention.
 */
function napMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Is the process that wrote this lock still running? Unreadable owner = no. */
function ownerAlive(owner: string): boolean {
  try {
    const pid = Number(readFileSync(owner, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // signal 0 = existence check, never delivered
    return true;
  } catch {
    return false;
  }
}

/** Registered projects whose FOLDER still exists — a file in its place is not one. */
export function listProjects(): ProjectRecord[] {
  return read().projects.filter((p) => {
    try {
      return statSync(p.dir).isDirectory();
    } catch {
      return false; // gone, or unreadable: either way it cannot host a run
    }
  });
}

export function findProject(id: string): ProjectRecord | null {
  return listProjects().find((p) => p.id === id) ?? null;
}

export function addProject(dir: string, name?: string): ProjectRecord {
  const abs = canonical(dir);
  return withLock(() => {
    // read INSIDE the lock: the copy this process loaded a moment ago may
    // already be one project behind
    const file = read();
    const id = projectId(abs);
    const existing = file.projects.find((p) => p.id === id);
    if (existing) return existing;
    const rec: ProjectRecord = { id, name: name?.trim() || basename(abs), dir: abs, addedAt: Date.now() };
    file.projects.push(rec);
    write(file);
    return rec;
  });
}

export function removeProject(id: string): void {
  withLock(() => {
    const file = read();
    file.projects = file.projects.filter((p) => p.id !== id);
    write(file);
  });
}
