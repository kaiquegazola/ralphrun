// spawn.integration.test.ts — REAL processes. This is the test that actually
// proves the bug is fixed: a killed agent must take its grandchildren with it,
// and 'close' must fire (a surviving grandchild holding the inherited pipes is
// exactly what hung a run at 1800s/1800s forever).
//
// The first suite is POSIX only: it probes the child's process GROUP with
// signal 0, which stays alive as long as ANY member does — precisely the thing
// that used to leak, and a concept Windows has no equivalent for. The second
// suite runs EVERYWHERE (so `taskkill /T /F` finally has real-process coverage
// on a Windows runner, not just mocked assertions) by having the grandchild
// report its own pid through a file.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { killAllChildren, killTree, spawn } from "./spawn.js";

const posix = process.platform !== "win32";

function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0); // signal 0 = existence probe, kills nothing
    return true;
  } catch {
    return false; // ESRCH: every member of the group is gone
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until a condition holds, instead of sleeping a constant.
 *
 * Every fixed wait in this file was a latent flake: under parallel test load a
 * shell can take longer to start its children, or the OS longer to reap them,
 * than any number you pick. Polling is both faster in the common case and
 * stable in the slow one.
 */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (cond()) return true;
    await wait(50);
  }
  return cond();
}

/** a child that spawns a grandchild inheriting our pipes — the real-world shape */
function spawnTree(): ReturnType<typeof spawn> {
  return spawn("sh", ["-c", "sleep 60 & sleep 60"], { stdio: ["ignore", "pipe", "pipe"] });
}

const closed = (proc: ReturnType<typeof spawn>): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    proc.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

describe.skipIf(!posix)("killTree on real processes", () => {
  it("kills the grandchildren too, and 'close' fires", async () => {
    const proc = spawnTree();
    expect(await until(() => groupAlive(proc.pid))).toBe(true); // grandchild exists

    killTree(proc);
    expect(await closed(proc)).toBe(true); // false with a direct-child-only kill
    expect(await until(() => !groupAlive(proc.pid))).toBe(true);
  }, 15_000);

  it("is idempotent — a second kill of an exited child is a harmless no-op", async () => {
    const proc = spawnTree();
    await until(() => groupAlive(proc.pid));
    killTree(proc);
    await closed(proc);
    expect(() => killTree(proc)).not.toThrow();
    expect(await until(() => !groupAlive(proc.pid))).toBe(true);
  }, 15_000);

  // the agent can exit on its own while a tool it launched keeps running. The
  // group outlives its leader, so killTree must still reap it.
  it("reaps descendants that outlived the direct child", async () => {
    const proc = spawn("sh", ["-c", "sleep 60 & exit 0"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(await until(() => proc.exitCode !== null)).toBe(true); // direct child gone...
    expect(groupAlive(proc.pid)).toBe(true); // ...but its child is not

    killTree(proc);
    expect(await until(() => !groupAlive(proc.pid))).toBe(true);
  }, 15_000);

  // KNOWN LIMIT, pinned deliberately: the post-exit group kill is gated on the
  // child still being tracked (pipes still held), which is what proves the pgid
  // cannot have been recycled. A descendant that CLOSES the inherited pipes and
  // then outlives its parent therefore escapes — 'close' fires, the child is
  // released, and there is no longer any way to tell that pgid apart from a
  // recycled one. Killing it blind is the worse trade: it can SIGKILL an
  // unrelated process group.
  it("does NOT reap a descendant that released the pipes before the parent exited", async () => {
    const proc = spawn("sh", ["-c", "sleep 60 >/dev/null 2>&1 & exit 0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(await closed(proc)).toBe(true); // pipes released -> we DO settle cleanly
    const pgid = proc.pid;
    killTree(proc);
    expect(groupAlive(pgid)).toBe(true); // documented leak, not a hang

    if (pgid !== undefined) process.kill(-pgid, "SIGKILL"); // don't leak from the test
  }, 15_000);

  it("killAllChildren on teardown leaves nothing behind", async () => {
    const a = spawnTree();
    const b = spawnTree();
    expect(await until(() => groupAlive(a.pid) && groupAlive(b.pid))).toBe(true);

    killAllChildren();
    expect(await until(() => !groupAlive(a.pid) && !groupAlive(b.pid))).toBe(true);
  }, 15_000);
});

// The POSIX suite above proves the tree kill through process groups, which
// Windows does not have — so the taskkill path used to have no real-process
// coverage at all, only mocked assertions. This one is platform-agnostic: the
// grandchild reports its own pid through a file, so the test can ask the OS
// directly whether it survived. It is the same shape as a coding agent
// shelling out to a tool that outlives its parent.
describe("killTree kills a real grandchild on every platform", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0); // existence probe, kills nothing
      return true;
    } catch {
      return false;
    }
  };

  it("takes the grandchild down with the shell that started it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralphrun-tree-"));
    const pidFile = join(dir, "gc.pid");
    // grandchild: record my pid, then stay alive well past the test
    const script = `require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000);`;
    const node = process.execPath;

    const proc =
      process.platform === "win32"
        ? spawn("cmd", ["/c", node, "-e", script, pidFile], { stdio: ["ignore", "pipe", "pipe"] })
        : spawn("sh", ["-c", `"${node}" -e '${script}' "${pidFile}"`], { stdio: ["ignore", "pipe", "pipe"] });

    try {
      await until(() => existsSync(pidFile));
      const gcPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(gcPid)).toBe(true);
      expect(alive(gcPid)).toBe(true); // the grandchild is really running

      killTree(proc);
      expect(await until(() => !alive(gcPid))).toBe(true); // the kill reached it, not just its parent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
