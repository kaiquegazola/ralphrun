// Workforce.tsx — 1g. Preflight is CONTINUOUS: the main process re-probes on a
// timer and pushes, so a cli you log into in another terminal turns green here
// without a restart. The right column is the executor/advisor pair for one
// project, because that pairing is a per-project decision.

import { useState, type ReactNode } from "react";

import { rpc, useQuery } from "../api.ts";
import type { Nav } from "../app.tsx";
import type { AgentSpecView, AgentView } from "../../shared/types.ts";
import { agentColor } from "../../shared/identity.ts";
import { Avatar, Empty, Kicker, ago } from "../ui.tsx";

export function Workforce({ nav }: { nav: Nav }): ReactNode {
  const wf = useQuery(() => rpc.request.workforce({}), ["workforce", "runs"]);
  const projects = useQuery(() => rpc.request.listProjects({}), []);
  const [projectId, setProjectId] = useState<string | null>(null);

  const active = projectId ?? projects.data?.[0]?.id ?? null;
  const settings = useQuery(
    () => (active ? rpc.request.projectSettings({ projectId: active }) : Promise.resolve(null)),
    [],
    active ?? "",
  );

  if (!wf.data) return <Empty>rodando preflight…</Empty>;

  const setPair = async (executor: AgentSpecView, advisor: AgentSpecView | null): Promise<void> => {
    if (!active) return;
    await rpc.request.setPair({ projectId: active, executor, advisor });
    settings.reload();
  };

  const usable = wf.data.agents.filter((a) => a.installed && a.loggedIn);
  const cross =
    settings.data && settings.data.advisor ? settings.data.executor.cli !== settings.data.advisor.cli : false;

  return (
    <div>
      <div className="topbar" style={{ gap: 18 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Workforce</span>
        <div className="grow" />
        <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
          preflight contínuo · última checagem {ago(wf.data.checkedAt)} ↻
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr .9fr", minHeight: 0 }}>
        <div style={{ padding: "16px 20px", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 9 }}>
          {wf.data.agents.map((a) => (
            <AgentRow key={a.cli} a={a} />
          ))}

          <div
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 14px",
              background: wf.data.browser.ok ? "rgba(83,208,138,.05)" : "rgba(240,176,78,.05)",
              border: `1px solid ${wf.data.browser.ok ? "rgba(83,208,138,.25)" : "rgba(240,176,78,.25)"}`,
              borderRadius: 8,
              fontSize: 11,
              color: "var(--muted)",
            }}
          >
            <span style={{ color: wf.data.browser.ok ? "var(--done)" : "var(--warn)" }}>{wf.data.browser.ok ? "✓" : "⚠"}</span>
            {wf.data.browser.label}
          </div>
        </div>

        <div style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Kicker>PAR DO PROJETO</Kicker>
            <div className="grow" />
            {projects.data && projects.data.length > 0 ? (
              <select
                className="mono field"
                style={{ fontSize: 10.5 }}
                value={active ?? ""}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          {!settings.data ? (
            <div style={{ fontSize: 11.5, color: "var(--dim)" }}>
              adicione um projeto para escolher o par executor/advisor
            </div>
          ) : (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>executor</div>
              <PairPicker
                spec={settings.data.executor}
                agents={usable}
                onChange={(spec) => spec && void setPair(spec, settings.data!.advisor)}
              />

              <div className="mono" style={{ display: "flex", justifyContent: "center", margin: "8px 0", fontSize: 10, color: "var(--dim)" }}>
                {settings.data.advisor ? (
                  cross ? (
                    <span>
                      × família diferente — <span style={{ color: "var(--teal)" }}>CROSS</span>
                    </span>
                  ) : (
                    <span>
                      mesma cli — <span style={{ color: "var(--done)" }}>NATIVE</span>
                    </span>
                  )
                ) : (
                  <span>sem advisor — o executor decide sozinho</span>
                )}
              </div>

              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
                advisor <span style={{ color: "var(--dim)" }}>(pode desligar)</span>
              </div>
              <PairPicker
                spec={settings.data.advisor}
                agents={usable}
                allowNone
                onChange={(spec) => void setPair(settings.data!.executor, spec)}
              />
            </div>
          )}

          <div style={{ margin: "16px 0 10px" }}>
            <Kicker>IDENTIDADE DOS AGENTES</Kicker>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {wf.data.agents.map((a) => (
              <span
                key={a.cli}
                className="mono"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 10,
                  color: "var(--muted)",
                  background: "var(--panel)",
                  border: "1px solid var(--line)",
                  padding: "5px 9px",
                  borderRadius: 6,
                }}
              >
                <span style={{ width: 10, height: 10, borderRadius: 3, background: agentColor(a.cli) }} />
                {a.cli}
              </span>
            ))}
          </div>
          <div className="mono" style={{ fontSize: 10, lineHeight: 1.6, color: "var(--dim)", marginTop: 10 }}>
            cor por CLI, consistente em todas as telas — avatar mono 2 letras, sem mascote
          </div>

          {active ? (
            <button className="btn quiet" style={{ marginTop: 14 }} onClick={() => nav({ t: "settings", projectId: active })}>
              abrir configurações do projeto
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AgentRow({ a }: { a: AgentView }): ReactNode {
  const broken = !a.installed || !a.loggedIn;
  return (
    <div
      className="card"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderColor: !a.installed ? "var(--line-soft)" : a.loggedIn ? "var(--line)" : "rgba(240,176,78,.35)",
        background: a.installed ? "var(--panel)" : "var(--panel-dim)",
        opacity: a.installed ? 1 : 0.6,
      }}
    >
      <Avatar cli={a.cli} size={36} />
      <div style={{ minWidth: 150 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{a.cli}</div>
        <div
          className="mono"
          style={{ fontSize: 10, color: !a.installed ? "var(--bad)" : a.loggedIn ? "var(--done)" : "var(--warn)" }}
        >
          {!a.installed ? "✗ não instalado" : a.loggedIn ? "✓ instalado · logado" : "⚠ instalado · não logado"}
        </div>
      </div>

      {broken ? (
        <button
          className="mono field"
          style={{ flex: 1, fontSize: 10.5, textAlign: "left" }}
          title="copiar"
          onClick={() => void navigator.clipboard.writeText(a.hint ?? "")}
        >
          $ {a.hint} <span style={{ color: "var(--dim)" }}>— copiar</span>
        </button>
      ) : (
        <div style={{ flex: 1, display: "flex", gap: 5, flexWrap: "wrap" }}>
          {a.models.map((m) => (
            <span
              key={m.name}
              className="mono"
              style={{
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 4,
                background: m.recommended ? `${agentColor(a.cli)}24` : "var(--chip)",
                color: m.recommended ? agentColor(a.cli) : "var(--muted)",
                border: m.recommended ? `1px solid ${agentColor(a.cli)}59` : undefined,
              }}
            >
              {m.name}
              {m.recommended ? " ★rec" : ""}
            </span>
          ))}
        </div>
      )}

      <span className="mono" style={{ fontSize: 10, color: "var(--dim)", whiteSpace: "nowrap" }}>
        {a.activeTasks > 0 ? `${a.activeTasks} ${a.activeTasks === 1 ? "task ativa" : "tasks ativas"}` : ""}
      </span>
    </div>
  );
}

export function PairPicker({
  spec,
  agents,
  allowNone,
  onChange,
}: {
  spec: AgentSpecView | null;
  agents: AgentView[];
  allowNone?: boolean;
  onChange: (spec: AgentSpecView | null) => void;
}): ReactNode {
  const value = spec ? `${spec.cli}:${spec.model}` : "none";
  const color = spec ? agentColor(spec.cli) : "var(--dim)";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "9px 11px",
        background: "var(--inset)",
        border: `1px solid ${spec ? `${color}66` : "var(--line)"}`,
        borderRadius: 7,
      }}
    >
      {spec ? <Avatar cli={spec.cli} size={24} /> : null}
      <select
        className="mono"
        style={{ flex: 1, fontSize: 12, background: "transparent", color: "var(--text)" }}
        value={value}
        onChange={(e) => {
          if (e.target.value === "none") return onChange(null);
          const [cli, ...rest] = e.target.value.split(":");
          onChange({ cli, model: rest.join(":") });
        }}
      >
        {allowNone ? <option value="none">none — sem advisor</option> : null}
        {agents.flatMap((a) =>
          a.models.map((m) => (
            <option key={`${a.cli}:${m.name}`} value={`${a.cli}:${m.name}`}>
              {a.cli}:{m.name}
              {m.recommended ? " ★" : ""}
            </option>
          )),
        )}
      </select>
    </div>
  );
}
