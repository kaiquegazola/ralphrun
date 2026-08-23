// rpc.ts — the typed contract between the bun main process and the webview.
// Types only: no runtime code, so both sides import it for free.

import type { RPCSchema } from "electrobun/view";
import type {
  AgentSpecView,
  DecisionView,
  GlobalSettingsView,
  HomeView,
  NewProjectProbe,
  PrdView,
  ProjectSettingsView,
  ProjectView,
  RunDetailView,
  RunSummary,
  StreamLine,
  StudioView,
  TrunkView,
  WorkforceView,
  WorktreeView,
} from "./types.ts";

export type DecisionAction = "retry" | "accept" | "skip" | "restart";

export type AppRPC = {
  bun: RPCSchema<{
    requests: {
      // ── home ────────────────────────────────────────────────────────────
      home: { params: {}; response: HomeView };

      // ── projects ────────────────────────────────────────────────────────
      listProjects: { params: {}; response: ProjectView[] };
      getProject: { params: { id: string }; response: { project: ProjectView; prds: PrdView[]; history: RunSummary[] } };
      probeDir: { params: { dir: string }; response: NewProjectProbe };
      pickDirectory: { params: {}; response: { dir: string | null } };
      createProject: { params: { dir: string; name?: string; init: boolean }; response: { id: string } };
      forgetProject: { params: { id: string }; response: {} };

      // ── runs ────────────────────────────────────────────────────────────
      startRun: { params: { projectId: string; prdPath: string }; response: { runId: string } };
      stopRun: { params: { runId: string }; response: {} };
      getRun: { params: { runId: string }; response: RunDetailView };
      getStream: { params: { runId: string; taskId: string }; response: StreamLine[] };

      // ── decisions ───────────────────────────────────────────────────────
      listDecisions: { params: {}; response: DecisionView[] };
      resolveDecision: {
        // runId is null for a decision the app rebuilt from prd.json after a
        // restart — the backlog outlives the process that was running it
        params: { runId: string | null; projectId: string; prdPath: string; taskId: string; action: DecisionAction };
        response: { ok: boolean; message: string };
      };
      taskDiff: { params: { runId: string; taskId: string }; response: { diff: string } };

      // ── worktrees ───────────────────────────────────────────────────────
      listWorktrees: { params: { projectId: string }; response: { worktrees: WorktreeView[]; trunk: TrunkView } };

      // ── workforce ───────────────────────────────────────────────────────
      workforce: { params: { projectId?: string }; response: WorkforceView };
      setPair: {
        params: { projectId: string; executor: AgentSpecView; advisor: AgentSpecView | null };
        response: {};
      };

      // ── settings ────────────────────────────────────────────────────────
      projectSettings: { params: { projectId: string }; response: ProjectSettingsView };
      saveProjectSettings: { params: { projectId: string; patch: Partial<ProjectSettingsView> }; response: {} };
      globalSettings: { params: {}; response: GlobalSettingsView };
      saveGlobalSettings: { params: { patch: Partial<GlobalSettingsView> }; response: {} };

      // ── studio ──────────────────────────────────────────────────────────
      studioOpen: { params: { projectId: string; prdPath?: string; fresh?: boolean }; response: StudioView };
      studioSend: { params: { projectId: string; text: string }; response: StudioView };
      studioAttach: { params: { projectId: string }; response: StudioView };
      studioUndo: { params: { projectId: string }; response: StudioView };
      studioSave: { params: { projectId: string; prdPath?: string }; response: StudioView };
      // ── misc ────────────────────────────────────────────────────────────
      openPath: { params: { path: string }; response: {} };
    };
    messages: {
      viewReady: {};
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      // one push per run mutation; the view refetches what it is showing
      runsChanged: { runId: string };
      streamAppended: { runId: string; taskId: string; line: StreamLine };
      decisionsChanged: {};
      projectsChanged: {};
      studioChunk: { projectId: string; text: string };
      workforceChanged: {};
    };
  }>;
};
