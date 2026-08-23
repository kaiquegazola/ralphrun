// lifecycle.ts — a run as a PROCESS: admitted, queued, spawned, answered,
// stopped.
//
// The queue exists because the core takes a lock on the workspace: parallelism
// inside a project is a wave, and parallelism across projects is what this
// admits. Decisions live here too — answering one is an act of run control, and
// which channel the answer travels down (the child's stdin, or the file)
// depends on whether the run is still alive to hear it.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadConfig } from "../../../src/config.js";
import { loadPrdFile } from "../../../src/prdload.js";
import { requeueTask } from "../../../src/requeue.js";
import { loadAppSettings } from "./appsettings.ts";
import { decisionStillStands, dismissedBacklog, refreshFromDisk } from "./decisions.ts";
import { handleFrame, pushLine } from "./frames.ts";
import { appendHistory } from "./history.ts";
import { prdName, toTaskViews, waveCount } from "./prds.ts";
import { runLockHolder, withRunLock } from "../../../src/worktree.js";
import { getProject } from "./registry.ts";
import { countsOf, nextRunId, notify, notifyUser, pruneEnded, readPrdOrNull, runs, type RunState } from "./store.ts";
import type { RunSummary } from "../shared/types.ts";

// ── child resolution ───────────────────────────────────────────────────────
// The child is a pre-bundled file (`bun run build:child`) copied into the app's
// resources. Its location differs between `electrobun dev` and a packaged app,
// so probe rather than guess — a wrong path here is a run that never starts.
function childScript(): string {
  const candidates = [
    join(import.meta.dir, "..", "resources", "run-child.js"),
    join(import.meta.dir, "..", "..", "resources", "run-child.js"),
    join(process.cwd(), "resources", "run-child.js"),
    join(process.cwd(), "app", "resources", "run-child.js"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`run-child.js not found. Run \`bun run build:child\`. Looked in:\n${candidates.join("\n")}`);
  return found;
}

/**
 * The project's ONE config. Backlogs live at the project root, so the core
 * would resolve this same file on its own — naming it explicitly costs nothing
 * and keeps the app honest if a PRD is ever run from elsewhere.
 */
function projectConfig(projectDir: string): string | undefined {
  const p = join(projectDir, "ralph.config.json");
  return existsSync(p) ? p : undefined;
}

// ── start / stop ───────────────────────────────────────────────────────────

export function startRun(projectId: string, prdPath: string): string {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  // Resolve ONCE, and dedupe on the resolved form: "prd.json" and
  // "./prd.json" are the same backlog, and letting two spellings through
  // would start two rival loops over one repo.
  const path = resolve(prdPath);
  // `stopping` excluded on purpose: a run being torn down is not a run you can
  // join. A stall restart stops the old child and starts a replacement in the
  // same tick, and the exit handler that sets endedAt has not fired yet.
  const existing = [...runs.values()].find(
    (r) => r.summary.prdPath === path && r.summary.endedAt === null && !r.stopping,
  );
  if (existing) return existing.summary.id;

  const cfg = loadConfig(path, projectConfig(project.dir), {});
  const prd = readPrdOrNull(path);
  const tasks = prd ? toTaskViews(prd) : [];
  const id = nextRunId();

  const summary: RunSummary = {
    id,
    projectId,
    projectName: project.name,
    prdPath: path,
    prdName: prdName(path, prd),
    status: "queued",
    wave: tasks.length === 0 ? 0 : 1,
    waveCount: waveCount(tasks),
    ...countsOf(tasks),
    startedAt: Date.now(),
    endedAt: null,
    executor: { ...cfg.executor },
    advisor: cfg.advisor ? { ...cfg.advisor } : null,
    parallel: cfg.max_parallel_tasks ?? 1,
    worktrees: !!cfg.worktree_per_task,
  };

  const state: RunState = {
    summary,
    child: null,
    stopping: false,
    live: new Map(),
    streams: new Map(),
    timeline: [],
    focusTaskId: null,
    finalTasks: null,
    pendingRestarts: new Set<string>(),
    unacked: new Map(),
    dismissed: new Set(),
    reviewFeedback: new Map(),
    gates: new Map(),
    answeredGates: new Set(),
  };
  runs.set(id, state);

  // Queued, not spawned: the core takes a RUN LOCK on the workspace, so a
  // second child in the same repo would die on startup instead of running
  // beside the first. Parallelism inside a project is a WAVE (worktrees per
  // task); parallelism across projects is what this queue admits.
  pump();
  notify("runs", { runId: id });
  return id;
}

/** How many runs may be in flight at once, machine-wide. */
function concurrencyLimit(): number {
  return Math.max(1, loadAppSettings().maxConcurrentRuns);
}

/** Start whatever the queue allows to start right now. Idempotent. */
function pump(): void {
  const live = [...runs.values()].filter((r) => r.child !== null);
  const busyProjects = new Set(live.map((r) => r.summary.projectId));
  let slots = concurrencyLimit() - live.length;

  for (const state of runs.values()) {
    if (slots <= 0) break;
    if (state.summary.status !== "queued" || state.child) continue;
    if (busyProjects.has(state.summary.projectId)) continue;
    // A `ralphrun` in another terminal holds the same workspace lock and has no
    // child of ours to see. Spawning anyway means the core kills the child on
    // startup and the app files a FAILED run for a workspace that was merely
    // busy — so it stays queued and the next pump tries again.
    const project = getProject(state.summary.projectId);
    if (project && runLockHolder(project.dir)) {
      // that process is not ours: no exit event will ever tell us it released
      // the workspace, so the only way a run queued behind it ever starts is
      // to look again
      scheduleLockPump();
      continue;
    }
    busyProjects.add(state.summary.projectId);
    slots--;
    spawnChild(state);
  }
}

/**
 * One control line down the child's stdin. False when the pipe is gone: the
 * child can exit while the human is still deciding, and an EPIPE thrown from a
 * click handler would take the whole app with it.
 */
function writeToChild(state: RunState, line: string): boolean {
  const stdin = state.child?.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
  try {
    stdin.write(line + "\n");
    return true;
  } catch {
    return false;
  }
}

/** The retry that watches for an OUTSIDE `ralphrun` to release a workspace. */
let lockTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLockPump(): void {
  if (lockTimer) return;
  lockTimer = setTimeout(() => {
    lockTimer = null;
    pump();
  }, 10_000);
  // polling for someone else's lock must not be what keeps the app alive
  lockTimer.unref?.();
}

function spawnChild(state: RunState): void {
  const project = getProject(state.summary.projectId);
  if (!project) {
    // the project was forgotten while this run waited its turn — end it, or it
    // sits in the queue forever holding a slot for a folder nobody owns
    state.summary.status = "failed";
    state.summary.endedAt = Date.now();
    appendHistory(state); // a run that never started is still a run that happened
    notify("runs", { runId: state.summary.id });
    pump(); // the slot this run was holding is free again
    return;
  }
  const path = state.summary.prdPath;

  // childScript() throws when the bundle is missing (`bun run build:child`
  // never ran). Letting that escape would leave a run sitting in the map,
  // marked running, that no later pump could ever finish or recover.
  let script: string;
  try {
    script = childScript();
  } catch (err) {
    state.summary.status = "failed";
    state.summary.endedAt = Date.now();
    pushLine(state, "", { at: Date.now(), text: err instanceof Error ? err.message : String(err), source: "system" });
    appendHistory(state);
    notify("runs", { runId: state.summary.id });
    pump();
    return;
  }

  state.summary.status = "running";
  state.summary.startedAt = Date.now();
  state.timeline.push({ at: Date.now(), taskId: "", kind: "start", label: "start" });

  const config = projectConfig(project.dir);
  const child = spawn(
    process.execPath,
    [script, "--prd", path, "--workspace", project.dir, ...(config ? ["--config", config] : [])],
    {
      cwd: project.dir,
      // stdin is the answer channel for the review gate — the child parks a
      // blocked task there until the human replies in the inbox.
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  state.child = child;
  syncExitHooks();

  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) handleFrame(state, line);
    }
  });
  // the child never writes to stderr on purpose (console is patched), so
  // anything here is the runtime itself failing — keep it, it is the only clue.
  // An EPIPE on a pipe whose reader is gone arrives ASYNCHRONOUSLY — the
  // try/catch around the write cannot see it, and unhandled it takes the whole
  // desktop process down. The answer simply was not delivered; the close
  // handler's fallback is what recovers it.
  child.stdin?.on("error", () => {
    // the write was already accepted when this arrives, so the answer cannot be
    // resent from here — but a human who decided something has to be told it
    // may not have reached the run
    pushLine(state, state.focusTaskId ?? "", {
      at: Date.now(),
      text: `o canal de respostas da run caiu — confira se sua última decisão foi aplicada`,
      source: "system",
    });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    pushLine(state, state.focusTaskId ?? "", { at: Date.now(), text: chunk.toString().trimEnd(), source: "system" });
  });
  // Node emits `error` (not `exit`) when the binary cannot be launched at all.
  // Unhandled, that throws out of an EventEmitter and takes the whole desktop
  // process with it, leaving the run displayed as if it were still running.
  child.on("error", (err: Error) => {
    pushLine(state, "", { at: Date.now(), text: `falha ao iniciar a run: ${err.message}`, source: "system" });
    // node MAY still emit `exit` after `error`; `ended` below makes the second
    // one a no-op instead of a duplicate history entry and a second pump.
    if (state.child === child) child.emit("close", 1);
  });
  let ended = false;
  // `close`, not `exit`: exit fires when the process goes, close when its stdio
  // has drained. Finalizing on exit can freeze the board and run the
  // unacknowledged-decision fallback while the last frames — a `decided`
  // receipt, a final status — are still in the pipe.
  child.on("close", (code) => {
    if (ended) return;
    ended = true;
    state.child = null;
    syncExitHooks();
    state.summary.endedAt = Date.now();
    const tasks = refreshFromDisk(state);
    // "done" means the BACKLOG is done, not just that nothing is blocked: the
    // loop exits cleanly after a failed wave-integration verify too, with later
    // tasks still todo, and filing that as a success would be a lie.
    const allDone = tasks.length > 0 && tasks.every((t) => t.status === "done");
    // A SIGTERM exit reports code null, which is indistinguishable from a
    // crash by the exit code alone — so the intent has to be remembered.
    // Without this, every pause the user asked for is recorded as a FAILED
    // run and persisted to .ralphrun/runs.json as one.
    state.summary.status = state.stopping
      ? "paused"
      : code === 0 && allDone
        ? "done"
        : code === 0
          ? "attention"
          : "failed";
    // ── what this run leaves unfinished ──────────────────────────────────
    //
    // Three shapes of half-applied answer, one rule for all of them: nothing
    // may end up reset with no run to pick it up, and nothing may end up hidden
    // behind a dismissal recorded for an answer that never landed. The frozen
    // board is built from `tasks`, so each recovery writes the FILE and the
    // view in that array — re-reading here would race the write.

    /** Make a task visible again as a decision, whatever else went wrong. */
    const surface = (id: string, text: string): void => {
      state.dismissed.delete(`${state.summary.id}:${id}`);
      dismissedBacklog.delete(`${state.summary.prdPath}:${id}`);
      const view = tasks.find((t) => t.id === id);
      // `blocked` is the only status an inbox item can be rebuilt from: an
      // ended run raises no stall, and the backlog scan reads blocked tasks.
      // The VIEW is marked even when the write fails — the item stays
      // answerable, and answering it retries the write.
      if (view && view.status !== "done") {
        writeTaskStatus(state.summary.projectId, state.summary.prdPath, id, false, "blocked");
        view.status = "blocked";
        view.reason ??= text;
      }
      pushLine(state, id, { at: Date.now(), text, source: "system" });
    };

    // A gate nobody will ever answer now is not a decision any more. One the
    // human DID answer and the run never acted on is different: the answer is
    // gone, so the task has to come back rather than look handled.
    for (const taskId of state.answeredGates) {
      surface(taskId, `a run terminou antes de aplicar sua decisão em ${taskId}`);
    }
    state.answeredGates.clear();
    state.gates.clear();

    // The child is gone, so writing the file is safe again — and anything it
    // never acknowledged is an answer the human gave that would otherwise
    // vanish.
    const reset: string[] = []; // reset to todo, with nothing running them yet
    for (const [id, decision] of state.unacked) {
      // a write that fails here is a decision the human loses — but throwing
      // out of a close handler is the WHOLE app, so it is reported on the run
      // and the rest of the recovery still runs
      if (!writeTaskStatus(state.summary.projectId, state.summary.prdPath, id, decision === "accept")) {
        surface(id, `não foi possível aplicar sua decisão em ${id} — o backlog não pôde ser escrito`);
        continue;
      }
      const view = tasks.find((t) => t.id === id);
      if (view) view.status = decision === "accept" ? "done" : "todo";
      if (decision === "retry") reset.push(id);
    }
    state.unacked.clear();

    // A stall answered while the child was still dying — every one of them, not
    // just the first: the human can answer a second before the exit arrives.
    for (const id of state.pendingRestarts) {
      const view = tasks.find((t) => t.id === id);
      // it LANDED while we waited for the exit. Resetting it now would redo
      // work the run already delivered.
      if (view && view.status !== "doing" && view.status !== "blocked") {
        state.dismissed.delete(`${state.summary.id}:${id}`);
        pushLine(state, id, {
          at: Date.now(),
          text: `${id} terminou antes do reinício — nada foi refeito`,
          source: "system",
        });
        continue;
      }
      if (writeTaskStatus(state.summary.projectId, state.summary.prdPath, id, false)) {
        if (view) view.status = "todo";
        reset.push(id);
      } else {
        surface(id, `não foi possível reiniciar ${id} — o backlog não pôde ser escrito`);
      }
    }
    state.pendingRestarts.clear();

    // ── the run is history now ───────────────────────────────────────────
    // Counters LAST, after every recovery above moved a status: the board and
    // .ralphrun/runs.json are built from this same array.
    Object.assign(state.summary, countsOf(tasks));
    state.finalTasks = tasks;
    notifyUser(
      "runEnd",
      `run ${state.summary.status} · ${state.summary.prdName}`,
      `${state.summary.projectName} · ${state.summary.done}/${state.summary.total} tasks`,
    );
    appendHistory(state);
    pruneEnded();
    notify("runs", { runId: state.summary.id });
    notify("decisions", { runId: state.summary.id });

    // a retry written to disk with nothing running it is a request that was
    // recorded and then ignored
    if (reset.length > 0) {
      try {
        startRun(state.summary.projectId, state.summary.prdPath);
        return; // startRun pumps on its own
      } catch (err) {
        // a ralph.config.json edited while the run was going, a project that is
        // gone. Thrown from a close handler this would end the whole app, and
        // EVERY task reset above is now todo with nothing to run it.
        const why = err instanceof Error ? err.message : String(err);
        for (const id of reset) surface(id, `a run seguinte não pôde começar: ${why}`);
        Object.assign(state.summary, countsOf(tasks));
        notify("runs", { runId: state.summary.id });
        notify("decisions", { runId: state.summary.id });
      }
    }
    // this run's slot (and its project's lock) just freed up
    pump();
  });
}

/**
 * A run belongs to the app SESSION. Run state lives in this process, so a child
 * that outlived it would be invisible: still holding its workspace lock, still
 * parked on a review gate nobody can answer, and blocking the next run of that
 * project with an error the user cannot connect to anything. Killing them on
 * the way out is the honest end — the backlog is on disk, so restarting the app
 * and pressing construir picks up exactly where it stopped.
 */
const EXIT_SIGNALS = ["exit", "SIGINT", "SIGTERM"] as const;
let hooked = false;

function killAllChildren(): void {
  for (const state of runs.values()) {
    if (!state.child) continue;
    state.stopping = true;
    state.child.kill("SIGTERM");
  }
}

/**
 * One stable handler per signal, so `off` can find what `on` registered.
 * `exit` only reaps; INT/TERM reap and then let the process die — installing a
 * listener for those REPLACES the default termination, so without the explicit
 * exit Ctrl-C would leave the app running with no children.
 */
const handlers = new Map<string, () => void>();
function onSignal(signal: string): () => void {
  let h = handlers.get(signal);
  if (!h) {
    h = () => {
      killAllChildren();
      if (signal !== "exit") process.exit(signal === "SIGINT" ? 130 : 143);
    };
    handlers.set(signal, h);
  }
  return h;
}

/** Hooked while children exist and unhooked when the last one goes. */
function syncExitHooks(): void {
  const anyLive = [...runs.values()].some((r) => r.child !== null);
  if (anyLive === hooked) return;
  for (const signal of EXIT_SIGNALS) {
    if (anyLive) process.on(signal, onSignal(signal));
    else process.off(signal, onSignal(signal));
  }
  hooked = anyLive;
}

/** Re-examine the queue — the concurrency limit may have just gone up. */
export function pumpQueue(): void {
  pump();
}

export function stopRun(runId: string): void {
  const state = runs.get(runId);
  if (!state) return;
  if (!state.child) {
    // still in the queue: there is nothing to signal, it just never starts
    if (state.summary.status === "queued") {
      state.stopping = true;
      state.summary.status = "paused";
      state.summary.endedAt = Date.now();
      state.finalTasks = refreshFromDisk(state);
      appendHistory(state); // cancelled in the queue is still a run that happened
      notify("runs", { runId });
      pump();
    }
    return;
  }
  state.stopping = true;
  state.child.kill("SIGTERM");
  state.summary.status = "paused";
  notify("runs", { runId });
}

/**
 * The human's answer. Which channel it travels down decides what it can do.
 *
 * A task PARKED on the review gate is answered through the child's stdin: the
 * loop is still holding that cell, so "aceitar" runs the loop's own approve
 * path — verify, commit, cherry-pick back to the trunk — and "corrigir de novo"
 * spends another retry round on the same worktree. Nothing here writes the file
 * for those; doing so would race the process that owns the task.
 *
 * Everything else is answered by writing prd.json, which the loop re-reads
 * between waves: a task the run already blocked, or a decision on a run that
 * has ended (which is then restarted). A STALL is the exception — the executor
 * is still running and cannot be interrupted headlessly, so restarting the task
 * means restarting the run.
 */
export function resolveDecision(
  runId: string | null,
  taskId: string,
  action: "retry" | "accept" | "skip" | "restart",
  backlog?: { projectId: string; prdPath: string },
): { ok: boolean; message: string } {
  // A decision the app rebuilt from prd.json after a restart: no run owns it,
  // so the answer is a write to the file plus, for a retry, a fresh run.
  if (!runId) {
    if (!backlog) return { ok: false, message: `decisão sem run e sem PRD — nada para responder` };
    const taken = workspaceTaken(backlog.projectId);
    if (taken) return taken;
    const key = `${resolve(backlog.prdPath)}:${taskId}`;
    if (action === "skip") {
      dismissedBacklog.add(key);
      notify("decisions", { runId: "" });
      return { ok: true, message: `${taskId} pulada` };
    }
    if (action === "accept") {
      return { ok: false, message: `${taskId} foi bloqueada numa run anterior — o trabalho não existe mais. Use "corrigir de novo".` };
    }
    if (!writeTaskStatus(backlog.projectId, resolve(backlog.prdPath), taskId, false)) {
      return { ok: false, message: `task ${taskId} não está no PRD (ou prd.json ilegível)` };
    }
    try {
      startRun(backlog.projectId, backlog.prdPath);
    } catch (err) {
      // the run refused to start (a malformed ralph.config.json, a project that
      // is gone). Put the task back so the decision stays answerable instead of
      // vanishing from an inbox that already forgot it.
      writeTaskStatus(backlog.projectId, resolve(backlog.prdPath), taskId, false, "blocked");
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    dismissedBacklog.add(key);
    return { ok: true, message: `${taskId} reenfileirada — nova run iniciada` };
  }

  const state = runs.get(runId);
  if (!state) return { ok: false, message: `run ${runId} desconhecida` };
  const key = `${runId}:${taskId}`;

  const gate = state.gates.get(taskId);
  if (gate && state.child) {
    if (action === "accept" && !gate.canApprove) {
      return { ok: false, message: `${taskId} não tem verify aprovado — só dá para corrigir ou bloquear` };
    }
    const answer = action === "accept" ? "approve" : action === "skip" ? "block" : "retry";
    // WRITTEN FIRST, and nothing is touched until it lands: a pipe that closed
    // while the UI was deciding leaves the gate exactly as it was, still
    // answerable, instead of a decision dropped from a board that forgot it.
    if (!writeToChild(state, JSON.stringify({ t: "gate-answer", id: gate.id, answer }))) {
      return { ok: false, message: `a run não está mais aceitando respostas — recarregue a inbox` };
    }
    state.gates.delete(taskId);
    // Held until the loop acts on it. An approve needs the loop's own verify,
    // commit and cherry-pick, so if the run dies holding one the exit handler
    // has to say the answer never landed instead of leaving it looking handled.
    state.answeredGates.add(taskId);
    // A retry sends the task back to the executor: whatever it produces next is
    // what the NEXT decision has to show. Keeping the tree frozen at the first
    // attempt would let a reviewer approve work they never saw.
    if (answer === "retry") {
      const live = state.live.get(taskId);
      if (live) delete live.finalTree;
    }
    // the child is about to write status:blocked, which would rebuild this very
    // decision — "pular" means gone, so dismiss it in the same breath
    if (answer === "block") {
      state.dismissed.add(key);
      dismissedBacklog.add(`${state.summary.prdPath}:${taskId}`);
    }
    notify("runs", { runId });
    notify("decisions", { runId });
    return {
      ok: true,
      message:
        answer === "approve"
          ? `${taskId} aprovada — o loop commita e leva pro trunk`
          : answer === "retry"
            ? `${taskId} volta pro executor`
            : `${taskId} bloqueada`,
    };
  }

  if (action === "skip") {
    // dismiss ONLY: the task keeps whatever status the run gave it, and a
    // stalled executor keeps running. "Pular" means stop asking me, not undo.
    // Both registers, because the backlog scan reads the same still-blocked
    // task from prd.json and would hand it straight back.
    state.dismissed.add(key);
    dismissedBacklog.add(`${state.summary.prdPath}:${taskId}`);
    notify("decisions", { runId });
    return { ok: true, message: `${taskId} pulada` };
  }

  // A task the run already blocked for good — max retries, a worktree that
  // could not be created, a reviewer refusal answered by policy. Its cell is
  // gone: the loop discarded the worktree when it gave up. Marking it "done"
  // here would file work that does not exist as delivered, so this is the one
  // decision the app refuses. The gate path above is where accepting is real,
  // because there the loop is still holding the cell.
  if (action === "accept" && !gate) {
    return {
      ok: false,
      message: `${taskId} já foi encerrada pela run — o trabalho da tentativa não existe mais. Use "corrigir de novo".`,
    };
  }

  // A STALL is a task still EXECUTING that went quiet — not one the run
  // settled. There is no headless way to interrupt a single executor, so the
  // only honest "restart this task" is to stop the run, reset the task and
  // start again. Said in the message, because the other tasks stop too.
  const status = refreshFromDisk(state).find((t) => t.id === taskId)?.status;
  const stalled = state.child !== null && !gate && status === "doing";
  if (stalled && (action === "retry" || action === "restart")) {
    // SIGTERM is a REQUEST. The child may still be writing its final status,
    // and resetting the task now would let that write land on top of the retry
    // the human just asked for — so the reset and the replacement run wait for
    // the exit to actually arrive.
    state.pendingRestarts.add(taskId);
    state.dismissed.add(key);
    stopRun(runId);
    return { ok: true, message: `run reiniciada — ${taskId} volta do zero` };
  }

  // A LIVE child owns prd.json. Writing it from here would race the loop's own
  // read-modify-write and its stale snapshot could restore the very status the
  // human just changed — so the answer travels down stdin and the run applies
  // it in its own process (see src/requeue.ts).
  if (state.child) {
    // Only a RETRY reaches here: accepting a task the run already settled was
    // refused above, and the gate path is where accepting is real. Keeping the
    // wire message to that one action means no stale caller can talk this into
    // marking discarded work as delivered.
    if (!writeToChild(state, JSON.stringify({ t: "decide", taskId, action: "retry" }))) {
      return { ok: false, message: `a run não está mais aceitando respostas — recarregue a inbox` };
    }
    state.unacked.set(taskId, "retry");
    state.dismissed.add(key);
    state.live.delete(taskId);
    notify("runs", { runId });
    notify("decisions", { runId });
    return { ok: true, message: `${taskId} volta na próxima wave` };
  }

  // `state.child === null` only means THIS app is not running it. A `ralphrun`
  // in another terminal can have claimed the workspace since, and its loop is
  // writing the same file — THE prd.json rule makes a write from here a lost
  // sibling status.
  const taken = workspaceTaken(state.summary.projectId);
  if (taken) return taken;

  // The board this decision came from is FROZEN at the end of its run. A later
  // run can have finished the very task it still shows as blocked, and
  // answering then would reset delivered work back to todo.
  if (state.summary.endedAt !== null && !decisionStillStands(resolve(state.summary.prdPath), taskId)) {
    state.dismissed.add(key);
    notify("decisions", { runId });
    return { ok: false, message: `${taskId} já mudou desde essa run — a decisão não vale mais` };
  }

  if (!resetTask(state, taskId, action === "accept")) {
    return { ok: false, message: `task ${taskId} não está no PRD (ou prd.json ilegível)` };
  }
  state.dismissed.add(key);
  state.live.delete(taskId);

  const live = state.summary.endedAt === null;
  if (!live && (action === "retry" || action === "restart")) {
    try {
      startRun(state.summary.projectId, state.summary.prdPath);
    } catch (err) {
      // the task is already reset and dismissed, and nothing is going to run
      // it — put both back, or the decision is gone from an inbox that thinks
      // it was answered
      writeTaskStatus(state.summary.projectId, state.summary.prdPath, taskId, false, "blocked");
      state.dismissed.delete(key);
      state.finalTasks = null;
      state.finalTasks = refreshFromDisk(state);
      notify("decisions", { runId });
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, message: `${taskId} reenfileirada — nova run iniciada` };
  }
  refreshFromDisk(state);
  notify("runs", { runId });
  notify("decisions", { runId });
  return {
    ok: true,
    message: live
      ? `${taskId} ${action === "accept" ? "aceita" : "volta na próxima wave"}`
      : `${taskId} ${action === "accept" ? "aceita" : "reenfileirada"}`,
  };
}

/**
 * Is somebody ELSE running in this project's workspace?
 *
 * The one question every out-of-process write to prd.json has to ask first.
 * The app's own bookkeeping cannot answer it: a run started from a terminal is
 * invisible here, and the core's workspace lock is the only shared record of
 * who owns the file.
 */
function workspaceTaken(projectId: string): { ok: false; message: string } | null {
  const project = getProject(projectId);
  const holder = project ? runLockHolder(project.dir) : null;
  return holder
    ? { ok: false, message: `há uma run do ralphrun (pid ${holder}) neste projeto — responda por lá ou pare a run antes` }
    : null;
}

/**
 * Write one task's new status into prd.json. `done` for an accept, otherwise
 * `todo` with the retry budget reset — a task that comes back with retries
 * spent would re-block on its first stumble.
 */
function resetTask(state: RunState, taskId: string, accept = false): boolean {
  return writeTaskStatus(state.summary.projectId, state.summary.prdPath, taskId, accept);
}

function writeTaskStatus(
  projectId: string,
  prdPath: string,
  taskId: string,
  accept: boolean,
  force?: "blocked",
): boolean {
  // The PROJECT's directory, not the PRD's: a backlog in a subfolder still runs
  // in the project workspace, and that is where the loop takes its lock. Locking
  // the PRD's own directory would take a lock nobody else looks at, and the
  // write would race the run it was meant to exclude.
  const workspace = getProject(projectId)?.dir ?? dirname(resolve(prdPath));
  // HELD across the read-modify-write: a `ralphrun` that claims this workspace
  // between a check and the write would have its statuses rolled back by it.
  const held = withRunLock(workspace, () => requeueOnce(prdPath, taskId, accept, force));
  return held.ok && held.value;
}

function requeueOnce(prdPath: string, taskId: string, accept: boolean, force?: "blocked"): boolean {
  // The CORE's requeue, not a second copy of it: this is the same write the
  // child performs in-process, and the rules that ride along with it — the
  // retry budget, and invalidating the advisor plan that belongs to the attempt
  // that failed — have to be the same wherever the answer is applied from.
  return requeueTask(resolve(prdPath), taskId, force === "blocked" ? "block" : accept ? "accept" : "retry");
}
