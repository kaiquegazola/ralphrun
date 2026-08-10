// taskrun.ts — one task, from START to a settled status in prd.json, plus the
// two decisions that surround it: which tasks a wave dispatches together, and
// whether the merged result of that wave still holds.
//
// Split out of runLoop, which owned this AND the run's own long-lived state and
// was 641 lines for it. The seam is the context below: everything a cell needs
// is named there instead of captured, so what a task can reach is a list you can
// read rather than a scope you have to trace.

import { performance } from "node:perf_hooks";

import { type Config } from "./config.js";
import { createElapsedTracker, type ElapsedTracker } from "./elapsed.js";
import { captureReviewBase, commitPaths, git, headCommit, taskChangedPaths } from "./git.js";
import { t } from "./i18n.js";
import { log } from "./log.js";
import { advisorPlanKey, invalidatePlan } from "./plan-cache.js";
import { readyTasks, type PRD, type Task } from "./prd.js";
import { appendLearnedNote, pathsOutsideScope, type NormalizePrdOptions } from "./prdload.js";
import { readStandards } from "./prompts.js";
import { runTask, type RunTaskResult } from "./run.js";
import { formatCost, mergeCost, type CostTally } from "./stream.js";
import { type RunOptions } from "./startrun.js";
import { emit } from "./tui/events.js";
import { type TuiHandle } from "./tui/mount.js";
import { runVerifyCommand } from "./verify.js";
import { createTaskWorktree, mergeBackTaskWork, removeTaskWorktree, worktreeLoss } from "./worktree.js";

/**
 * Everything a task cell may reach.
 *
 * The split matters. Fields the factory DESTRUCTURES are fixed for the run.
 * `cfg` and `tui` are replaced by the mid-run config menu, and the four
 * counters are written by a cell and read by the run's final accounting — those
 * stay on the object and are addressed through it, which is the only reason this
 * can live outside runLoop at all.
 */
export interface TaskRunnerCtx {
  opts: RunOptions;
  prdPath: string;
  workspace: string;
  progress: string;
  reload: (o?: NormalizePrdOptions) => PRD | null;
  savePRD: (path: string, prd: PRD) => void;
  /** ends the run: unmounts, releases the workspace, reports the accounting */
  done: () => void;
  elapsedTracker: ElapsedTracker;
  trackers: Set<ElapsedTracker>;
  pendingReviewFeedback: Map<string, string>;
  /**
   * The last attempt's own closing account, per task. A retry gets a brand-new
   * session and, in worktree mode, a workspace where that attempt was rolled
   * back — without this it re-derives the dead ends the last one paid for.
   */
  pendingHandoff: Map<string, string>;
  /** the worktree as it stood when each task STARTED, kept across its retries */
  taskBaselines: Map<string, string | null>;
  taskCost: Map<string, CostTally>;
  runCost: CostTally;
  /** the run's money ceiling, 0 = none. Read once at startup and never re-read. */
  maxCostUsd: number;

  /** REPLACED mid-run by the config menu — never destructure these two */
  cfg: Config;
  tui: TuiHandle | null;

  /** written by a cell, read by the run */
  curTaskId: string;
  batchSkipped: boolean;
  accepted: number;
  tasksRun: number;
}

/**
 * What became of a worktree's work. "uncommitted" is the one that is NOT a git
 * merge outcome: the transport commit itself never happened, so there is nothing
 * for the pick to carry and nothing a sha can recover.
 */
type LandResult = "ok" | "conflict" | "dirty" | "uncommitted";

function landBlockReason(landed: LandResult): string {
  if (landed === "uncommitted") return t("loop.reason.commitRefused");
  return landed === "dirty" ? t("loop.reason.mergeDirty") : t("loop.reason.mergeConflict");
}

/**
 * The one decision point for a task the reviewer refused. It used to live inside
 * `if (tui)`, which meant the gate existed only in the UI layer: a headless run
 * had no gate at all and the task just went blocked. Both callers of the same
 * decision now route through here.
 *
 * Headless cannot prompt — nobody is watching, and a run that waits forever for
 * an answer is worse than one that decides — so its gate is a POLICY. It obeys
 * the same safety property as the TUI's approve key: `verified` is the only door
 * to "approve", so no policy can accept a task whose tests failed.
 *
 * Every headless refusal is logged with WHY, because progress.md is the only
 * audit trail a run nobody watched leaves behind. An acceptance is logged by the
 * caller, which is where the elapsed time and the commit are.
 */
async function reviewBlockedGate(
  tui: TuiHandle | null,
  cfg: Config,
  progress: string,
  id: string,
  displayReason: string,
  verified: boolean,
): Promise<"retry" | "approve" | "block" | "quit"> {
  if (tui) return tui.waitReviewBlocked(displayReason, verified);
  const wantsAccept = cfg.review_blocked_policy === "accept";
  if (wantsAccept && verified) return "approve";
  log(
    progress,
    t("loop.log.headlessBlocked", {
      id,
      why: wantsAccept ? t("loop.reason.policyNeedsVerify") : t("loop.reason.policyBlock"),
    }),
  );
  return "block";
}

function withReviewFeedback(reason: string, changes?: string): string {
  const compact = changes?.replace(/\s+/g, " ").trim();
  if (!compact) return reason;
  const max = 220;
  const summary = compact.length <= max ? compact : compact.slice(0, max - 1).trimEnd() + "…";
  return `${reason}: ${summary}`;
}

/**
 * true = this task's work is IN the history now (either a commit was made, or
 * there was nothing to commit). false = git refused the commit — a pre-commit
 * hook, an unset identity, a signing key it cannot use. That refusal is silent
 * on git's stdout, and in worktree mode it means the work never left the cell.
 */
function logTaskCommit(
  workspace: string,
  progress: string,
  id: string,
  title: string,
  cfg: Config,
  base?: string | null,
): boolean {
  const before = headCommit(workspace);
  // function replacers: a literal id/title is used verbatim (a "$&"/"$1" in a
  // task title must not be interpreted as a replacement pattern).
  const msg = (cfg.commit_message_template || "{id}: {title}").replace(/{id}/g, () => id).replace(/{title}/g, () => title);
  // Stage only what THIS task moved. `git add -A` also swept up whatever the
  // user happened to have uncommitted when the run started, putting their
  // unrelated work in a commit named after a task that never touched it — and
  // the review that approved this commit never saw those files either.
  const paths = taskChangedPaths(workspace, base);
  if (paths?.length === 0) return true; // nothing moved: no empty commit, nothing to log
  if (!paths || !commitPaths(workspace, paths, msg)) {
    // null = no baseline to scope against (no repo yet). A FAILED scoped stage is
    // different: the executor staged a rename or deletion despite being told not
    // to, so say so — this is the commit that can still swallow unrelated work.
    if (paths) log(progress, t("loop.log.commitUnscoped", { id }));
    git(workspace, "add", "-A");
    git(workspace, "commit", "-m", msg);
  }
  const after = headCommit(workspace);
  if (after && after !== before) {
    log(progress, t("loop.log.committed", { id, hash: shortHash(after) }));
    return true;
  }
  // HEAD is the only honest witness: `git commit` returns non-zero for a hook
  // that refused, an identity it cannot resolve and a signature it cannot make,
  // and none of that reaches us through the pathspec helper's exit status alone.
  // Not a failure when there was no repo to move a HEAD in the first place.
  return before === null && after === null;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

export function createTaskRunner(ctx: TaskRunnerCtx) {
  const { opts, prdPath, workspace, progress, reload, savePRD, done } = ctx;
  const { elapsedTracker, trackers, pendingReviewFeedback, pendingHandoff, taskBaselines, taskCost, runCost, maxCostUsd } = ctx;

  /**
   * One task, from START to a settled status in prd.json. "stop" means the whole
   * run is over and `done()` has already been called; "next" means keep looping.
   *
   * `solo` is the serial path — one task at a time, byte for byte what the loop
   * did before waves existed. In a wave several of these are in flight at once,
   * so nothing here may assume it owns the elapsed tracker, the pane, or the
   * copy of prd.json it last read.
   */
  const runOneTask = async (task: Task, prd: PRD, solo: boolean): Promise<"stop" | "next"> => {
    // Worktree mode changes WHERE a task runs, and it is decided before anything
    // else because a wave cannot proceed without it. null = no isolation
    // available: for a SOLO task that degrades to the main workspace with a line
    // rather than failing it, since infrastructure trouble is not something a
    // retry of the task can fix.
    const wt = ctx.cfg.worktree_per_task ? createTaskWorktree(workspace, task.id, ctx.cfg.worktree_link ?? []) : null;
    if (ctx.cfg.worktree_per_task && !wt) {
      log(progress, t("loop.log.worktreeUnavailable", { id: task.id }));
      // A wave has no such degradation: its siblings are already executing, and
      // N executors in one checkout is precisely what loadConfig refuses
      // (parallelNeedsWorktree) because they overwrite each other's files.
      // pickWave proves a repo EXISTS, never that `worktree add` will succeed.
      if (!solo) {
        const reason = t("loop.reason.noWorktree");
        task.status = "blocked";
        const cur = reload({ keepDoing: true });
        const ct = cur?.tasks.find((x) => x.id === task.id);
        if (cur && ct) {
          ct.status = "blocked";
          savePRD(prdPath, cur);
        }
        log(progress, t("loop.log.blockedReview", { id: task.id, s: 0, reason }));
        emit({ taskId: task.id, status: "blocked", reason });
        return "next";
      }
    }
    const taskWorkspace = wt ?? workspace;
    log(progress, t("loop.log.start", { id: task.id, title: task.title, n: task.retries + 1 }));
    task.status = "doing";
    // A wave has no single current task, and the reporter would otherwise stamp
    // every loop-level line with whichever task started last. Those lines carry
    // their own {id}; executor lines carry the real one on the event.
    ctx.curTaskId = solo ? task.id : "";
    const taskStartMs = performance.now();
    const tracker = solo ? elapsedTracker : createElapsedTracker(taskStartMs);
    if (!solo) trackers.add(tracker);
    if (ctx.tui) tracker.setPaused(ctx.tui.control.isPaused(), taskStartMs);
    tracker.startTask(taskStartMs);
    savePRD(prdPath, prd);
    emit({ taskId: task.id, title: task.title, status: "doing" });

    // per-task AbortController from the mount handle: the TUI skip control aborts
    // this signal → whichever child is live (executor, verify command, advisor or
    // reviewer) is SIGKILLed and run.ts stops opening review rounds. No TUI → no
    // cancellation.
    const signal = ctx.tui ? ctx.tui.control.beginTask() : undefined;
    const reviewRetryFeedback = pendingReviewFeedback.get(task.id);
    pendingReviewFeedback.delete(task.id);
    // consumed the same way: what the last attempt said is stale the moment this
    // one has said anything of its own
    const handoff = pendingHandoff.get(task.id);
    pendingHandoff.delete(task.id);

    let taskReviewBase: string | null | undefined;
    const reviewOn = ctx.cfg.review_after && !!ctx.cfg.advisor;
    // A declared `scope` is a THIRD, independent reason to need the baseline:
    // the gate below measures the task's footprint against it, and with no
    // baseline taskChangedPaths answers null, which the gate reads as "nothing
    // moved" and passes every escape. Without this clause a run with
    // commit_per_task off and review off has scopes that are documented as
    // enforced and are not checked at all.
    if (reviewOn || ctx.cfg.commit_per_task || (task.scope?.length ?? 0) > 0) {
      if (!taskBaselines.has(task.id)) taskBaselines.set(task.id, captureReviewBase(taskWorkspace));
    }
    if (reviewOn) taskReviewBase = taskBaselines.get(task.id);
    // in worktree mode this IS the base the worktree was cut from, so it doubles
    // as the left end of the cherry-pick range
    const taskStartCommit = headCommit(taskWorkspace);
    const planBeforeRun = task.plan;
    const planKeyBeforeRun = task.planKey;

    // In worktree mode the commit is the TRANSPORT: it is how the work leaves
    // the cell, so both it and the cherry-pick have to succeed before the task
    // may be called done. The serial path is untouched and still commits after
    // savePRD, where the commit carries the task's new status.
    //
    // Merge-back is serialized BY CONSTRUCTION, not by a lock: it runs after the
    // task's own await points on the orchestrator's single thread, and every
    // step of it is synchronous git, so two cherry-picks can never share an
    // index. The cost is a sub-second git call against minutes of agent time.
    // Consequence: the first task in a wave to finish defines the base the rest
    // land on, so history order inside a wave is nondeterministic. Fine — a wave
    // only ever holds tasks the graph does not order.
    //
    // A cell holds a prd.json frozen at its base commit, and that is CORRECT —
    // do not "fix" it with a symlink to the live file. The loop never reads the
    // cell's copy (every savePRD and reload uses prdPath), so a user editing the
    // backlog mid-run is seen either way. The only behaviour the frozen copy
    // changes is what happens when an executor breaks the rule and writes to
    // prd.json anyway: today its commit conflicts with the live file and the
    // task blocks. A symlink would instead let that write land directly in the
    // real backlog — turning a fail-closed rule violation into silent corruption
    // of the file the whole run is steered by.
    //
    // "someone already said, with a sha, what happened to this worktree's work" —
    // so the discard notice below does not repeat a line the merge already wrote.
    let worktreeAccounted = false;
    const landWorktreeWork = (): LandResult => {
      if (!wt) return "ok";
      const committed = logTaskCommit(taskWorkspace, progress, task.id, task.title, ctx.cfg, taskBaselines.get(task.id));
      const m = mergeBackTaskWork(workspace, wt, taskStartCommit);
      // "nothing to pick" is legitimate only when there was nothing to commit.
      // With a commit git refused — a pre-commit hook, an unset identity — the
      // cell's HEAD never moved, so the pick has nothing to carry and the work
      // exists ONLY in a directory the finally block is about to delete. Calling
      // that done is how a task lands in prd.json with zero lines to show for it.
      if (m.status === "nothing" && !committed) {
        log(progress, t("loop.log.commitRefused", { id: task.id }));
        return "uncommitted";
      }
      if (m.status === "conflict" || m.status === "dirty") {
        log(
          progress,
          t(m.status === "dirty" ? "loop.log.worktreeDirty" : "loop.log.worktreeConflict", {
            id: task.id,
            hash: shortHash(m.head ?? ""),
          }),
        );
        worktreeAccounted = true;
        return m.status;
      }
      worktreeAccounted = true;
      return "ok";
    };

    // unknown, not 0: if runTask throws before any executor settles, whatever it
    // already spent was never reported to us
    try {
      let result: RunTaskResult = { ok: false, reason: "failed", cost: { usd: 0, unknown: true } };
      try {
        result = await runTask(task, prd, ctx.cfg, taskWorkspace, progress, signal, reviewRetryFeedback, taskReviewBase, (plan, planKey) => {
          // Read-modify-write of prd.json, and it fires MID-task while siblings
          // are running. It must stay SYNCHRONOUS end to end — an await between
          // the reload and the save is exactly what lets a stale copy clobber a
          // sibling's status. See persist() below, same rule.
          const currentPrd = reload({ keepDoing: true });
          if (currentPrd) {
            const currentTask = currentPrd.tasks.find((x) => x.id === task.id);
            const advisor = ctx.cfg.advisor;
            const controlFileCacheUnchanged = currentTask?.plan === planBeforeRun && currentTask?.planKey === planKeyBeforeRun;
            if (
              currentTask &&
              advisor &&
              controlFileCacheUnchanged &&
              advisorPlanKey(currentTask, currentPrd, advisor, readStandards(taskWorkspace)) === planKey
            ) {
              currentTask.status = "doing";
              currentTask.plan = plan;
              currentTask.planKey = planKey;
              savePRD(prdPath, currentPrd);
            }
          }
        }, handoff);
      } catch (e) {
        log(progress, t("loop.log.crashed", { id: task.id, msg: e instanceof Error ? e.message : String(e) }));
        result = { ok: false, reason: "failed", cost: { usd: 0, unknown: true } };
      }
      const taskStopMs = performance.now();
      if (ctx.tui) tracker.setPaused(ctx.tui.control.isPaused(), taskStopMs);
      const elapsedMs = tracker.stopTask(taskStopMs);
      const elapsed = Math.round(elapsedMs / 1000);
      ctx.tasksRun += 1;
      const spent = taskCost.get(task.id) ?? { usd: 0, unknown: false };
      mergeCost(spent, result.cost);
      taskCost.set(task.id, spent);
      mergeCost(runCost, result.cost);
      // Silent when nothing was measured AND no budget is set: a line that says
      // "unknown" on every task of every cli that does not report cost is noise.
      if (spent.usd > 0 || maxCostUsd > 0) {
        log(progress, t("loop.log.cost", { id: task.id, cost: formatCost(spent), total: formatCost(runCost) }));
      }
      const taskEndCommit = headCommit(taskWorkspace);
      if (taskEndCommit && taskEndCommit !== taskStartCommit) {
        log(progress, t("loop.log.executorCommit", { id: task.id, hash: shortHash(taskEndCommit) }));
      }

      // quit pressed mid-task: the child was aborted, runTask returned. Exit now
      // without munging status — the task stays "doing" and recovery resets it next run.
      if (ctx.tui?.control.shouldQuit()) {
        done();
        log(progress, t("loop.log.quit"));
        return "stop";
      }
      if (ctx.tui?.control.takeSkip()) ctx.batchSkipped = true;
      const skipped = ctx.batchSkipped;

      // A GATE. `scope` is the contract the plan compiler refused overlapping
      // pairs on, and it is the whole reason a wave can be scheduled without a
      // runtime check — a task that edits outside it invalidated the proof its
      // wave was picked on, so the merge is no longer known to be safe.
      //
      // BEFORE landWorktreeWork below, deliberately: an escaped task must not
      // reach the trunk at all, and in worktree mode not landing means the cell
      // is discarded, which is the rollback. The escape goes back to the next
      // attempt as feedback rather than just blocking, because an executor told
      // only "you failed" fails the same way until the retries run out.
      //
      // An EMPTY scope declares nothing and so cannot escape, which is what
      // keeps every backlog written before `scope` existed running as before.
      const declaredScope = task.scope ?? [];
      if (!skipped && result.ok && declaredScope.length > 0) {
        const moved = taskChangedPaths(taskWorkspace, taskBaselines.get(task.id)) ?? [];
        const escaped = pathsOutsideScope(moved, declaredScope);
        if (escaped.length > 0) {
          const sample = escaped.slice(0, 3).join(", ") + (escaped.length > 3 ? ", …" : "");
          log(progress, t("loop.log.scopeEscape", { id: task.id, n: escaped.length, paths: sample }));
          pendingReviewFeedback.set(
            task.id,
            `This task edited ${escaped.length} file(s) outside the scope it declares in prd.json.` +
              `\nDeclared scope: ${declaredScope.join(", ")}` +
              `\nEdited outside it: ${escaped.join(", ")}` +
              `\nKeep the change inside the declared scope. If the task genuinely cannot be done` +
              ` without touching those paths, do the smallest version that stays in scope and say` +
              ` in your final message which path it needs and why — widening the scope is a change` +
              ` to the plan, which is not yours to make.`,
          );
          result = { ...result, ok: false, reason: "failed" };
        }
      }

      const fresh = reload({ keepDoing: true });
      if (!fresh) {
        done();
        return "stop";
      }
      // the just-run task can vanish if prd.json was rewritten mid-run — stop
      // gracefully instead of throwing on the status write.
      const freshTask = fresh.tasks.find((x) => x.id === task.id);
      if (!freshTask) {
        done();
        log(progress, t("loop.log.taskVanished", { id: task.id }));
        return "stop";
      }
      // THE prd.json write rule: re-read, copy only what this task settled, save
      // — all synchronously, so the whole read-modify-write is atomic w.r.t. the
      // event loop and no lock is needed. `fresh` above was read before the
      // review gate, which awaits; saving it wholesale would roll a sibling that
      // finished during that await back to its pre-settle status.
      const persist = (): void => {
        const cur = reload({ keepDoing: true });
        const ct = cur?.tasks.find((x) => x.id === task.id);
        if (!cur || !ct) return;
        ct.status = freshTask.status;
        ct.retries = freshTask.retries;
        ct.plan = freshTask.plan;
        ct.planKey = freshTask.planKey;
        // A project-level field, written inside the same synchronous
        // read-modify-write as the task's own status — the prd.json rule covers
        // the whole file, not one task's slice of it. Only ever on a DONE task,
        // and only what the reviewer chose to write.
        if (learned) {
          const next = appendLearnedNote(cur.architecture_notes, task.id, learned);
          if (next) {
            cur.architecture_notes = next;
            log(progress, t("loop.log.learned", { id: task.id, note: learned }));
          } else {
            // full or already known — say so, because silence here would look
            // like the reviewer never wrote one
            log(progress, t("loop.log.learnedDropped", { id: task.id }));
          }
        }
        savePRD(prdPath, cur);
      };
      // Set only where the task is about to be recorded done, so a note can
      // never ride in on a path that did not pass every gate.
      let learned: string | undefined;
      // Worktree mode lands the work BEFORE the status write: a task whose
      // commits cannot be cherry-picked back must never be recorded as done
      // with nothing in the main workspace to show for it. No-op serially.
      const landed = !skipped && result.ok ? landWorktreeWork() : "ok";

      if (skipped) {
        taskBaselines.delete(task.id);
        freshTask.status = "blocked";
        const reason = t("loop.reason.skipped");
        log(progress, t("loop.log.skipped", { id: task.id, s: elapsed }));
        emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
        persist();
      } else if (result.ok && landed === "ok") {
        freshTask.status = "done";
        learned = result.note;
        ctx.accepted += 1;
        log(progress, t("loop.log.done", { id: task.id, s: elapsed }));
        emit({ taskId: task.id, status: "done", elapsedMs });
        persist();
        // AFTER persist (the commit is meant to carry the task's new status) and
        // BEFORE the baseline is dropped — the commit needs it to know which paths
        // are this task's and which were already dirty. In worktree mode
        // landWorktreeWork already committed, because there the commit is the
        // only way the work gets out.
        if (ctx.cfg.commit_per_task && !wt) {
          logTaskCommit(workspace, progress, task.id, task.title, ctx.cfg, taskBaselines.get(task.id));
        }
        taskBaselines.delete(task.id);
      } else if (landed === "dirty" || landed === "uncommitted") {
        // A retry cannot help with either: the user's staged/uncommitted edit
        // will still be in the way next time, and a commit hook that refused
        // once refuses again. Blocking now saves a full agent run's spend.
        taskBaselines.delete(task.id);
        freshTask.status = "blocked";
        const reason = landBlockReason(landed);
        log(progress, t("loop.log.blockedReview", { id: task.id, s: elapsed, reason }));
        emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
        persist();
        // And stop the RUN, not just this task. Neither failure is about the
        // task: git refuses a cherry-pick while the trunk's index holds staged
        // content (any file — it need not be one the task touched), and a commit
        // hook refuses everyone equally. Every remaining task would execute in
        // full, at full price, and be blocked the same way. stop_on_blocked does
        // not gate this: the user has to act before anything else can land.
        done();
        log(progress, t("loop.log.stopWorkspace"));
        return "stop";
      } else if (result.reason === "review_stalled" || result.reason === "review_exhausted") {
        const reason = result.reason === "review_stalled" ? t("loop.reason.reviewStalled") : t("loop.reason.reviewExhausted");
        const displayReason = withReviewFeedback(reason, result.reviewChanges);
        // Replan rung of the recovery ladder. A stall means every fix round landed
        // on the identical failure, and the plan the executor was following is part
        // of that evidence — so it must not be replayed. Only on a stall: an
        // ordinary retry is what the cache exists for, and there the plan is not
        // the suspect. run.ts detects the stall, this owns prd.json, and each exit
        // below persists `freshTask`.
        if (result.reason === "review_stalled") {
          invalidatePlan(freshTask);
          log(progress, t("loop.log.planInvalidated", { id: task.id }));
        }
        const allowReviewOverride = result.verificationPassed === true;
        // A wave passes ctx.tui=null on purpose: the modal asks ONE human about ONE
        // task and would freeze every sibling behind that answer. The headless
        // POLICY path already exists and keeps the same safety property —
        // `verified` is still the only door to approve.
        const action = await reviewBlockedGate(solo ? ctx.tui : null, ctx.cfg, progress, task.id, displayReason, allowReviewOverride);
        if (action === "quit") {
          done();
          log(progress, t("loop.log.quit"));
          return "stop";
        }
        if (action === "retry") {
          freshTask.status = "todo";
          const feedback = result.reviewChanges?.trim() || reason;
          pendingReviewFeedback.set(task.id, feedback);
          if (result.handoff) pendingHandoff.set(task.id, result.handoff);
          log(progress, t("loop.log.reviewRetry", { id: task.id, reason: displayReason }));
          emit({ taskId: task.id, status: "retry", reason: displayReason, elapsedMs });
          persist();
          return "next";
        }
        if (action === "approve" && allowReviewOverride) {
          const approveLanded = landWorktreeWork();
          if (approveLanded !== "ok") {
            // Approved but unlandable. Blocking beats recording a done task the
            // main workspace never received; the sha to recover it is already
            // in the log line landWorktreeWork wrote.
            taskBaselines.delete(task.id);
            freshTask.status = "blocked";
            const blockReason = landBlockReason(approveLanded);
            log(progress, t("loop.log.blockedReview", { id: task.id, s: elapsed, reason: blockReason }));
            emit({ taskId: task.id, status: "blocked", reason: blockReason, elapsedMs });
            persist();
            if (opts.task) {
              done();
              return "stop";
            }
            return "next";
          }
          freshTask.status = "done";
          ctx.accepted += 1; // ctx.accepted change, whoever ctx.accepted it: same denominator as an auto-pass
          log(
            progress,
            ctx.tui && solo
              ? t("loop.log.reviewAccepted", { id: task.id, s: elapsed, reason: displayReason })
              : t("loop.log.headlessAccepted", { id: task.id, s: elapsed, reason: displayReason }),
          );
          emit({ taskId: task.id, status: "done", reason: displayReason, elapsedMs });
          persist();
          if (ctx.cfg.commit_per_task && !wt) {
            logTaskCommit(workspace, progress, task.id, task.title, ctx.cfg, taskBaselines.get(task.id));
          }
          taskBaselines.delete(task.id);
          if (opts.task) {
            done();
            return "stop";
          }
          return "next";
        }
        taskBaselines.delete(task.id);
        freshTask.status = "blocked";
        log(progress, t("loop.log.blockedReview", { id: task.id, s: elapsed, reason: displayReason }));
        emit({ taskId: task.id, status: "blocked", reason: displayReason, elapsedMs });
        persist();
      } else {
        // Also where a merge-back CONFLICT lands, deliberately: the next
        // attempt's worktree is cut from the new HEAD, which already contains
        // whatever won, so "re-execute on top of the result" is what already
        // happens and max_retries_per_task is already the attempt ceiling.
        // No second ladder, no separate block reason.
        freshTask.retries += 1;
        if (freshTask.retries >= ctx.cfg.max_retries_per_task) {
          taskBaselines.delete(task.id);
          freshTask.status = "blocked";
          const reason = t("loop.reason.maxRetries");
          log(progress, t("loop.log.blocked", { id: task.id, s: elapsed }));
          emit({ taskId: task.id, status: "blocked", reason, elapsedMs });
        } else {
          freshTask.status = "todo";
          // Carried ONLY into a retry. A task that blocked is not about to run
          // again, and one that passed has nothing to hand anyone — keeping it
          // there would leave a stale account for whenever the task is promoted.
          if (result.handoff) pendingHandoff.set(task.id, result.handoff);
          log(progress, t("loop.log.retry", { id: task.id, s: elapsed, n: freshTask.retries }));
          emit({ taskId: task.id, status: "retry", elapsedMs });
        }
        persist();
      }

      if (opts.task) {
        done();
        return "stop";
      }
      // a manual skip marks the task blocked too, but the user asked to move ON —
      // only an automatic (max-retries) block honors stop_on_blocked.
      if (!skipped && freshTask.status === "blocked" && ctx.cfg.stop_on_blocked) {
        done();
        log(progress, t("loop.log.stopBlocked"));
        return "stop";
      }
      return "next";
    } finally {
      if (!solo) trackers.delete(tracker);
      // A settled task is not skippable, so its controller stops being one of the
      // ones a keypress has to abort. Without this a long backlog keeps one per
      // attempt forever and a skip walks all of them to reach the live few.
      if (signal) ctx.tui?.control.endTask(signal);
      // Every exit path — done, blocked, skipped, retry, quit, crash — drops the
      // cell. That discard IS the rollback the serial loop never had, where a
      // blocked task leaves its mess smeared across the main workspace.
      if (wt) {
        // The baseline is a tree of THIS worktree's start. The next attempt gets
        // a fresh worktree cut from a newer HEAD, so keeping it would make that
        // attempt stage whatever landed in between as its own work.
        taskBaselines.delete(task.id);
        if (!worktreeAccounted) {
          const lost = worktreeLoss(wt, taskStartCommit);
          if (lost.head) log(progress, t("loop.log.worktreeDiscarded", { id: task.id, hash: shortHash(lost.head) }));
          else if (lost.dirty) log(progress, t("loop.log.worktreeDiscardedDirty", { id: task.id }));
        }
        removeTaskWorktree(workspace, wt);
      }
    }
  };

  /**
   * The tasks to dispatch together. One is the serial loop; more is a wave.
   *
   * The safety proof, and why no runtime check is needed to back it up: members
   * of `readyTasks` are pairwise UNORDERED (if A deps B then A is not ready
   * until B is done, and a done B is not ready), and overlappingScopePairs
   * already refused, at LOAD, every unordered pair whose declared scopes
   * overlap. So a wave of SCOPED tasks provably cannot collide on a file.
   *
   * That proof has a hole and this is the patch: prdload skips the overlap check
   * whenever either scope is empty, so a backlog written before `scope` existed
   * is unprotected. A task with no scope therefore takes the wave alone, which
   * makes a legacy PRD behave exactly like today with nothing to configure.
   */
  const pickWave = (prd: PRD): Task[] => {
    const ready = readyTasks(prd);
    const cap = Math.min(ctx.cfg.max_parallel_tasks ?? 1, ready.length);
    // No repo (or no commit yet) means no worktrees, and a wave without them
    // would put N executors in one checkout — the thing config load refuses.
    if (cap <= 1 || !headCommit(workspace)) return ready.slice(0, 1);
    const wave: Task[] = [];
    for (const tk of ready.slice(0, cap)) {
      if (tk.scope?.length) wave.push(tk);
      else if (wave.length === 0) return [tk];
      else break;
    }
    return wave;
  };

  /**
   * The gate a wave needs and a serial run does not.
   *
   * Every cell verified against the trunk it was CUT from, so N tasks can each
   * pass alone and be collectively broken the moment they land together: A
   * renames a function, B adds a caller of the old name, their scopes never
   * overlap, both are green, the merged trunk is not. Nothing else catches
   * that — the cherry-pick only refuses TEXTUAL conflicts, and the reviewer saw
   * one task's diff.
   *
   * The planner is told to place anchor tasks at convergence points, but that is
   * advice: a planner that forgets produces a wave with no integration check at
   * all. This is the gate, and it needs no configuring because the commands are
   * already in the backlog — re-run the DISTINCT verify commands of the tasks
   * that landed, now in the trunk. Distinct because a wave whose five tasks all
   * say `npm test` deserves one run, not five.
   *
   * Only the tasks that reached `done` count. A task that blocked did not land,
   * and holding the wave responsible for it would report the same failure twice.
   *
   * false = the run is over and done() has been called. It STOPS rather than
   * reverting: the work is merged and each task's commit is its own, so undoing
   * it is the user's call, not ours. Continuing is the worse option — every
   * later wave is cut from the broken trunk and fails the same way, at full
   * agent price, which is the same reasoning as the merge-refused stop.
   */
  const waveIntegrationHolds = async (batch: Task[]): Promise<boolean> => {
    const after = reload({ keepDoing: true });
    if (!after) return true; // a corrupt reload is already handled by the cells
    const landed = batch.filter((tk) => after.tasks.find((x) => x.id === tk.id)?.status === "done");
    const commands = [...new Set(landed.map((tk) => tk.verify).filter((c): c is string => !!c))];
    if (landed.length < 2 || commands.length === 0) return true;

    log(progress, t("loop.log.waveVerify", { n: landed.length, ids: landed.map((tk) => tk.id).join(", ") }));
    // Its OWN controller: every cell of the wave ended its signal on the way out,
    // so without one this gate is the last thing a run does that a skip or quit
    // cannot reach — and it can hold a full verify timeout after the user asked
    // to stop. Ended in `finally` for the same reason a task ends its own: a
    // settled phase must stop being one a keypress has to abort.
    const gateSignal = ctx.tui?.control.beginTask();
    try {
      for (const cmd of commands) {
        if (gateSignal?.aborted) return true; // abandoned, not broken
        const { passed } = await runVerifyCommand(cmd, t("loop.label.wave"), workspace, progress, gateSignal);
        if (!passed) {
          log(progress, t("loop.log.waveBroken", { ids: landed.map((tk) => tk.id).join(", "), cmd }));
          done();
          return false;
        }
      }
    } finally {
      if (gateSignal) ctx.tui?.control.endTask(gateSignal);
    }
    return true;
  };
  return { runOneTask, pickWave, waveIntegrationHolds };
}
