// worktrees.ts — the "mesas de trabalho" screen's data. Every live cell of a
// parallel run is a real detached git worktree under .ralphrun/worktrees; this
// reads them straight from git rather than from bookkeeping, so what the screen
// shows is what is actually on disk (including a table left behind by a crash).

import { basename } from "node:path";

import { captureReviewBase, gitOut } from "../../../src/git.js";
import { listWorktreePaths, worktreeBase, worktreeDirFor } from "./gitpaths.ts";
import { getRunDetail, listRuns } from "./runs.ts";
import { currentBranch } from "./registry.ts";
import type { TrunkView, WorktreeView } from "../shared/types.ts";

/**
 * A cell's work, as two TREES: the commit it was cut from and a snapshot of it
 * taken now. Comparing trees is what makes NEW files appear — a diff against a
 * commit reports tracked paths only, and a task whose whole contribution is new
 * files would show a card that says it did nothing.
 */
function diffFiles(workspace: string, dir: string): { files: WorktreeView["files"]; totals: WorktreeView["totals"] } {
  const now = captureReviewBase(dir);
  const out = (now ? gitOut(dir, "diff", "--numstat", worktreeBase(workspace, dir), now) : null) ?? "";
  const files: WorktreeView["files"] = [];
  let added = 0;
  let removed = 0;
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const a = Number(parts[0]) || 0;
    const r = Number(parts[1]) || 0;
    files.push({ path: parts[2], added: a, removed: r });
    added += a;
    removed += r;
  }
  // biggest change first: the card only has room for three rows, and the three
  // that matter are the ones the task actually rewrote.
  files.sort((x, y) => y.added + y.removed - (x.added + x.removed));
  return { files, totals: { files: files.length, added, removed } };
}

export function worktreesFor(projectId: string, workspace: string): { worktrees: WorktreeView[]; trunk: TrunkView } {
  const runs = listRuns().filter((r) => r.projectId === projectId);
  const live = runs
    .filter((r) => r.endedAt === null)
    .flatMap((r) => getRunDetail(r.id).tasks.map((t) => ({ task: t, executor: r.executor.cli })));
  const byTask = new Map(live.map((x) => [x.task.id, x]));

  // Map TASK → directory, never directory → task: the core's id-to-folder rule
  // is many-to-one plus a digest, so reversing it by stripping a suffix both
  // misses sanitized ids and mangles a safe id that happens to end in -deadbeef.
  const dirOfTask = new Map<string, string>();
  for (const id of byTask.keys()) {
    const dir = worktreeDirFor(workspace, id);
    if (dir) dirOfTask.set(dir, id);
  }

  const worktrees: WorktreeView[] = listWorktreePaths(workspace).map((dir) => {
    // a directory with no live task is a leftover — a crash's litter, or a run
    // this app session never started. Show it, named after the folder.
    const id = dirOfTask.get(dir) ?? basename(dir);
    const entry = byTask.get(id);
    const task = entry?.task;
    const { files, totals } = diffFiles(workspace, dir);
    const gates = {
      exec: task?.gates?.exec ?? null,
      tests: task?.gates?.tests ?? null,
      review: task?.gates?.review ?? null,
    };
    const state: WorktreeView["state"] = task?.status === "blocked" ? "attention" : "active";
    const note =
      task?.status === "blocked"
        ? (task.reason ?? "mesa congelada, aguarda decisão")
        : gates.tests === false
          ? `✗ verify falhou · rodada ${task?.round?.n ?? 1} corrigindo`
          : null;

    return {
      taskId: id,
      path: dir,
      shortPath: `worktrees/${basename(dir)}`,
      title: task?.title ?? "(task fora da run ativa)",
      agentCli: entry?.executor ?? null,
      state,
      gates,
      note,
      files: files.slice(0, 3),
      totals,
    };
  });

  // A merged table is gone from disk by design (cherry-pick → remove), so the
  // "voltou ao trunk ✓" cards come from the run's own record of done tasks.
  for (const r of runs.filter((x) => x.endedAt === null)) {
    for (const t of getRunDetail(r.id).tasks) {
      if (t.status !== "done") continue;
      if (worktrees.some((w) => w.taskId === t.id)) continue;
      worktrees.push({
        taskId: t.id,
        path: "",
        shortPath: "",
        title: t.title,
        agentCli: r.executor.cli,
        state: "merged",
        gates: { exec: true, tests: true, review: true },
        note: "cherry-pick → trunk · worktree removida",
        files: [],
        totals: { files: 0, added: 0, removed: 0 },
      });
    }
  }

  const branch = currentBranch(workspace) ?? "trunk";
  // %x1f as the field separator: a commit subject may contain anything a
  // human types, and | was already ambiguous the first time someone used it.
  const log = gitOut(workspace, "log", "-12", "--pretty=%h%x1f%s%x1f%cr") ?? "";
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, ago] = line.split("\x1f");
      // the core commits as "{id}: {title}" by default — recovering the id is
      // what lets the trunk bar read "t4 a3f8" like the mockup.
      const m = /^([A-Za-z0-9._-]+):/.exec(subject ?? "");
      return { sha: sha ?? "", taskId: m ? m[1] : null, subject: subject ?? "", ago: ago ?? "" };
    });
  const todayCount = commits.filter((c) => /hour|minute|second|hora|minuto|segundo/.test(c.ago)).length;

  return { worktrees, trunk: { branch, commits: commits.slice(0, 6), todayCount } };
}
