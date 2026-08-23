// index.ts — the main process. Wiring only: every handler is one line into a
// module that owns the behaviour, so this file stays a readable index of what
// the app can do.

import { mkdirSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

import { BrowserView, BrowserWindow, Utils } from "electrobun/main";

import type { AppRPC } from "../shared/rpc.ts";
import { notifyUser } from "./notify.ts";
import { globalSettings, projectSettings, saveGlobalSettings, saveProjectSettings } from "./settings.ts";
import { home } from "./home.ts";
import { createProject, listProjectViews, probeDir, projectDetail } from "./projects.ts";
import { getProject, registryPath, removeProject } from "./registry.ts";
import {
  activeRuns,
  getRunDetail,
  getStream,
  listDecisions,
  onRunChange,
  pumpQueue,
  resolveDecision,
  setNotifier,
  startRun,
  stopRun,
  taskDiff,
} from "./runs.ts";
import { setStudioChunkListener, studioAttach, studioOpen, studioSave, studioSend, studioUndo } from "./studio.ts";
import { workforce } from "./workforce.ts";
import { worktreesFor } from "./worktrees.ts";

const rpc = BrowserView.defineRPC<AppRPC>({
  handlers: {
    requests: {
      home: () => home(),

      listProjects: () => listProjectViews(),
      getProject: ({ id }) => projectDetail(id),
      probeDir: ({ dir }) => probeDir(dir),
      pickDirectory: async () => {
        const paths = await Utils.openFileDialog({
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });
        return { dir: paths[0] ?? null };
      },
      createProject: ({ dir, name, init }) => ({ id: createProject(dir, name, init) }),
      forgetProject: ({ id }) => {
        // a run whose project is gone cannot be persisted to history, reopened
        // from the project screen, or resolved to a workspace — stop it first
        if (activeRuns().some((r) => r.projectId === id)) {
          throw new Error("há uma run ativa neste projeto — pare a run antes de removê-lo da lista");
        }
        removeProject(id);
        return {};
      },

      startRun: ({ projectId, prdPath }) => ({ runId: startRun(projectId, prdPath) }),
      stopRun: ({ runId }) => {
        stopRun(runId);
        return {};
      },
      getRun: ({ runId }) => getRunDetail(runId),
      getStream: ({ runId, taskId }) => getStream(runId, taskId),

      listDecisions: () => listDecisions(),
      resolveDecision: ({ runId, projectId, prdPath, taskId, action }) =>
        resolveDecision(runId, taskId, action, { projectId, prdPath }),
      taskDiff: ({ runId, taskId }) => ({ diff: taskDiff(runId, taskId) }),

      listWorktrees: ({ projectId }) => {
        const project = getProject(projectId);
        if (!project) throw new Error(`unknown project ${projectId}`);
        return worktreesFor(projectId, project.dir);
      },

      workforce: () => workforce(),
      setPair: ({ projectId, executor, advisor }) => {
        saveProjectSettings(projectId, { executor, advisor });
        return {};
      },

      projectSettings: ({ projectId }) => projectSettings(projectId),
      saveProjectSettings: ({ projectId, patch }) => {
        saveProjectSettings(projectId, patch);
        return {};
      },
      globalSettings: () => globalSettings(),
      saveGlobalSettings: ({ patch }) => {
        saveGlobalSettings(patch);
        // raising the concurrency limit has to release whatever is queued now,
        // not at the next run's exit
        pumpQueue();
        return {};
      },

      studioOpen: ({ projectId, prdPath, fresh }) => studioOpen(projectId, prdPath, fresh),
      studioSend: ({ projectId, text }) => studioSend(projectId, text),
      studioAttach: async ({ projectId }) => {
        const paths = await Utils.openFileDialog({
          canChooseFiles: true,
          canChooseDirectory: false,
          allowsMultipleSelection: false,
        });
        return paths[0] ? studioAttach(projectId, paths[0]) : studioOpen(projectId);
      },
      studioUndo: ({ projectId }) => studioUndo(projectId),
      studioSave: ({ projectId, prdPath }) => studioSave(projectId, prdPath),

      openPath: ({ path }) => {
        Utils.openPath(path);
        return {};
      },
    },
    messages: {
      viewReady: () => {
        rpc.send.workforceChanged({});
      },
    },
  },
});

// Push, don't poll: a run emits events far faster than any interval would
// catch, and the screens each refetch only what they are showing.
onRunChange((kind, payload) => {
  if (kind === "decisions") {
    rpc.send.decisionsChanged({});
    return;
  }
  if (payload.line && payload.taskId) {
    rpc.send.streamAppended({ runId: payload.runId, taskId: payload.taskId, line: payload.line });
    return;
  }
  rpc.send.runsChanged({ runId: payload.runId });
});

setNotifier(notifyUser);

setStudioChunkListener((projectId, text) => rpc.send.studioChunk({ projectId, text }));

// `ralphrun create .` writes the shared registry from ANOTHER process, so the
// project list has to learn about it from the file rather than from an event
// this app could emit. Watching the file itself misses an atomic rename, which
// is exactly how the registry is written — so watch the directory.
try {
  // create it first: on a machine that has never run ralphrun the config dir
  // does not exist, watch() throws, and the list would then stay stale for the
  // whole session even after `ralphrun create .` makes the directory.
  mkdirSync(dirname(registryPath()), { recursive: true });
  watch(dirname(registryPath()), (_e, name) => {
    if (name && name.startsWith(basename(registryPath()))) rpc.send.projectsChanged({});
  });
} catch {
  // no config dir yet, or a platform without watch: the list still refreshes
  // on navigation, it just does not update live.
}

// "preflight contínuo" from the workforce screen: a cli the user logs into in
// another terminal has to turn green here without a restart. One minute is slow
// enough that the probes (a spawn per cli) never compete with a live run.
setInterval(() => rpc.send.workforceChanged({}), 60_000);

new BrowserWindow({
  title: "ralphrun",
  url: "views://mainview/index.html",
  frame: { width: 1440, height: 940, x: 60, y: 60 },
  rpc,
});
