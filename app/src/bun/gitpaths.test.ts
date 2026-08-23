// gitpaths.test.ts — worktree resolution goes through git's own porcelain
// listing, so these tests feed it the exact text git prints and check what
// survives the two filters: not the main checkout, and under .ralphrun.

import { describe, it, expect, vi, beforeEach } from "vitest";

const gitOut = vi.fn();
vi.mock("../../../src/git.js", () => ({ gitOut: (...a: unknown[]) => gitOut(...a) }));

const { listWorktreePaths, worktreeBase, worktreeDirFor } = await import("./gitpaths.ts");

const WS = "/dev/qc";

/** `git worktree list --porcelain` shape: blank-line separated stanzas. */
function porcelain(...dirs: string[]): string {
  return dirs.map((d) => `worktree ${d}\nHEAD 0000000000000000000000000000000000000000\ndetached\n`).join("\n");
}

beforeEach(() => vi.clearAllMocks());

describe("listWorktreePaths", () => {
  it("drops the main checkout and anything outside .ralphrun", () => {
    gitOut.mockReturnValue(
      porcelain(WS, `${WS}/.ralphrun/worktrees/t1`, `${WS}/.ralphrun/worktrees/t2`, "/dev/qc-hotfix"),
    );
    expect(listWorktreePaths(WS)).toEqual([`${WS}/.ralphrun/worktrees/t1`, `${WS}/.ralphrun/worktrees/t2`]);
    expect(gitOut).toHaveBeenCalledWith(WS, "worktree", "list", "--porcelain");
  });

  it("is empty when git says nothing — a folder that is not a repo yet", () => {
    gitOut.mockReturnValue(null);
    expect(listWorktreePaths(WS)).toEqual([]);
  });

  it("claims only the directory the core actually creates cells in", () => {
    // a substring match on \".ralphrun\" would adopt this unrelated worktree and
    // hand its diff to whichever task id its folder name happens to resemble
    gitOut.mockReturnValue(porcelain(WS, `${WS}/.ralphrun-old/t1`, `${WS}/.ralphrun/worktrees/t1`));
    expect(listWorktreePaths(WS)).toEqual([`${WS}/.ralphrun/worktrees/t1`]);
  });
});

describe("worktreeDirFor", () => {
  it("finds the plain sanitized directory", () => {
    gitOut.mockReturnValue(porcelain(WS, `${WS}/.ralphrun/worktrees/t4`));
    expect(worktreeDirFor(WS, "t4")).toBe(`${WS}/.ralphrun/worktrees/t4`);
  });

  it("finds the digest-suffixed form an id that needed sanitizing gets", () => {
    // the core appends the digest ONLY when sanitizing changed the id, because
    // sanitizing is many-to-one and the digest makes the mapping injective again
    gitOut.mockReturnValue(porcelain(WS, `${WS}/.ralphrun/worktrees/feat_login_ui-60c52762`));
    expect(worktreeDirFor(WS, "feat/login ui")).toBe(`${WS}/.ralphrun/worktrees/feat_login_ui-60c52762`);
  });

  it("does not hand a sanitized id the table belonging to a task literally called that", () => {
    // "feat/login ui" sanitizes to feat_login_ui — but a DIFFERENT task may
    // genuinely be named feat_login_ui, and owning its diff would be wrong
    gitOut.mockReturnValue(porcelain(WS, `${WS}/.ralphrun/worktrees/feat_login_ui`));
    expect(worktreeDirFor(WS, "feat/login ui")).toBeNull();
    expect(worktreeDirFor(WS, "feat_login_ui")).toBe(`${WS}/.ralphrun/worktrees/feat_login_ui`);
  });

  it("does not take a digest-suffixed table for an id that never needed one", () => {
    gitOut.mockReturnValue(porcelain(WS, `${WS}/.ralphrun/worktrees/t4-a3f8b2c1`));
    expect(worktreeDirFor(WS, "t4")).toBeNull();
  });

  it("checks the digest, not just its shape — two ids share this sanitized name", () => {
    // "feat/login ui" and "feat/login" both sanitize to a feat_login… prefix;
    // accepting any eight hex characters would hand one task the other's cell
    gitOut.mockReturnValue(porcelain(WS, `${WS}/.ralphrun/worktrees/feat_login-5d5c6df1`));
    expect(worktreeDirFor(WS, "feat/login")).toBe(`${WS}/.ralphrun/worktrees/feat_login-5d5c6df1`);
    expect(worktreeDirFor(WS, "feat:login")).toBeNull();
  });

  it("returns null rather than guessing when the task has no table on disk", () => {
    gitOut.mockReturnValue(porcelain(WS, `${WS}/.ralphrun/worktrees/t1`));
    expect(worktreeDirFor(WS, "t9")).toBeNull();
  });

  it("never mistakes a longer id for the one asked about", () => {
    // t10 starts with t1 but is a different table — only a `-` suffix counts.
    gitOut.mockReturnValue(porcelain(WS, `${WS}/.ralphrun/worktrees/t10`));
    expect(worktreeDirFor(WS, "t1")).toBeNull();
  });
});

describe("worktreeBase", () => {
  it("diffs against the commit the cell was cut from, not its HEAD", () => {
    // the executor is ALLOWED to commit inside its worktree; against HEAD the
    // diff would then be empty and the inbox would ask a human to approve a
    // task while showing no work at all
    gitOut.mockImplementation((_dir: string, ...args: string[]) =>
      args[0] === "rev-parse" ? "cafe1234" : args[0] === "merge-base" ? "base9876" : null,
    );
    expect(worktreeBase(WS, `${WS}/.ralphrun/worktrees/t1`)).toBe("base9876");
  });

  it("falls back to HEAD when git cannot answer", () => {
    gitOut.mockReturnValue(null);
    expect(worktreeBase(WS, `${WS}/.ralphrun/worktrees/t1`)).toBe("HEAD");
  });
});
