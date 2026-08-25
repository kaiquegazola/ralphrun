import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { git, captureDiff, captureReviewBase, headCommit, taskChangedPaths, commitPaths } from "./git.js";

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

  it("git() spawns git with args, cwd, stdio ignore, and returns the exit status", () => {
    mockSpawn.mockReturnValueOnce({ status: 1 } as any);
    expect(git("/ws", "commit", "-m", "x")).toBe(1);
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
    // cut at the cap, then TOLD it was cut — a silently truncated diff reads as
    // a whole one, and the reviewer approves what it never saw
    expect(out.startsWith("STAT\n\n")).toBe(true);
    expect(out.slice(0, 12000)).toBe(("STAT\n\n" + "F".repeat(20000)).slice(0, 12000));
    expect(out.slice(12000)).toContain("TRUNCATED at 12000 characters");
    expect(mockRm).toHaveBeenCalledWith("/tmp/ralphrun-index", { recursive: true, force: true });
  });

  it("captureDiff does not append the truncation note to a diff that fits", () => {
    mockExists.mockReturnValue(true);
    mockSpawn
      .mockReturnValueOnce({ stdout: "" } as any) // read-tree HEAD
      .mockReturnValueOnce({ stdout: "" } as any) // add -A
      .mockReturnValueOnce({ stdout: "STAT" } as any) // --stat
      .mockReturnValueOnce({ stdout: "short" } as any); // full

    expect(captureDiff("/ws")).toBe("STAT\n\nshort");
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

  // --no-renames matters: rename detection reports only the new path, so the old
  // path's deletion would never be staged and the commit would keep both copies
  it("taskChangedPaths lists NUL-separated paths changed since the baseline", () => {
    mockExists.mockReturnValue(true);
    mockSpawn
      .mockReturnValueOnce({ stdout: "" } as any) // read-tree HEAD
      .mockReturnValueOnce({ stdout: "" } as any) // add -A
      .mockReturnValueOnce({ status: 0, stdout: "src/a.ts\0src/b.ts\0" } as any);

    expect(taskChangedPaths("/ws", "base-tree")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      3,
      "git",
      ["diff", "--cached", "--name-only", "--no-renames", "-z", "base-tree", "--", "."],
      indexOptions,
    );
  });

  it("taskChangedPaths excludes runner control files when requested", () => {
    mockExists.mockReturnValue(true);
    mockSpawn
      .mockReturnValueOnce({ stdout: "" } as any) // read-tree HEAD
      .mockReturnValueOnce({ stdout: "" } as any) // add -A in private index
      .mockReturnValueOnce({ status: 0, stdout: "src/a.ts\0" } as any);

    expect(taskChangedPaths("/ws", "base-tree", ["/ws/prd.json", "progress.md"])).toEqual(["src/a.ts"]);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      3,
      "git",
      [
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "-z",
        "base-tree",
        "--",
        ".",
        ":(exclude)prd.json",
        ":(exclude)progress.md",
      ],
      indexOptions,
    );
  });

  // null is "cannot scope", NOT "nothing changed" — the caller stages everything
  // on null and would skip the commit entirely on []
  it("taskChangedPaths returns null without a baseline, without a repo, or when git fails", () => {
    mockExists.mockReturnValue(true);
    expect(taskChangedPaths("/ws", null)).toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();

    mockExists.mockReturnValue(false);
    expect(taskChangedPaths("/ws", "base-tree")).toBeNull();

    mockExists.mockReturnValue(true);
    mockSpawn
      .mockReturnValueOnce({ stdout: "" } as any)
      .mockReturnValueOnce({ stdout: "" } as any)
      .mockReturnValueOnce({ status: 128, stdout: "" } as any);
    expect(taskChangedPaths("/ws", "base-tree")).toBeNull();
  });

  it("commitPaths stages and commits only the given paths, NUL-separated on stdin", () => {
    mockSpawn.mockReturnValue({ status: 0 } as any);

    expect(commitPaths("/ws", ["src/a.ts", "with space.ts"], "T1: title")).toBe(true);
    const pathspecOptions = {
      cwd: "/ws",
      input: "src/a.ts\0with space.ts\0",
      stdio: ["pipe", "ignore", "ignore"],
    };
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "git",
      ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
      pathspecOptions,
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      "git",
      ["commit", "-m", "T1: title", "--pathspec-from-file=-", "--pathspec-file-nul"],
      pathspecOptions,
    );
  });

  // a path in neither the worktree nor the index makes `add` fatal, and a fatal
  // add stages NOTHING — say so rather than committing a half-empty tree
  it("commitPaths reports failure and does not commit when the scoped stage fails", () => {
    mockSpawn.mockReturnValueOnce({ status: 128 } as any);
    expect(commitPaths("/ws", ["gone.ts"], "T1: title")).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
