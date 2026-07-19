// spawn.ts — the ONE place agent child processes are launched and killed.
//
// Killing a coding agent means killing a TREE: the agent shells out (git, npm,
// bash tools) and those grandchildren inherit our stdout/stderr pipes. Killing
// only the direct child leaves them alive, holding the pipes open, so the
// parent's 'close' event NEVER fires — the run hangs at 1800s/1800s forever
// after a timeout "killed" it. Measured on macOS and reported on Windows; this
// module fixes both, per platform:
//
//   POSIX — spawn detached (setsid), which makes the child the leader of its
//     own process group, so kill(-pid) takes the whole tree in one syscall.
//     Trade-off: a detached child is no longer in the terminal's foreground
//     group, so it does NOT receive Ctrl+C for free — hence the exit/signal
//     cleanup below, which is what keeps that from leaking orphans.
//
//   Windows — SIGKILL is TerminateProcess against the DIRECT child only, and
//     there are no process groups to signal, so shell out to
//     `taskkill /T /F`. Windows also cannot LAUNCH the agents at all with a
//     bare spawn(): every cli installed via npm lands on PATH as a `foo.cmd`
//     shim, and node's spawn neither walks PATHEXT nor may execute a .cmd
//     without a shell (the CVE-2024-27980 hardening) — it fails with
//     EINVAL/ENOENT. cross-spawn resolves the real file and wraps it in
//     cmd.exe with the right quoting; on POSIX it is a passthrough to
//     child_process.spawn, so the three platforms share one code path.
//
// Callers must STILL not trust 'close' alone after a kill — a stray process
// can outlive any of this. See the grace timers in executor.ts / advisor.ts.

import crossSpawn from "cross-spawn";
import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** every call site here spawns with stdout+stderr piped, so they are never null */
type PipedChild = ChildProcess & { stdout: Readable; stderr: Readable };

/** children we spawned that have not exited — killed on process teardown */
const live = new Set<ChildProcess>();
/** children we know lead their own process group (POSIX detached) */
const ownGroup = new WeakSet<ChildProcess>();

export function spawn(cmd: string, args: string[], opts: SpawnOptions): PipedChild {
  const detached = process.platform !== "win32";
  const proc = crossSpawn(cmd, args, { ...opts, detached }) as PipedChild;
  if (detached) ownGroup.add(proc);
  live.add(proc);
  const drop = (): void => {
    live.delete(proc);
  };
  proc.once("close", drop);
  proc.once("error", drop);
  installCleanup();
  return proc;
}

/** SIGKILL the child AND its descendants. Safe to call more than once. */
export function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) {
    live.delete(proc);
    return; // spawn failed — there is nothing to kill
  }
  // `!= null` on purpose: a settled child has a number/string here, a running
  // one has null, and a hand-rolled test double has undefined.
  const exited = proc.exitCode != null || proc.signalCode != null;

  let retain = false; // a kill that failed transiently stays in `live` for a retry
  if (process.platform !== "win32" && ownGroup.has(proc)) {
    // The group kill comes FIRST, and runs even when the leader already exited:
    // a process group outlives its leader, so this is the only thing that reaps
    // descendants still holding the inherited pipes open.
    //
    // `live.has` is what makes the post-exit case safe from PID reuse. Node
    // reaps the leader on 'exit', so its pid becomes recyclable from then on —
    // signalling -pid blind could hit an unrelated group. But a child is still
    // in `live` only while 'close' has NOT fired, i.e. while something is still
    // holding the inherited pipes, which means the group still has a member and
    // therefore its id cannot have been recycled.
    if (!exited || live.has(proc)) {
      try {
        process.kill(-pid, "SIGKILL"); // negative pid = the whole process group
        live.delete(proc);
        return;
      } catch (e) {
        // ESRCH: the group is empty already, or the child never reached setsid
        // — nothing is leaking. Anything else (EPERM) may be transient: keep it
        // in `live` so a later signal/teardown gets another attempt, and still
        // try the leader below — killing it alone beats killing nothing.
        retain = (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }
  }

  if (!retain) live.delete(proc);
  if (exited) return;

  if (process.platform === "win32") {
    // /T = tree, /F = force. `error` is set only when taskkill itself could not
    // be run (missing binary); a non-zero status just means the pid was gone.
    // NOTE: taskkill walks the live parent-pid chain, so if the direct child is
    // ALREADY gone its orphans cannot be found — hence the exit check above is
    // the honest limit of what Windows lets us clean up.
    const r = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    if (!r.error) return;
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // already reaped between the checks above and here — nothing to do
  }
}

/**
 * Let go of a child's output. Call this ONLY after killing it.
 *
 * A descendant that survived the kill can still hold — and write to — the
 * inherited pipes. Closing readline alone leaves the pipe plumbing attached, so
 * that data keeps flowing into a stream nobody reads and the fds stay open.
 * Destroying our end is the only thing that actually releases them.
 *
 * It is deliberately NOT called when the child closed on its own: there the
 * streams already ended, so there is nothing to release — and destroying them
 * could drop a final line readline had not emitted yet.
 */
export function releasePipes(proc: ChildProcess, merged: Writable, rl: Interface): void {
  rl.close();
  proc.stdout?.unpipe(merged);
  proc.stderr?.unpipe(merged);
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  merged.destroy();
}

/** kill every child still running. Synchronous: safe from an 'exit' handler. */
export function killAllChildren(): void {
  // no live.clear(): killTree drops what it actually killed and deliberately
  // KEEPS anything whose kill failed transiently, so a later signal retries it
  for (const proc of [...live]) killTree(proc);
}

// 128 + signal number, the shell convention for "died from this signal"
const SIGNAL_EXIT_CODE = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

let hooks: (() => void) | null = null;
function installCleanup(): void {
  if (hooks) return;
  // Persistent listeners, NOT `once`: a signal we do not exit on (because the
  // TUI owns the shutdown) must still leave a live handler behind for children
  // spawned afterwards, and for a second signal.
  const onSignal = (sig: keyof typeof SIGNAL_EXIT_CODE) => (): void => {
    killAllChildren();
    // Registering ANY listener for a signal suppresses node's default
    // (terminate). If ours is the only one, that default is now our job.
    if (process.listenerCount(sig) === 1) process.exit(SIGNAL_EXIT_CODE[sig]);
  };
  // normal exit / process.exit(): fires for every path that is not a signal
  process.on("exit", killAllChildren);
  const signalHandlers = (Object.keys(SIGNAL_EXIT_CODE) as (keyof typeof SIGNAL_EXIT_CODE)[]).map(
    (sig) => [sig, onSignal(sig)] as const,
  );
  for (const [sig, handler] of signalHandlers) process.on(sig, handler);

  hooks = (): void => {
    process.off("exit", killAllChildren);
    for (const [sig, handler] of signalHandlers) process.off(sig, handler);
  };
}

/** test seam: forget the tracked children and remove the cleanup listeners */
export function resetSpawnTrackingForTests(): void {
  live.clear();
  hooks?.();
  hooks = null;
}
