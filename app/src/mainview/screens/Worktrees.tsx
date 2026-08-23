// Worktrees.tsx — 1d. The conceptual differentiator made physical: every doing
// task is a real detached checkout hanging off the trunk, and the trunk bar at
// the bottom is where they come back, one commit per task.

import type { ReactNode } from "react";

import { rpc, useQuery } from "../api.ts";
import type { Nav } from "../app.tsx";
import type { WorktreeView } from "../../shared/types.ts";
import { Avatar, Empty } from "../ui.tsx";

export function Worktrees({ projectId, nav }: { projectId: string; nav: Nav }): ReactNode {
  const { data } = useQuery(() => rpc.request.listWorktrees({ projectId }), ["runs", "decisions"], projectId);
  if (!data) return <Empty>carregando…</Empty>;

  const active = data.worktrees.filter((w) => w.state !== "merged").length;
  const merged = data.worktrees.filter((w) => w.state === "merged").length;

  return (
    <div style={{ background: "var(--deep)", minHeight: "100%" }}>
      <div className="topbar" style={{ background: "transparent", gap: 14 }}>
        <button className="crumb" onClick={() => nav({ t: "project", id: projectId })}>
          projeto /
        </button>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Worktrees</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
          {active} {active === 1 ? "ativa" : "ativas"} · {merged} mergeadas
        </span>
      </div>

      {data.worktrees.length === 0 ? (
        <Empty>
          nenhuma mesa de trabalho aberta — ligue <span className="mono">worktree por task</span> nas configurações do
          projeto para rodar tasks em paralelo
        </Empty>
      ) : (
        <div style={{ position: "relative", padding: "26px 26px 0", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          {data.worktrees.map((w) => (
            <Desk key={w.taskId} w={w} />
          ))}
        </div>
      )}

      <div style={{ margin: "42px 26px 22px" }}>
        <div
          style={{
            minHeight: 34,
            background: "linear-gradient(90deg,var(--panel),var(--ink))",
            border: "1px solid rgba(255,255,255,.12)",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "6px 16px",
            flexWrap: "wrap",
          }}
        >
          <span className="mono" style={{ fontWeight: 600, fontSize: 11 }}>
            trunk · {data.trunk.branch}
          </span>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 26, flexWrap: "wrap" }}>
            {data.trunk.commits.map((c) => (
              <span key={c.sha} className="mono" style={{ fontSize: 10, color: "var(--done)" }} title={c.subject}>
                ●─ {c.taskId ?? c.subject.slice(0, 14)} {c.sha} <span style={{ color: "var(--muted)" }}>· {c.ago}</span>
              </span>
            ))}
          </div>
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
            {data.trunk.todayCount} commits recentes · 1 por task
          </span>
        </div>
      </div>
    </div>
  );
}

function Desk({ w }: { w: WorktreeView }): ReactNode {
  const merged = w.state === "merged";
  const attention = w.state === "attention";

  return (
    <div
      style={{
        background: merged ? "rgba(83,208,138,.03)" : "var(--panel)",
        border: merged
          ? "1px dashed rgba(83,208,138,.35)"
          : `1px solid ${attention ? "rgba(240,176,78,.5)" : "rgba(90,167,240,.4)"}`,
        borderRadius: 10,
        padding: "13px 14px",
        position: "relative",
        opacity: merged ? 0.65 : 1,
        boxShadow: attention ? "0 0 20px rgba(240,176,78,.1)" : undefined,
      }}
    >
      {/* the leg that ties every desk to the trunk bar below */}
      <span
        style={{
          position: "absolute",
          left: "50%",
          bottom: -42,
          width: 2,
          height: 42,
          background: `linear-gradient(${merged ? "var(--done)" : attention ? "var(--warn)" : "var(--doing)"},var(--sel))`,
          opacity: merged ? 0.5 : 1,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="mono"
          style={{ fontWeight: 600, fontSize: 12, color: merged ? "var(--done)" : attention ? "var(--warn)" : "var(--doing)" }}
        >
          {w.taskId}
        </span>
        <span className="mono" style={{ fontSize: 10, color: merged ? "var(--done)" : "var(--dim)" }}>
          {merged ? "✓ mergeada" : w.shortPath}
        </span>
        <div className="grow" />
        {attention ? (
          <span className="mono pulse" style={{ fontWeight: 600, fontSize: 9, color: "var(--warn)" }}>
            ⚠
          </span>
        ) : w.agentCli ? (
          <Avatar cli={w.agentCli} size={16} />
        ) : null}
      </div>

      <div style={{ fontSize: 12, fontWeight: 500, margin: "8px 0 10px", color: merged ? "var(--muted)" : "var(--text)" }}>
        {w.title}
      </div>

      {merged ? (
        <div className="mono" style={{ fontSize: 10.5, lineHeight: 1.6, color: "var(--dim)" }}>
          {w.note}
          <br />“{w.taskId} voltou ao trunk ✓”
        </div>
      ) : (
        <>
          <div className="mono" style={{ fontSize: 10.5, lineHeight: 1.7, color: "var(--muted)" }}>
            {w.files.map((f) => (
              <div key={f.path} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                ▸ {f.path} <span style={{ color: "var(--done)" }}>+{f.added}</span>{" "}
                {f.removed > 0 ? <span style={{ color: "var(--bad)" }}>−{f.removed}</span> : null}
              </div>
            ))}
            <div style={{ color: "var(--dim)" }}>
              …{w.totals.files} arquivos · <span style={{ color: "var(--done)" }}>+{w.totals.added}</span>{" "}
              <span style={{ color: "var(--bad)" }}>−{w.totals.removed}</span>
            </div>
          </div>

          {w.note ? (
            <div
              className="mono"
              style={{
                marginTop: 8,
                padding: "6px 9px",
                background: attention ? "rgba(240,176,78,.1)" : "rgba(238,106,95,.08)",
                borderRadius: 5,
                fontSize: 10,
                lineHeight: 1.5,
                color: attention ? "var(--warn)" : "var(--bad)",
              }}
            >
              {w.note}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
            <GateChip name="exec" v={w.gates.exec} />
            <GateChip name="tests" v={w.gates.tests} />
            <GateChip name="review" v={w.gates.review} />
          </div>
        </>
      )}
    </div>
  );
}

function GateChip({ name, v }: { name: string; v: boolean | null }): ReactNode {
  const color = v === true ? "var(--done)" : v === false ? "var(--bad)" : "var(--dim)";
  const bg = v === true ? "rgba(83,208,138,.15)" : v === false ? "rgba(238,106,95,.15)" : "var(--chip)";
  return (
    <span className="mono" style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: bg, color }}>
      {name} {v === true ? "✓" : v === false ? "✗" : ""}
    </span>
  );
}
