// Project.tsx — 4b. The unit inside a project is a PRD, and a PRD is either
// drafting, running, or history. Whether two of them can run at once is a
// property of the repo (worktrees on/off), so that state is in the header
// rather than buried in settings.

import type { ReactNode } from "react";

import { act, rpc, useQuery } from "../api.ts";
import type { Nav } from "../app.tsx";
import type { PrdView, RunSummary } from "../../shared/types.ts";
import { Empty, ProgressBar, RunBadge, elapsed, useNow } from "../ui.tsx";

export function Project({ id, nav }: { id: string; nav: Nav }): ReactNode {
  const { data, reload } = useQuery(() => rpc.request.getProject({ id }), ["runs", "decisions"], id);
  const settings = useQuery(() => rpc.request.projectSettings({ projectId: id }), [], id);
  const now = useNow();
  if (!data) return <Empty>carregando…</Empty>;

  const { project, prds, history } = data;
  const worktrees = settings.data?.worktreePerTask ?? false;
  const runById = new Map(project.runs.map((r) => [r.id, r]));

  return (
    <div>
      <div className="topbar" style={{ borderBottom: "1px solid var(--line)", gap: 14 }}>
        <button className="crumb" onClick={() => nav({ t: "projects" })}>
          projetos /
        </button>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{project.name}</span>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--dim)" }}>
          {project.shortDir} · {project.branch ?? "sem branch"}
        </span>
        <div className="grow" />
        <span
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            color: worktrees ? "var(--done)" : "var(--dim)",
            border: `1px solid ${worktrees ? "rgba(83,208,138,.3)" : "var(--line-hard)"}`,
            borderRadius: 12,
            padding: "3px 10px",
          }}
        >
          ⌥ git worktree {worktrees ? "ON — runs em paralelo" : "OFF — uma run por vez (fila)"}
        </span>
        <button className="btn quiet" onClick={() => nav({ t: "worktrees", projectId: id })}>
          worktrees
        </button>
        <button className="btn quiet" onClick={() => nav({ t: "settings", projectId: id })}>
          ⚙
        </button>
        <button className="btn primary" onClick={() => nav({ t: "studio", projectId: id, fresh: true })}>
          + Novo PRD
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 18px" }}>
        {prds.length === 0 ? (
          <Empty>
            nenhum PRD ainda — abra o studio e descreva o que construir
          </Empty>
        ) : (
          prds.map((prd) => (
            <PrdCard
              key={prd.path}
              prd={prd}
              run={prd.runId ? (runById.get(prd.runId) ?? null) : null}
              now={now}
              projectId={id}
              nav={nav}
              onChanged={reload}
            />
          ))
        )}

        {project.runs.length > 1 ? (
          <div
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              background: "rgba(83,208,138,.04)",
              border: "1px dashed rgba(83,208,138,.25)",
              borderRadius: 8,
              fontSize: 10.5,
              lineHeight: 1.5,
              color: "var(--dim)",
            }}
          >
            {project.runs.length} runs ativas no mesmo repo — cada uma isola tasks nas próprias worktrees; commits voltam
            pro trunk um por task.
          </div>
        ) : null}

        {history.length > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "6px 2px 0", flexWrap: "wrap" }}>
            <span className="kicker" style={{ fontSize: 9.5 }}>
              HISTÓRICO
            </span>
            {history.map((h) => (
              <span key={h.id} className="mono" style={{ fontSize: 10.5, color: "var(--dim)" }}>
                {h.prdName} —{" "}
                <span style={{ color: h.status === "done" ? "var(--done)" : "var(--bad)" }}>
                  {h.status === "done" ? "✓ concluída" : `✗ ${h.status}`}
                </span>{" "}
                · {h.done}/{h.total} · {elapsed(h.startedAt, h.endedAt ?? h.startedAt)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PrdCard({
  prd,
  run,
  now,
  projectId,
  nav,
  onChanged,
}: {
  prd: PrdView;
  run: RunSummary | null;
  now: number;
  projectId: string;
  nav: Nav;
  onChanged: () => void;
}): ReactNode {
  const tone = run
    ? run.status === "attention"
      ? "rgba(240,176,78,.4)"
      : "rgba(90,167,240,.35)"
    : "var(--line-soft)";

  return (
    <div className="card" style={{ borderColor: tone, padding: "13px 15px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: run ? "var(--text)" : "var(--soft)" }}>{prd.name}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
          {prd.taskCount} tasks · {prd.doneCount} done
        </span>
        {run ? (
          <RunBadge status={run.status} suffix={`WAVE ${run.wave}/${run.waveCount}`} />
        ) : (
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 12,
              background: "rgba(169,140,245,.12)",
              color: "var(--purple)",
            }}
          >
            {prd.depsOk ? "PRONTO" : "RASCUNHO"}
          </span>
        )}
        {!prd.depsOk ? (
          <span className="mono" style={{ fontSize: 10, color: "var(--bad)" }} title={prd.depErrors.join("\n")}>
            {prd.depErrors.length} problema(s) de validação
          </span>
        ) : null}

        <div className="grow" />

        {run ? (
          <>
            <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
              {elapsed(run.startedAt, run.endedAt ?? now)}
            </span>
            <button className="btn" onClick={() => nav({ t: "run", runId: run.id })}>
              abrir run →
            </button>
          </>
        ) : (
          <>
            <button className="btn quiet" onClick={() => nav({ t: "studio", projectId, prdPath: prd.path })}>
              studio ✎
            </button>
            <button
              className="btn go"
              disabled={!prd.depsOk}
              title={prd.depsOk ? undefined : prd.depErrors.join("\n")}
              onClick={() =>
                act(rpc.request.startRun({ projectId, prdPath: prd.path }), ({ runId }) => {
                  onChanged();
                  nav({ t: "run", runId });
                })
              }
            >
              construir ▶
            </button>
          </>
        )}
      </div>

      {run ? (
        <div style={{ marginTop: 10 }}>
          <ProgressBar done={run.done} doing={run.doing} blocked={run.blocked} total={run.total} height={6} />
        </div>
      ) : null}
    </div>
  );
}
