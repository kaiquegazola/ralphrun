// home.ts — the cockpit (5a). Decisions first, because a pending decision is
// the reason to open the app at all; then what is running; then the things you
// were in the middle of. Workforce is a status footer, not a screen, here.

import { basename } from "node:path";

import { activeRuns, getRunDetail, listDecisions, listRuns, readHistory } from "./runs.ts";
import { listProjectViews } from "./projects.ts";
import { toPrdView } from "./prds.ts";
import { drafts } from "./studio.ts";
import { workforce } from "./workforce.ts";
import type { ActivityItem, HomeView } from "../shared/types.ts";

export function home(): HomeView {
  const projects = listProjectViews();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const runs = activeRuns();

  const activity: ActivityItem[] = [];
  for (const run of listRuns()) {
    for (const ev of getRunDetail(run.id).timeline) {
      if (ev.kind !== "merge") continue;
      activity.push({
        at: ev.at,
        kind: "merge",
        text: `${ev.taskId} → trunk`,
        projectName: run.projectName,
      });
    }
    if (run.endedAt) {
      activity.push({
        at: run.endedAt,
        kind: "run-end",
        text: `run ${run.status === "done" ? "concluída" : run.status} · ${run.prdName}`,
        projectName: run.projectName,
      });
    }
  }
  // Runs that ended before this session started still count as activity — the
  // history file is the only place they survive a restart. A run that ended
  // DURING this session is in both places, so it is skipped here or the feed
  // shows it twice and pushes a real merge off the list.
  const seen = new Set(listRuns().map((r) => r.id));
  for (const p of projects) {
    for (const h of readHistory(p.dir).slice(0, 4)) {
      if (!h.endedAt || seen.has(h.id)) continue;
      activity.push({
        at: h.endedAt,
        kind: "run-end",
        text: `run ${h.status === "done" ? "concluída" : h.status} · ${h.prdName}`,
        projectName: p.name,
      });
    }
  }
  activity.sort((a, b) => b.at - a.at);

  const wf = workforce();
  const busy = wf.agents.reduce((n, a) => n + a.activeTasks, 0);

  return {
    projectCount: projects.length,
    soleProjectId: projects.length === 1 ? projects[0].id : null,
    decisions: listDecisions().sort((a, b) => a.since - b.since),
    runs,
    resume: drafts().map((d) => {
      const project = byId.get(d.projectId);
      // saved AND valid: `prd.json exists` is not enough, because a skeleton or
      // a broken dep graph would start a run the child immediately refuses.
      const view = d.prdPath ? toPrdView(d.projectId, d.prdPath, null) : null;
      const runnable = !d.dirty && view !== null && view.depsOk;
      return {
        prdPath: d.prdPath ?? "",
        projectId: d.projectId,
        name: d.prdPath ? basename(d.prdPath).replace(/\.json$/, "") : (project?.name ?? "rascunho"),
        note: d.dirty
          ? "PRD em edição no studio"
          : view && !view.depsOk
            ? `${project?.name ?? ""} · precisa terminar no studio`
            : `${project?.name ?? ""} · PRD com ${d.taskCount} tasks`,
        runnable,
      };
    }),
    activity: activity.slice(0, 5),
    workforce: wf.agents.slice(0, 5).map((a) => ({
      cli: a.cli,
      color: a.color,
      ok: a.installed && a.loggedIn,
      note: a.installed ? (a.loggedIn ? null : "não logado") : "não instalado",
    })),
    busy,
    // agents with nothing on their plate. Subtracting TASKS from AGENTS reads
    // one busy agent running three tasks as three agents gone.
    free: wf.agents.filter((a) => a.installed && a.loggedIn && a.activeTasks === 0).length,
    checkedAt: wf.checkedAt,
  };
}
