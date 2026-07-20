import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { git, captureDiff, captureReviewBase, headCommit } from "./git.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdtempSync: vi.fn(() => "/tmp/ralphrun-index"),
  rmSync: vi.fn(),
}));

const mockSpawn = vi.mocked(spawnSync);
const mockExists = vi.mocked(existsSync);
const mockMkdtemp = vi.mocked(mkdtempSync);
const mockRm = vi.mocked(rmSync);
const indexOptions = {
  cwd: "/ws",
  encoding: "utf8",
  // git.ts builds this with join(), so the separator is the platform's
  env: expect.objectContaining({ GIT_INDEX_FILE: join("/tmp/ralphrun-index", "index") }),
};

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

  it("captureDiff stages, gathers stat+full, and excludes runner files and lockfiles", () => {
    mockExists.mockReturnValue(true);
    mockSpawn
      .mockReturnValueOnce({ stdout: "" } as any) // read-tree HEAD
      .mockReturnValueOnce({ stdout: "" } as any) // add -A in private index
      .mockReturnValueOnce({ stdout: "STAT" } as any) // --stat
      .mockReturnValueOnce({ stdout: "F".repeat(20000) } as any); // full

    const out = captureDiff("/ws");

    expect(mockSpawn).toHaveBeenNthCalledWith(2, "git", ["add", "-A"], indexOptions);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      3,
      "git",
      [
        "diff", "--cached", "--stat", "--", ".",
        ":(exclude)prd.json", ":(exclude)progress.md", ":(exclude)ralph.config.json",
        ":(exclude)package-lock.json", ":(exclude)npm-shrinkwrap.json", ":(exclude)yarn.lock",
        ":(exclude)pnpm-lock.yaml", ":(exclude)bun.lock", ":(exclude)bun.lockb",
      ],
      indexOptions,
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      4,
      "git",
      [
        "diff", "--cached", "--", ".",
        ":(exclude)prd.json", ":(exclude)progress.md", ":(exclude)ralph.config.json",
        ":(exclude)package-lock.json", ":(exclude)npm-shrinkwrap.json", ":(exclude)yarn.lock",
        ":(exclude)pnpm-lock.yaml", ":(exclude)bun.lock", ":(exclude)bun.lockb",
      ],
      indexOptions,
    );
    expect(out.length).toBe(12000);
    expect(out.startsWith("STAT\n\n")).toBe(true);
    expect(mockRm).toHaveBeenCalledWith("/tmp/ralphrun-index", { recursive: true, force: true });
  });

  it("captureDiff returns whitespace-only diff when only runner control files changed", () => {
    mockExists.mockReturnValue(true);
    mockSpawn
      .mockReturnValueOnce({ stdout: "" } as any) // read-tree HEAD
      .mockReturnValueOnce({ stdout: "" } as any) // add -A
      .mockReturnValueOnce({ stdout: "" } as any) // filtered --stat
      .mockReturnValueOnce({ stdout: "" } as any); // filtered full

    expect(captureDiff("/ws").trim()).toBe("");
  });

  it("compares the staged state against a task baseline when supplied", () => {
    mockExists.mockReturnValue(true);
    mockSpawn
      .mockReturnValueOnce({ stdout: "" } as any)
      .mockReturnValueOnce({ stdout: "" } as any)
      .mockReturnValueOnce({ stdout: "STAT" } as any)
      .mockReturnValueOnce({ stdout: "DIFF" } as any);

    captureDiff("/ws", "base-commit");

    expect(mockSpawn).toHaveBeenNthCalledWith(
      3,
      "git",
      expect.arrayContaining(["diff", "--cached", "--stat", "base-commit"]),
      indexOptions,
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      4,
      "git",
      expect.arrayContaining(["diff", "--cached", "base-commit"]),
      indexOptions,
    );
  });

  it("reads HEAD when a repository already has a commit", () => {
    mockExists.mockReturnValue(true);
    mockSpawn.mockReturnValue({ stdout: "abc123\n" } as any);
    expect(headCommit("/ws")).toBe("abc123");
    expect(mockSpawn).toHaveBeenCalledWith("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: "/ws",
      encoding: "utf8",
    });
  });

  it("returns null for missing repositories and unresolved Git objects", () => {
    mockExists.mockReturnValue(false);
    expect(headCommit("/ws")).toBeNull();
    expect(captureReviewBase("/ws")).toBeNull();

    mockExists.mockReturnValue(true);
    mockSpawn.mockReturnValue({ stdout: "" } as any);
    expect(headCommit("/ws")).toBeNull();
    expect(captureReviewBase("/ws")).toBeNull();
  });

  it("captures an index-tree baseline without requiring an existing commit", () => {
    mockExists.mockReturnValue(true);
    mockSpawn
      .mockReturnValueOnce({ stdout: "" } as any) // read-tree HEAD
      .mockReturnValueOnce({ stdout: "" } as any) // add -A
      .mockReturnValueOnce({ stdout: "tree123\n" } as any); // write-tree

    expect(captureReviewBase("/ws")).toBe("tree123");
    expect(mockSpawn).toHaveBeenNthCalledWith(2, "git", ["add", "-A"], indexOptions);
    expect(mockSpawn).toHaveBeenNthCalledWith(3, "git", ["write-tree"], indexOptions);
    expect(mockMkdtemp).toHaveBeenCalled();
  });
});
