// spawn.test.ts — launch flags, tree-kill per platform, and teardown tracking.
// The REAL process behaviour (does the tree actually die?) is covered by
// spawn.integration.test.ts; this file pins the branching.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));

import crossSpawn from "cross-spawn";
import { spawnSync } from "node:child_process";
import { killAllChildren, killTree, resetSpawnTrackingForTests, spawn, writePrompt } from "./spawn.js";

const mCross = crossSpawn as unknown as ReturnType<typeof vi.fn>;
const mSpawnSync = vi.mocked(spawnSync);

type FakeProc = EventEmitter & { pid?: number; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> };

function fakeProc(over: Partial<FakeProc> = {}): FakeProc {
  const p = new EventEmitter() as FakeProc;
  p.pid = 4242;
  p.exitCode = null;
  p.signalCode = null;
  p.kill = vi.fn();
  return Object.assign(p, over);
}

const realPlatform = process.platform;
function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

/** run through our spawn() so the child is tracked / marked as a group leader */
function launch(proc: FakeProc): FakeProc {
  mCross.mockReturnValue(proc);
  return spawn("bin", ["a"], { cwd: "/w" }) as unknown as FakeProc;
}

function mkKillSpy() {
  return vi.spyOn(process, "kill").mockImplementation(() => true);
}
let killSpy: ReturnType<typeof mkKillSpy>;

beforeEach(() => {
  vi.clearAllMocks();
  mSpawnSync.mockReturnValue({ status: 0 } as never);
  resetSpawnTrackingForTests();
  killSpy = mkKillSpy();
});

afterEach(() => {
  setPlatform(realPlatform);
  killSpy.mockRestore();
  resetSpawnTrackingForTests();
});

describe("spawn", () => {
  it("goes through cross-spawn so a Windows .cmd shim can be launched at all", () => {
    setPlatform("win32");
    launch(fakeProc());
    expect(mCross).toHaveBeenCalledWith("bin", ["a"], expect.objectContaining({ cwd: "/w" }));
  });

  it("detaches on POSIX (own process group => killable as a tree)", () => {
    setPlatform("linux");
    launch(fakeProc());
    expect(mCross.mock.calls[0][2]).toMatchObject({ detached: true });
  });

  it("does NOT detach on Windows (no process groups; taskkill /T does the job)", () => {
    setPlatform("win32");
    launch(fakeProc());
    expect(mCross.mock.calls[0][2]).toMatchObject({ detached: false });
  });

  it("keeps the caller's options (cwd/stdio) alongside the platform flag", () => {
    setPlatform("darwin");
    mCross.mockReturnValue(fakeProc());
    spawn("bin", ["a"], { cwd: "/w", stdio: ["ignore", "pipe", "pipe"] });
    expect(mCross.mock.calls[0][2]).toMatchObject({ cwd: "/w", stdio: ["ignore", "pipe", "pipe"] });
  });
});

describe("killTree", () => {
  it("POSIX: kills the whole process GROUP, not just the child", () => {
    setPlatform("darwin");
    const proc = launch(fakeProc());
    killTree(proc as never);
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("POSIX: falls back to a single-process kill when the group is already gone (ESRCH)", () => {
    setPlatform("darwin");
    const proc = launch(fakeProc());
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    killTree(proc as never);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("POSIX: a child we did not spawn is never group-killed (that pgid is not ours to signal)", () => {
    setPlatform("darwin");
    const stray = fakeProc();
    killTree(stray as never);
    expect(killSpy).not.toHaveBeenCalled();
    expect(stray.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("Windows: taskkills the TREE — a .cmd shim's grandchild would otherwise hold the pipes open", () => {
    setPlatform("win32");
    const proc = launch(fakeProc());
    killTree(proc as never);
    expect(mSpawnSync).toHaveBeenCalledWith("taskkill", ["/pid", "4242", "/t", "/f"], { stdio: "ignore" });
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("Windows: a non-zero taskkill status (pid already gone) is NOT retried as a kill", () => {
    setPlatform("win32");
    const proc = launch(fakeProc());
    mSpawnSync.mockReturnValue({ status: 128 } as never);
    killTree(proc as never);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("Windows: falls back to SIGKILL when taskkill itself cannot be run", () => {
    setPlatform("win32");
    const proc = launch(fakeProc());
    mSpawnSync.mockReturnValue({ error: new Error("ENOENT") } as never);
    killTree(proc as never);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  // the group outlives its leader, so an exited agent whose grandchildren are
  // still holding the pipes open MUST still be group-killed
  it("POSIX: still group-kills after the direct child exited, to reap its descendants", () => {
    setPlatform("darwin");
    const proc = launch(fakeProc({ exitCode: 0 }));
    killTree(proc as never);
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(proc.kill).not.toHaveBeenCalled(); // the leader itself is already gone
  });

  // PID reuse guard: once the leader is reaped its pid is recyclable, so we may
  // only signal -pid while something still holds the pipes ('close' not fired),
  // which proves the group still has a member and cannot have been recycled.
  it("POSIX: does NOT group-kill an exited child whose pipes already closed", () => {
    setPlatform("darwin");
    const proc = launch(fakeProc({ exitCode: 0 }));
    proc.emit("close", 0); // pipes released -> nothing of ours is left in that group
    killTree(proc as never);
    expect(killSpy).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("POSIX: a transient group-kill failure (EPERM) keeps the child for a later retry", () => {
    setPlatform("darwin");
    const proc = launch(fakeProc());
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    killTree(proc as never);
    // killing the leader alone beats killing nothing...
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    killSpy.mockImplementation(() => true);
    killAllChildren(); // ...and teardown still knows about the group
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("POSIX: an empty group after exit is not escalated to a single-process kill", () => {
    setPlatform("darwin");
    const proc = launch(fakeProc({ exitCode: 0 }));
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    killTree(proc as never);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("Windows: is a no-op once the child exited (taskkill cannot walk a dead pid)", () => {
    setPlatform("win32");
    const proc = launch(fakeProc({ exitCode: 0 }));
    killTree(proc as never);
    expect(mSpawnSync).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("is a no-op once the child died from a signal", () => {
    setPlatform("win32");
    const proc = launch(fakeProc({ signalCode: "SIGKILL" }));
    killTree(proc as never);
    expect(mSpawnSync).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("is a no-op when spawn never produced a pid", () => {
    setPlatform("darwin");
    const proc = launch(fakeProc({ pid: undefined }));
    killTree(proc as never);
    expect(killSpy).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("swallows a kill() that races the child being reaped", () => {
    setPlatform("darwin");
    const stray = fakeProc();
    stray.kill.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(() => killTree(stray as never)).not.toThrow();
  });
});

describe("teardown tracking", () => {
  it("kills every live child, and only the live ones", () => {
    setPlatform("darwin");
    launch(fakeProc({ pid: 1 }));
    launch(fakeProc({ pid: 2 }));
    const gone = launch(fakeProc({ pid: 3 }));
    gone.emit("close", 0); // untracked from here on
    killAllChildren();
    expect(killSpy).toHaveBeenCalledWith(-1, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(-2, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalledWith(-3, "SIGKILL");
  });

  it("stops tracking a child that failed to spawn", () => {
    setPlatform("darwin");
    const bad = launch(fakeProc({ pid: 1 }));
    bad.emit("error", new Error("ENOENT"));
    killAllChildren();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("an explicit killTree also drops the child from the teardown set", () => {
    setPlatform("darwin");
    const proc = launch(fakeProc({ pid: 7 }));
    killTree(proc as never);
    killSpy.mockClear();
    killAllChildren();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("registers the process teardown hooks exactly once, no matter how many children", () => {
    setPlatform("darwin");
    const before = { exit: process.listenerCount("exit"), int: process.listenerCount("SIGINT") };
    launch(fakeProc({ pid: 1 }));
    launch(fakeProc({ pid: 2 }));
    expect(process.listenerCount("exit")).toBe(before.exit + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
  });

  it("the 'exit' hook kills leftover children so nothing is orphaned", () => {
    setPlatform("darwin");
    launch(fakeProc({ pid: 9 }));
    process.emit("exit", 0);
    expect(killSpy).toHaveBeenCalledWith(-9, "SIGKILL");
  });

  it("a signal kills the children, and defers exiting when another handler owns the signal", () => {
    setPlatform("darwin");
    const other = vi.fn();
    process.on("SIGINT", other); // stand-in for the TUI's own teardown handler
    try {
      launch(fakeProc({ pid: 5 }));
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      process.emit("SIGINT", "SIGINT");
      expect(killSpy).toHaveBeenCalledWith(-5, "SIGKILL");
      expect(other).toHaveBeenCalled();
      // someone else is still listening -> they own the exit, we must not preempt
      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    } finally {
      process.off("SIGINT", other);
    }
  });

  it("a signal with no other handler exits with the shell's 128+signo code", () => {
    setPlatform("darwin");
    launch(fakeProc({ pid: 5 }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      process.emit("SIGHUP", "SIGHUP"); // nothing else listens for SIGHUP in vitest
      expect(exitSpy).toHaveBeenCalledWith(129);
    } finally {
      exitSpy.mockRestore();
    }
  });

  // a `once` handler would be spent by the first signal, leaving every child
  // spawned afterwards with nobody to clean it up
  it("keeps cleaning up on a SECOND signal, and for children spawned after the first", () => {
    setPlatform("darwin");
    const other = vi.fn();
    process.on("SIGTERM", other); // someone else owns the shutdown -> we don't exit
    try {
      launch(fakeProc({ pid: 1 }));
      process.emit("SIGTERM", "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-1, "SIGKILL");

      killSpy.mockClear();
      launch(fakeProc({ pid: 2 })); // spawned AFTER the first signal
      process.emit("SIGTERM", "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-2, "SIGKILL");
    } finally {
      process.off("SIGTERM", other);
    }
  });

  it("the test reset removes the listeners it installed (no accumulation across suites)", () => {
    setPlatform("darwin");
    const before = process.listenerCount("SIGINT");
    launch(fakeProc({ pid: 1 }));
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    resetSpawnTrackingForTests();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("writePrompt", () => {
  it("pipes the prompt in and closes stdin, so the cli stops waiting", () => {
    const stdin = { on: vi.fn(), end: vi.fn() };
    writePrompt({ stdin } as never, "THE PROMPT");
    expect(stdin.end).toHaveBeenCalledWith("THE PROMPT");
    expect(stdin.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  // a cli that died before reading leaves us writing into a closed pipe; an
  // unhandled EPIPE on a child stream takes the whole process down
  it("swallows a broken pipe rather than crashing the run", () => {
    const handlers: Record<string, (e: Error) => void> = {};
    const stdin = {
      on: vi.fn((ev: string, fn: (e: Error) => void) => {
        handlers[ev] = fn;
      }),
      end: vi.fn(),
    };
    writePrompt({ stdin } as never, "P");
    expect(() => handlers.error(Object.assign(new Error("EPIPE"), { code: "EPIPE" }))).not.toThrow();
  });

  it("is a no-op when the child has no stdin (argv-prompt cli)", () => {
    expect(() => writePrompt({} as never, "P")).not.toThrow();
  });
});
