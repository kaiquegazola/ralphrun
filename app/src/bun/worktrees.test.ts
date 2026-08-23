// worktrees.test.ts — the "mesas de trabalho" screen reads disk, not
// bookkeeping, so the seam under test is git's own output: the porcelain
// worktree list, `diff --numstat`, and the trunk log. runs.ts is mocked
// because a real run needs a supervisor and child processes.

import { describe, it, expect, vi, beforeEach } from "vitest";

const gitOut = vi.fn();
const listRuns = vi.fn();
const getRunDetail = vi.fn();

vi.mock("../../../src/git.js", () => ({
  gitOut: (...a: unknown[]) => gitOut(...a),
  // a cell is diffed as two TREES: the commit it was cut from, and this
  captureReviewBase: () => "NOW",
}));
vi.mock("./runs.ts", () => ({
  listRuns: () => listRuns(),
  getRunDetail: (id: string) => getRunDetail(id),
}));
vi.mock("./registry.ts", () => ({ currentBranch: () => "main" }));

const { worktreesFor } = await import("./worktrees.ts");
const { run, runDetail, task } = await import("../mainview/testing.tsx");

const WS = "/dev/qc";
const dir = (name: string) => `${WS}/.ralphrun/worktrees/${name}`;

/** Wires the three git calls worktreesFor makes, keyed by subcommand. */
function git(opts: { worktrees?: string[]; numstat?: Record<string, string>; log?: string }) {
  gitOut.mockImplementation((cwd: string, ...args: string[]) => {
    if (args[0] === "worktree") {
      return [WS, ...(opts.worktrees ?? [])].map((d) => `worktree ${d}\ndetached\n`).join("\n");
    }
    if (args[0] === "diff") return opts.numstat?.[cwd] ?? "";
    if (args[0] === "log") return opts.log ?? "";
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listRuns.mockReturnValue([]);
  getRunDetail.mockReturnValue(runDetail({ tasks: [] }));
  git({});
});

describe("worktreesFor · mesas", () => {
  it("parses --numstat into files and totals, biggest change first", () => {
    git({
      worktrees: [dir("t4")],
      numstat: {
        [dir("t4")]: [
          "3\t1\tsrc/small.ts",
          "40\t12\tsrc/big.ts",
          "10\t0\tsrc/mid.ts",
          "-\t-\tassets/logo.png", // binary: git prints dashes, not counts
          "", // trailing newline from git
        ].join("\n"),
      },
    });
    const { worktrees } = worktreesFor("p1", WS);
    expect(worktrees).toHaveLength(1);
    // only three rows fit on the card, and they are the three that matter
    expect(worktrees[0].files.map((f) => f.path)).toEqual(["src/big.ts", "src/mid.ts", "src/small.ts"]);
    expect(worktrees[0].totals).toEqual({ files: 4, added: 53, removed: 13 });
  });

  it("maps a sanitized-and-digested folder back to the task that owns it", () => {
    // an id git cannot use as a folder name is sanitized AND digested by the
    // core; the card has to find its way back through that, not by guessing
    listRuns.mockReturnValue([run({ id: "r1", projectId: "p1" })]);
    getRunDetail.mockReturnValue(
      runDetail({ tasks: [task({ id: "feat/login", title: "Login screen", status: "doing" })] }),
    );
    git({ worktrees: [dir("feat_login-5d5c6df1")] });
    const { worktrees } = worktreesFor("p1", WS);
    expect(worktrees[0].taskId).toBe("feat/login");
    expect(worktrees[0].title).toBe("Login screen");
    expect(worktrees[0].agentCli).toBe("codex");
    expect(worktrees[0].shortPath).toBe("worktrees/feat_login-5d5c6df1");
    expect(worktrees[0].state).toBe("active");
  });

  it("keeps a table left behind by a crash, labelled as orphan", () => {
    git({ worktrees: [dir("t9")] });
    const { worktrees } = worktreesFor("p1", WS);
    expect(worktrees[0].title).toBe("(task fora da run ativa)");
    expect(worktrees[0].agentCli).toBeNull();
  });

  it("shows a blocked task as attention, with the task's own reason", () => {
    listRuns.mockReturnValue([run({ id: "r1", projectId: "p1" })]);
    getRunDetail.mockReturnValue(
      runDetail({ tasks: [task({ id: "t4", status: "blocked", reason: "schema ambíguo" })] }),
    );
    git({ worktrees: [dir("t4")] });
    const { worktrees } = worktreesFor("p1", WS);
    expect(worktrees[0].state).toBe("attention");
    expect(worktrees[0].note).toBe("schema ambíguo");
  });

  it("falls back to a generic note when a blocked task gives no reason", () => {
    listRuns.mockReturnValue([run({ id: "r1", projectId: "p1" })]);
    getRunDetail.mockReturnValue(runDetail({ tasks: [task({ id: "t4", status: "blocked" })] }));
    git({ worktrees: [dir("t4")] });
    expect(worktreesFor("p1", WS).worktrees[0].note).toBe("mesa congelada, aguarda decisão");
  });

  it("reports the fix-up round while verify is red but the table is still active", () => {
    listRuns.mockReturnValue([run({ id: "r1", projectId: "p1" })]);
    getRunDetail.mockReturnValue(
      runDetail({
        tasks: [task({ id: "t4", status: "doing", gates: { exec: true, tests: false }, round: { n: 2, max: 3 } })],
      }),
    );
    git({ worktrees: [dir("t4")] });
    const [w] = worktreesFor("p1", WS).worktrees;
    expect(w.state).toBe("active");
    expect(w.note).toBe("✗ verify falhou · rodada 2 corrigindo");
    expect(w.gates).toEqual({ exec: true, tests: false, review: null });
  });

  it("ignores runs from another project", () => {
    listRuns.mockReturnValue([run({ id: "r1", projectId: "outro" })]);
    git({ worktrees: [dir("t4")] });
    worktreesFor("p1", WS);
    expect(getRunDetail).not.toHaveBeenCalled();
  });

  it("adds merged cards for done tasks whose worktree is already gone", () => {
    listRuns.mockReturnValue([run({ id: "r1", projectId: "p1" })]);
    getRunDetail.mockReturnValue(
      runDetail({ tasks: [task({ id: "t1", status: "done" }), task({ id: "t4", status: "doing" })] }),
    );
    git({ worktrees: [dir("t4")] });
    const { worktrees } = worktreesFor("p1", WS);
    const merged = worktrees.filter((w) => w.state === "merged");
    expect(merged).toHaveLength(1);
    expect(merged[0].taskId).toBe("t1");
    // the table is off disk: nothing to diff, nothing to open
    expect(merged[0].files).toEqual([]);
    expect(merged[0].path).toBe("");
    expect(merged[0].gates).toEqual({ exec: true, tests: true, review: true });
    expect(merged[0].note).toBe("cherry-pick → trunk · worktree removida");
  });

  it("does not duplicate a done task that still has a table on disk", () => {
    listRuns.mockReturnValue([run({ id: "r1", projectId: "p1" })]);
    getRunDetail.mockReturnValue(runDetail({ tasks: [task({ id: "t4", status: "done" })] }));
    git({ worktrees: [dir("t4")] });
    const { worktrees } = worktreesFor("p1", WS);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].state).toBe("active");
  });
});

describe("worktreesFor · trunk", () => {
  it("splits the log on %x1f, so a pipe inside a subject stays in the subject", () => {
    git({
      log: [
        "a3f8b2c\x1ft4: parser lida com a|b nos filtros\x1f12 minutes ago",
        "b1c2d3e\x1ft1: contracts\x1f2 hours ago",
        "c9d8e7f\x1fmerge branch main\x1f3 days ago",
      ].join("\n"),
    });
    const { trunk } = worktreesFor("p1", WS);
    expect(trunk.branch).toBe("main");
    expect(trunk.commits[0]).toEqual({
      sha: "a3f8b2c",
      taskId: "t4",
      subject: "t4: parser lida com a|b nos filtros",
      ago: "12 minutes ago",
    });
    // no "{id}:" prefix means no task to attribute it to
    expect(trunk.commits[2].taskId).toBeNull();
    // only hours/minutes/seconds count as today; "3 days ago" does not
    expect(trunk.todayCount).toBe(2);
  });

  it("survives a log line without the separator and keeps only six commits", () => {
    git({ log: ["ffffff1", ...Array.from({ length: 8 }, (_, i) => `sha${i}\x1ft${i}: x\x1f${i} hours ago`)].join("\n") });
    const { trunk } = worktreesFor("p1", WS);
    expect(trunk.commits).toHaveLength(6);
    expect(trunk.commits[0]).toEqual({ sha: "ffffff1", taskId: null, subject: "", ago: "" });
  });
});
