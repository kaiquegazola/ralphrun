// app.tsx — the shell and the router. Three top-level tabs (5a), everything
// else reached from them; the decision inbox is a DRAWER rather than a page,
// because 1e's whole point is that answering a decision never stops the board.

import { useEffect, useState, type ReactNode } from "react";

import { onError, useQuery, rpc } from "./api.ts";
import { Inbox } from "./screens/Inbox.tsx";
import { Home } from "./screens/Home.tsx";
import { Projects } from "./screens/Projects.tsx";
import { Project } from "./screens/Project.tsx";
import { RunDetail } from "./screens/RunDetail.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Studio } from "./screens/Studio.tsx";
import { Workforce } from "./screens/Workforce.tsx";
import { Worktrees } from "./screens/Worktrees.tsx";
import { applyTheme } from "./theme.ts";
import { clock, useNow } from "./ui.tsx";

export type Route =
  | { t: "home" }
  | { t: "projects" }
  | { t: "project"; id: string }
  | { t: "run"; runId: string }
  | { t: "worktrees"; projectId: string }
  | { t: "studio"; projectId: string; prdPath?: string; fresh?: boolean }
  | { t: "workforce" }
  | { t: "settings"; projectId?: string };

export type Nav = (r: Route) => void;

export function App(): ReactNode {
  const [route, setRoute] = useState<Route>({ t: "home" });
  const [inboxOpen, setInboxOpen] = useState(false);
  const decisions = useQuery(() => rpc.request.listDecisions({}), ["decisions"]);
  const pending = decisions.data?.length ?? 0;
  // a wall clock has to move on its own; nothing else re-renders the shell
  const now = useNow(30_000);
  // a request the user made that FAILED — a malformed ralph.config.json, a
  // branch git refused. A button that silently does nothing is the worst
  // outcome, so the shell always has somewhere to say it.
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onError(setError), []);

  // the appearance preference has to survive a restart, so it is applied here
  // rather than only at the moment the user picks it in settings
  useEffect(() => {
    void rpc.request.globalSettings({}).then((g) => applyTheme(g.theme));
  }, []);

  const tab = route.t === "projects" || route.t === "project" ? "projects" : route.t === "workforce" ? "workforce" : route.t === "home" ? "home" : "";

  return (
    <div className="shell">
      <div className="topbar">
        <span className="brand">
          ralph<b>run</b>
        </span>
        <div className="tabs">
          <button className={tab === "home" ? "on" : ""} onClick={() => setRoute({ t: "home" })}>
            Home
          </button>
          <button className={tab === "projects" ? "on" : ""} onClick={() => setRoute({ t: "projects" })}>
            Projetos
          </button>
          <button className={tab === "workforce" ? "on" : ""} onClick={() => setRoute({ t: "workforce" })}>
            Workforce
          </button>
        </div>
        <div className="grow" />
        <button
          className="btn"
          style={
            pending > 0
              ? { borderColor: "rgba(240,176,78,.5)", color: "var(--warn)" }
              : { color: "var(--muted)" }
          }
          onClick={() => setInboxOpen((v) => !v)}
        >
          Decisões {pending > 0 ? `· ${pending}` : ""}
        </button>
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
          {clock(now)}
        </span>
        <button
          className="btn quiet"
          title="configurações"
          onClick={() => setRoute({ t: "settings", projectId: route.t === "project" ? route.id : undefined })}
        >
          ⚙
        </button>
      </div>

      {error ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "9px 20px",
            background: "rgba(238,106,95,.08)",
            borderBottom: "1px solid rgba(238,106,95,.35)",
            color: "var(--bad)",
            fontSize: 12,
          }}
        >
          <span className="mono" style={{ fontSize: 11 }}>
            ✗
          </span>
          <span style={{ flex: 1 }}>{error}</span>
          <button className="mono" style={{ fontSize: 10, color: "var(--bad)" }} onClick={() => setError(null)}>
            fechar ✕
          </button>
        </div>
      ) : null}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div className="scroll" style={{ flex: 1, minWidth: 0 }}>
          <Screen route={route} nav={setRoute} />
        </div>
        {inboxOpen ? (
          <div
            style={{
              width: 360,
              flex: "none",
              borderLeft: "1px solid var(--line)",
              background: "var(--inset)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <Inbox nav={setRoute} onClose={() => setInboxOpen(false)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Screen({ route, nav }: { route: Route; nav: Nav }): ReactNode {
  switch (route.t) {
    case "home":
      return <Home nav={nav} />;
    case "projects":
      return <Projects nav={nav} />;
    case "project":
      return <Project id={route.id} nav={nav} />;
    case "run":
      return <RunDetail runId={route.runId} nav={nav} />;
    case "worktrees":
      return <Worktrees projectId={route.projectId} nav={nav} />;
    case "studio":
      return <Studio projectId={route.projectId} prdPath={route.prdPath} fresh={route.fresh} nav={nav} />;
    case "workforce":
      return <Workforce nav={nav} />;
    case "settings":
      return <Settings projectId={route.projectId} nav={nav} />;
  }
}
