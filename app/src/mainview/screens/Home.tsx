// Home.tsx — 5a, the cockpit. Order is the argument: what needs YOU, then what
// is running, then what you can pick back up. Workforce is a status strip at
// the bottom because it is only interesting when something in it is wrong.

import type { ReactNode } from "react";

import { act, reportError, rpc, useQuery } from "../api.ts";
import type { Nav } from "../app.tsx";
import type { DecisionView, RunSummary } from "../../shared/types.ts";
import { ago, clock, elapsed, Empty, Kicker, ProgressBar, useNow } from "../ui.tsx";

export function Home({ nav }: { nav: Nav }): ReactNode {
  const { data } = useQuery(() => rpc.request.home({}), ["runs", "decisions", "workforce", "projects"]);
  const now = useNow();
  if (!data) return <Empty>carregando…</Empty>;

  // the REGISTRY, not the activity: a project registered from the terminal and
  // simply idle is still a project, and saying "Adicionar projeto" would read
  // as if the app had lost it
  const noProjects = data.projectCount === 0;
  // A draft belongs to a PROJECT, and Home does not know which one you mean
  // unless there is only one. Read off the REGISTRY, not off activity: a lone
  // project that is simply idle is still the obvious destination.
  const soleProject = data.soleProjectId;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1.25fr .75fr", gap: 16, padding: "18px 20px 8px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <section>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
              <Kicker color="var(--warn)">PRECISA DE VOCÊ</Kicker>
              {data.decisions.length > 0 ? (
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    background: "var(--warn)",
                    color: "#0a0c0f",
                    borderRadius: 10,
                    padding: "1px 7px",
                  }}
                >
                  {data.decisions.length}
                </span>
              ) : null}
            </div>
            {data.decisions.length === 0 ? (
              <div className="card" style={{ padding: "12px 14px", fontSize: 12, color: "var(--dim)" }}>
                nada travado — a UI só grita quando há decisão humana de verdade
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {data.decisions.map((d) => (
                  <DecisionRow key={d.id} d={d} nav={nav} />
                ))}
              </div>
            )}
          </section>

          <section>
            <Kicker color="var(--doing)">
              AGORA RODANDO · {data.runs.length} {data.runs.length === 1 ? "RUN" : "RUNS"}
            </Kicker>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 9 }}>
              {data.runs.length === 0 ? (
                <div className="card" style={{ padding: "12px 14px", fontSize: 12, color: "var(--dim)" }}>
                  nenhuma run ativa
                </div>
              ) : (
                        data.runs.map((r) => <RunRow key={r.id} r={r} now={now} nav={nav} />)
              )}
            </div>
          </section>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ padding: "13px 15px" }}>
            <Kicker>RETOMAR</Kicker>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
              {data.resume.length === 0 ? (
                <div style={{ fontSize: 11.5, color: "var(--dim)" }}>nenhum rascunho aberto</div>
              ) : (
                data.resume.map((r) => (
                  <div
                    key={`${r.projectId}:${r.prdPath}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      background: "var(--inset)",
                      borderRadius: 6,
                    }}
                  >
                    <span className="mono" style={{ fontSize: 11, color: "var(--purple)" }}>
                      ✎
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{r.name}</div>
                      <div className="mono" style={{ fontSize: 9.5, color: "var(--dim)" }}>
                        {r.note}
                      </div>
                    </div>
                    {r.runnable ? (
                      <button
                        className="btn go"
                        onClick={() =>
                          act(rpc.request.startRun({ projectId: r.projectId, prdPath: r.prdPath }), ({ runId }) =>
                            nav({ t: "run", runId }),
                          )
                        }
                      >
                        ▶
                      </button>
                    ) : (
                      <button
                        className="btn"
                        style={{ borderColor: "rgba(169,140,245,.5)", color: "var(--purple)" }}
                        onClick={() => nav({ t: "studio", projectId: r.projectId, prdPath: r.prdPath || undefined })}
                      >
                        studio
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card" style={{ padding: "13px 15px" }}>
            <Kicker>ATIVIDADE</Kicker>
            <div
              className="mono"
              style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10, fontSize: 10.5, lineHeight: 1.5, color: "var(--muted)" }}
            >
              {data.activity.length === 0 ? (
                <span style={{ color: "var(--dim)" }}>sem atividade ainda</span>
              ) : (
                data.activity.map((a, i) => (
                  <div key={i}>
                    <span style={{ color: a.kind === "merge" ? "var(--done)" : "var(--teal)" }}>
                      {a.kind === "merge" ? "✓" : "⇄"}
                    </span>{" "}
                    {a.text} <span style={{ color: "var(--dim)" }}>{a.projectName} · {clock(a.at)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <button
            onClick={() =>
              soleProject ? nav({ t: "studio", projectId: soleProject, fresh: true }) : nav({ t: "projects" })
            }
            style={{
              border: "1px dashed var(--line-hard)",
              borderRadius: 9,
              padding: "12px 15px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "var(--muted)",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            <span className="mono" style={{ fontWeight: 600, fontSize: 13, color: "var(--doing)" }}>
              +
            </span>
            {noProjects ? "Adicionar projeto" : soleProject ? "Novo PRD" : "Escolher projeto"}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          margin: "10px 20px 16px",
          padding: "9px 14px",
          background: "var(--chrome)",
          border: "1px solid var(--line-soft)",
          borderRadius: 8,
        }}
      >
        <span className="kicker" style={{ fontSize: 9.5 }}>
          WORKFORCE
        </span>
        {data.workforce.map((w) => (
          <span
            key={w.cli}
            className="mono"
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: w.ok ? "var(--muted)" : "var(--warn)" }}
          >
            <span className="dot" style={{ width: 6, height: 6, background: w.ok ? "var(--done)" : "var(--warn)" }} />
            {w.cli}
            {w.note ? ` ${w.note}` : ""}
          </span>
        ))}
        <div className="grow" />
        <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
          {data.busy} agentes ocupados · {data.free} livres · preflight {ago(data.checkedAt)} ↻
        </span>
      </div>
    </div>
  );
}

function DecisionRow({ d, nav }: { d: DecisionView; nav: Nav }): ReactNode {
  const tone = d.kind === "stall" ? "var(--bad)" : "var(--warn)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 14px",
        background: `${tone === "var(--bad)" ? "rgba(238,106,95,.05)" : "rgba(240,176,78,.06)"}`,
        border: `1px solid ${tone === "var(--bad)" ? "rgba(238,106,95,.35)" : "rgba(240,176,78,.4)"}`,
        borderRadius: 8,
      }}
    >
      <span className="mono" style={{ fontWeight: 600, fontSize: 11, color: tone }}>
        {d.taskId}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{d.reason}</div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
          {d.projectName} › {d.prdName} · {d.taskTitle}
        </div>
      </div>
      <button
        className={d.kind === "stall" ? "btn bad" : "btn warn"}
        onClick={() =>
          act(
            rpc.request.resolveDecision({
              runId: d.runId,
              projectId: d.projectId,
              prdPath: d.prdPath,
              taskId: d.taskId,
              action: "retry",
            }),
            (res) => {
              // a refusal is not a resolution: navigating away would hide it
              if (!res.ok) return reportError(res.message);
              nav(d.runId ? { t: "run", runId: d.runId } : { t: "project", id: d.projectId });
            },
          )
        }
      >
        {d.kind === "stall" ? "reiniciar" : "resolver"}
      </button>
      <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
        {ago(d.since)}
      </span>
    </div>
  );
}

function RunRow({ r, now, nav }: { r: RunSummary; now: number; nav: Nav }): ReactNode {
  return (
    <button
      className="card clickable"
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", textAlign: "left" }}
      onClick={() => nav({ t: "run", runId: r.id })}
    >
      <span className="dot pulse" style={{ background: r.status === "attention" ? "var(--warn)" : "var(--doing)" }} />
      <div style={{ minWidth: 260 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.projectName}</span>{" "}
        <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
          › {r.prdName} · wave {r.wave}/{r.waveCount}
        </span>
      </div>
      <ProgressBar done={r.done} doing={r.doing} blocked={r.blocked} total={r.total} />
      <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
        {elapsed(r.startedAt, r.endedAt ?? now)}
      </span>
      <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
        ›
      </span>
    </button>
  );
}
