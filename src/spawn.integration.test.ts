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
    await wait(300); // let the grandchild exist
    expect(groupAlive(proc.pid)).toBe(true);

    killTree(proc);
    expect(await closed(proc)).toBe(true); // false with a direct-child-only kill
    await wait(200);
    expect(groupAlive(proc.pid)).toBe(false);
  }, 15_000);

  it("is idempotent — a second kill of an exited child is a harmless no-op", async () => {
    const proc = spawnTree();
    await wait(300);
    killTree(proc);
    await closed(proc);
    expect(() => killTree(proc)).not.toThrow();
    expect(groupAlive(proc.pid)).toBe(false);
  }, 15_000);

  // the agent can exit on its own while a tool it launched keeps running. The
  // group outlives its leader, so killTree must still reap it.
  it("reaps descendants that outlived the direct child", async () => {
    const proc = spawn("sh", ["-c", "sleep 60 & exit 0"], { stdio: ["ignore", "pipe", "pipe"] });
    // poll, don't sleep a fixed amount: under parallel test load the shell can
    // take longer than any constant you pick, which makes this flaky
    for (let i = 0; i < 100 && proc.exitCode === null; i++) await wait(50);
    expect(proc.exitCode).not.toBeNull(); // the direct child is already gone...
    expect(groupAlive(proc.pid)).toBe(true); // ...but its child is not

    killTree(proc);
    await wait(200);
    expect(groupAlive(proc.pid)).toBe(false);
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
    await wait(200);
    const pgid = proc.pid;
    killTree(proc);
    expect(groupAlive(pgid)).toBe(true); // documented leak, not a hang

    if (pgid !== undefined) process.kill(-pgid, "SIGKILL"); // don't leak from the test
  }, 15_000);

  it("killAllChildren on teardown leaves nothing behind", async () => {
    const a = spawnTree();
    const b = spawnTree();
    await wait(300);
    expect(groupAlive(a.pid)).toBe(true);
    expect(groupAlive(b.pid)).toBe(true);

    killAllChildren();
    await wait(300);
    expect(groupAlive(a.pid)).toBe(false);
    expect(groupAlive(b.pid)).toBe(false);
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
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
      const gcPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(gcPid)).toBe(true);
      expect(alive(gcPid)).toBe(true); // the grandchild is really running

      killTree(proc);
      for (let i = 0; i < 50 && alive(gcPid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(gcPid)).toBe(false); // ...and the kill reached it, not just its parent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
