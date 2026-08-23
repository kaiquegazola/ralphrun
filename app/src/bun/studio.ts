// studio.ts — the planner chat, one session per project. The reducer, the
// planner turn and the attachment reader all come from the TUI studio: the
// authoring rules (staged skeleton → expansion, undo stack, deps validation)
// are the product, not the terminal's, so the GUI drives the same ones.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { agentClis, agentDef, defaultModelOf } from "../../../src/agents.js";
import { checkAgent } from "../../../src/diagnostics.js";
import { readAttachment } from "../../../src/picker.js";
import { savePrdAtomic } from "../../../src/prdwrite.js";
import type { PRD } from "../../../src/prd.js";
import { loadUserConfig } from "../../../src/userconfig.js";
import { withRunLock } from "../../../src/worktree.js";
import {
  canSave,
  initialPrdState,
  reducer,
  type PrdState,
} from "../../../src/tui/prd/prdController.js";
import { runPlannerTurn } from "../../../src/tui/prd/prdChat.js";
import { readPrd, toTaskViews } from "./prds.ts";
import { getProject } from "./registry.ts";
import type { AgentSpecView, StudioView } from "../shared/types.ts";

interface Session {
  state: PrdState;
  prdPath: string | null;
  abort: AbortController | null;
  /**
   * Bumped whenever the session is REPLACED (a fresh draft, another PRD
   * opened). A planner turn captures it and drops its chunks and its result if
   * it comes back to a session that has moved on — otherwise a slow turn from
   * the previous backlog lands on top of the new one.
   */
  generation: number;
}

const sessions = new Map<string, Session>();
type ChunkListener = (projectId: string, text: string) => void;
let onChunk: ChunkListener = () => {};

export function setStudioChunkListener(l: ChunkListener): void {
  onChunk = l;
}

/**
 * Who drafts the PRD. The user's saved preference wins; otherwise the first cli
 * that is INSTALLED and logged in, claude first because it is the registry's
 * own recommendation for the role. Hard-coding claude would make every studio
 * turn fail on a machine that has codex and nothing else.
 */
function plannerSpec(): AgentSpecView {
  const pref = loadUserConfig().default_planner;
  if (pref) return pref;
  const usable = agentClis.filter((cli) => {
    const d = checkAgent(cli);
    return d.installed && d.loggedIn !== false;
  });
  const cli = usable.includes("claude") ? "claude" : (usable[0] ?? "claude");
  return { cli, model: agentDef(cli)?.recommended.planner ?? defaultModelOf(cli) };
}

function session(projectId: string): Session {
  let s = sessions.get(projectId);
  if (!s) {
    s = { state: { ...initialPrdState }, prdPath: null, abort: null, generation: 0 };
    sessions.set(projectId, s);
  }
  return s;
}

function view(projectId: string, s: Session): StudioView {
  const prd = s.state.prd;
  return {
    prdPath: s.prdPath,
    projectId,
    messages: s.state.messages.map((m) => ({ role: m.role, text: m.text })),
    tasks: prd ? toTaskViews(prd) : [],
    attachments: s.state.attachments.map((a) => a.path),
    status: s.state.status,
    errors: s.state.errors,
    dirty: s.state.dirty,
    undoDepth: s.state.undoStack.length,
    planner: plannerSpec(),
    depsOk: canSave(s.state),
  };
}

export function studioOpen(projectId: string, prdPath?: string, fresh = false): StudioView {
  const s = session(projectId);
  // "+ Novo PRD" has to start BLANK. Without an explicit flag the only signal
  // is an absent path, which is also what resuming an unsaved draft looks
  // like — and wiping that draft is the worse mistake of the two.
  if (fresh) {
    s.abort?.abort();
    s.generation++;
    s.state = { ...initialPrdState };
    s.prdPath = null;
    return view(projectId, s);
  }
  if (prdPath && prdPath !== s.prdPath) {
    const prd = readPrd(prdPath);
    // opening an existing backlog seeds the session WITHOUT a chat history:
    // the file is the state, and inventing a fake first turn would put words
    // in the planner's mouth on the next request.
    s.abort?.abort();
    s.generation++;
    s.state = { ...initialPrdState, prd };
    s.prdPath = prdPath;
  }
  return view(projectId, s);
}

export async function studioSend(projectId: string, text: string): Promise<StudioView> {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  const s = session(projectId);
  const spec = plannerSpec();

  // captured BEFORE the dispatch, exactly like the TUI: otherwise this turn's
  // own message shows up in its own history and the planner reads it twice.
  const history = s.state.messages.slice();
  const currentPrd = s.state.prd;
  const attachments = s.state.attachments.map((a) => readAttachment(a.path));

  s.state = reducer(s.state, { type: "addUserMessage", text });
  s.state = reducer(s.state, { type: "startDrafting" });
  s.abort?.abort();
  s.abort = new AbortController();
  const generation = s.generation;

  const result = await runPlannerTurn({
    cli: spec.cli,
    model: spec.model,
    cwd: project.dir,
    currentPrd,
    history,
    instruction: text,
    attachments,
    signal: s.abort.signal,
    onChunk: (t) => {
      if (s.generation !== generation) return; // this turn's session is gone
      s.state = reducer(s.state, { type: "appendPlannerChunk", text: t });
      onChunk(projectId, t);
    },
  }).catch((err: unknown) => ({
    // A REJECTION — a planner cli that cannot be spawned, for instance. Without
    // this the session stays in `drafting` forever: no error to read, and
    // nothing saveable or buildable left to do.
    summary: "",
    prd: null,
    errors: [err instanceof Error ? err.message : String(err)],
  }));

  // the user opened another backlog (or started a fresh draft) while this turn
  // was still running — its answer belongs to a session that no longer exists
  if (s.generation !== generation) return view(projectId, s);
  s.state = reducer(s.state, { type: "applyPlannerResult", result });
  return view(projectId, s);
}

export function studioAttach(projectId: string, path: string): StudioView {
  const s = session(projectId);
  s.state = reducer(s.state, { type: "addAttachment", path });
  return view(projectId, s);
}

export function studioUndo(projectId: string): StudioView {
  const s = session(projectId);
  s.state = reducer(s.state, { type: "undo" });
  return view(projectId, s);
}

/**
 * Write the backlog where a run can find it — and where the CLI finds the same
 * CONFIG the app edits. The core resolves ralph.config.json next to the PRD, so
 * a backlog buried anywhere else would run on defaults for anyone typing
 * `ralphrun --prd …`. Project ROOT, one file per backlog: several coexist
 * without fighting over prd.json, and every one of them sees the project config.
 */
export function studioSave(projectId: string, prdPath?: string): StudioView {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project ${projectId}`);
  const s = session(projectId);
  if (!s.state.prd) return view(projectId, s);

  const target = prdPath ?? s.prdPath ?? defaultPath(project.dir, s.state.prd);
  // THE prd.json rule: the process running the loop owns that file. Saving the
  // studio's snapshot over it would restore the statuses of every task the run
  // has advanced since the draft was loaded. A NEW file is harmless — only an
  // overwrite can clobber someone's state.
  const prd = s.state.prd;
  try {
    if (existsSync(target)) {
      // HELD across the write, not merely checked before it: a run claiming the
      // workspace between the check and the write is exactly what would make
      // this snapshot roll back statuses that run has advanced.
      const done = withRunLock(project.dir, () => savePrdAtomic(target, prd));
      if (!done.ok) {
        s.state = reducer(s.state, {
          type: "saveError",
          message: `uma run ja usa este workspace (pid ${done.holder}) - pare-a antes de salvar por cima`,
        });
        return view(projectId, s);
      }
    } else {
      savePrdAtomic(target, prd); // a file nobody has is nobody's to lock
    }
    s.prdPath = target;
    s.state = reducer(s.state, { type: "markSaved" });
  } catch (err) {
    s.state = reducer(s.state, {
      type: "saveError",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return view(projectId, s);
}

function defaultPath(projectDir: string, prd: PRD): string {
  const slug =
    (prd.project || "prd")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "prd";
  // `prd.json` when the root is free, so the plainest `ralphrun` invocation
  // finds it with no flags; a named file otherwise. NEVER an existing path: a
  // second draft of "Launch V1" must not silently overwrite the first one.
  const root = join(projectDir, "prd.json");
  if (!existsSync(root)) return resolve(root);
  for (let n = 0; ; n++) {
    const candidate = join(projectDir, n === 0 ? `prd-${slug}.json` : `prd-${slug}-${n}.json`);
    if (!existsSync(candidate)) return resolve(candidate);
  }
}

export function studioPrdPath(projectId: string): string | null {
  return sessions.get(projectId)?.prdPath ?? null;
}

/** Projects with unsaved or unbuilt drafts — the home screen's "RETOMAR" list. */
export function drafts(): { projectId: string; prdPath: string | null; dirty: boolean; taskCount: number }[] {
  return [...sessions.entries()]
    .filter(([, s]) => s.state.prd !== null)
    .map(([projectId, s]) => ({
      projectId,
      prdPath: s.prdPath,
      dirty: s.state.dirty,
      taskCount: s.state.prd?.tasks.length ?? 0,
    }));
}
