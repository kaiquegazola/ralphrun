// spawn.integration.test.ts — REAL processes. This is the test that actually
// proves the bug is fixed: a killed agent must take its grandchildren with it,
// and 'close' must fire (a surviving grandchild holding the inherited pipes is
// exactly what hung a run at 1800s/1800s forever).
//
// Liveness is probed with signal 0 against the child's process GROUP: it stays
// alive as long as ANY member does, which is precisely the thing that used to
// leak. POSIX only — the Windows path (taskkill /T /F) is pinned by the unit
// tests in spawn.test.ts.
import { describe, expect, it } from "vitest";

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
    await wait(400);
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
