import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { git, captureDiff } from "./git.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

const mockSpawn = vi.mocked(spawnSync);
const mockExists = vi.mocked(existsSync);

describe("git", () => {
  beforeEach(() => vi.clearAllMocks());

  it("git() spawns git with args, cwd, stdio ignore", () => {
    git("/ws", "commit", "-m", "x");
    expect(mockSpawn).toHaveBeenCalledWith("git", ["commit", "-m", "x"], {
      cwd: "/ws",
      stdio: "ignore",
    });
  });

  it("captureDiff returns '' when no .git", () => {
    mockExists.mockReturnValue(false);
    expect(captureDiff("/ws")).toBe("");
    expect(mockExists).toHaveBeenCalledWith("/ws/.git");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("captureDiff stages, gathers stat+full, slices to 12000", () => {
    mockExists.mockReturnValue(true);
    mockSpawn
      .mockReturnValueOnce({ stdout: "" } as any) // add -A
      .mockReturnValueOnce({ stdout: "STAT" } as any) // --stat
      .mockReturnValueOnce({ stdout: "F".repeat(20000) } as any); // full

    const out = captureDiff("/ws");

    expect(mockSpawn).toHaveBeenNthCalledWith(1, "git", ["add", "-A"], {
      cwd: "/ws",
      stdio: "ignore",
    });
    expect(mockSpawn).toHaveBeenNthCalledWith(2, "git", ["diff", "--cached", "--stat"], {
      cwd: "/ws",
      encoding: "utf8",
    });
    expect(mockSpawn).toHaveBeenNthCalledWith(3, "git", ["diff", "--cached"], {
      cwd: "/ws",
      encoding: "utf8",
    });
    expect(out.length).toBe(12000);
    expect(out.startsWith("STAT\n\n")).toBe(true);
  });
});
