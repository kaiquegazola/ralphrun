import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("which", () => ({ default: { sync: vi.fn() } }));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn(), spawn: vi.fn() }));

import which from "which";
import { spawn, spawnSync } from "node:child_process";
import {
  BROWSER_TOOL,
  anyTaskUsesBrowser,
  browserGuidance,
  browserStatus,
  browserStatusAsync,
  taskUsesBrowser,
} from "./browser.js";
import type { Task } from "./prd.js";

const whichSync = vi.mocked(which.sync);
const mSpawn = vi.mocked(spawnSync);
const mSpawnAsync = vi.mocked(spawn);

beforeEach(() => vi.clearAllMocks());

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  title: "x",
  status: "todo",
  deps: [],
  retries: 0,
  description: "",
  acceptance: [],
  ...over,
});

describe("taskUsesBrowser", () => {
  it("is true when verify INVOKES dev-browser as a command token", () => {
    expect(taskUsesBrowser(task({ verify: "npm run build && dev-browser --headless < e2e.mjs" }))).toBe(true);
    expect(taskUsesBrowser(task({ verify: "dev-browser < e2e.mjs" }))).toBe(true); // at the start
    expect(taskUsesBrowser(task({ verify: "dev-browser<e2e.mjs" }))).toBe(true); // redirection, no space
  });

  it("is false for a mere substring / lookalike, not an invocation", () => {
    expect(taskUsesBrowser(task({ verify: "npm test" }))).toBe(false);
    expect(taskUsesBrowser(task({ verify: "dev-browser-old --headless" }))).toBe(false); // different binary
    expect(taskUsesBrowser(task({ verify: "run mydev-browser" }))).toBe(false); // substring of another word
  });

  it("is false when there is no verify command", () => {
    expect(taskUsesBrowser(task())).toBe(false);
  });
});

describe("anyTaskUsesBrowser", () => {
  it("is true when ANY task in the set invokes the tool", () => {
    expect(anyTaskUsesBrowser([task({ verify: "npm test" }), task({ verify: "dev-browser < e2e.mjs" })])).toBe(true);
  });

  it("is false when NO task in the set does (or the set is empty)", () => {
    expect(anyTaskUsesBrowser([task({ verify: "npm test" }), task()])).toBe(false);
    expect(anyTaskUsesBrowser([])).toBe(false);
  });
});

describe("browserStatus", () => {
  it("is 'missing' when the binary does not resolve on PATH", () => {
    whichSync.mockReturnValue(null as never);
    expect(browserStatus()).toBe("missing");
    expect(mSpawn).not.toHaveBeenCalled(); // no point probing a binary that isn't there
  });

  it("is 'ok' when it resolves AND `--help` exits 0, probing via shell (Windows .cmd shim)", () => {
    whichSync.mockReturnValue("/p/dev-browser" as never);
    mSpawn.mockReturnValue({ status: 0 } as never);
    expect(browserStatus()).toBe("ok");
    expect(mSpawn).toHaveBeenCalledWith(BROWSER_TOOL, ["--help"], expect.objectContaining({ stdio: "ignore", shell: true }));
  });

  it("is 'broken' when it resolves but `--help` fails (e.g. a broken Volta shim)", () => {
    whichSync.mockReturnValue("/p/dev-browser" as never);
    mSpawn.mockReturnValue({ status: 1 } as never); // non-zero exit / null on spawn failure
    expect(browserStatus()).toBe("broken");
  });
});

describe("browserStatusAsync (non-blocking probe for the wizard)", () => {
  const armChild = () => {
    const child = new EventEmitter();
    mSpawnAsync.mockReturnValue(child as never);
    return child;
  };

  it("resolves 'missing' without spawning when the binary is absent", async () => {
    whichSync.mockReturnValue(null as never);
    await expect(browserStatusAsync()).resolves.toBe("missing");
    expect(mSpawnAsync).not.toHaveBeenCalled();
  });

  it("resolves 'ok' when `--help` closes with 0 (spawned via shell)", async () => {
    whichSync.mockReturnValue("/p/dev-browser" as never);
    const child = armChild();
    const p = browserStatusAsync();
    child.emit("close", 0);
    await expect(p).resolves.toBe("ok");
    expect(mSpawnAsync).toHaveBeenCalledWith(BROWSER_TOOL, ["--help"], expect.objectContaining({ shell: true }));
  });

  it("resolves 'broken' on a non-zero/null close (hang killed by timeout)", async () => {
    whichSync.mockReturnValue("/p/dev-browser" as never);
    const child = armChild();
    const p = browserStatusAsync();
    child.emit("close", null);
    await expect(p).resolves.toBe("broken");
  });

  it("resolves 'broken' on a spawn error (never throws / crashes the wizard)", async () => {
    whichSync.mockReturnValue("/p/dev-browser" as never);
    const child = armChild();
    const p = browserStatusAsync();
    child.emit("error", new Error("ENOENT"));
    await expect(p).resolves.toBe("broken");
  });
});

describe("browserGuidance", () => {
  it("names the tool and points at its runtime --help (not an embedded copy)", () => {
    const g = browserGuidance();
    expect(g).toContain(BROWSER_TOOL);
    expect(g).toContain(`${BROWSER_TOOL} --help`);
    expect(g.toLowerCase()).toContain("throws");
  });
});
