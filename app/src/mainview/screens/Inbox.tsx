// Inbox.tsx — 1e. Asynchronous by construction: this is a drawer over a live
// board, never a modal, so answering one decision does not stop the tasks that
// are still fine. "Aceitar" appears only while the loop is still holding the
// task (canAccept) — once a run has given up on one, accepting could only mark
// work that no longer exists as delivered.

import { useState, type ReactNode } from "react";

import { act, reportError, rpc, useQuery } from "../api.ts";
import type { Nav } from "../app.tsx";
import type { DecisionView } from "../../shared/types.ts";
import { ago, clock, Empty } from "../ui.tsx";

export function Inbox({ nav, onClose }: { nav: Nav; onClose: () => void }): ReactNode {
  const { data } = useQuery(() => rpc.request.listDecisions({}), ["decisions", "runs"]);
  // resolved-today is session memory on purpose: the durable record of what a
  // task ended up doing is progress.md, and duplicating it here would be a
  // second history free to disagree with the first.
  const [resolved, setResolved] = useState<{ at: number; text: string }[]>([]);

  const answer = (d: DecisionView, action: "retry" | "accept" | "skip"): void => {
    act(
      rpc.request.resolveDecision({
        runId: d.runId,
        projectId: d.projectId,
        prdPath: d.prdPath,
        taskId: d.taskId,
        action,
      }),
      (res) => {
        // A refusal RESOLVES the request and still means the decision stands —
        // the task moved on, the PRD is unreadable, another run owns the
        // workspace. Filing that under "resolvidas" would be the app telling
        // the user it handled something it did not.
        if (!res.ok) return reportError(res.message);
        setResolved((prev) => [{ at: Date.now(), text: res.message }, ...prev].slice(0, 6));
      },
    );
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: "1px solid var(--line)" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Decisões</span>
        {data && data.length > 0 ? (
          <span
            className="mono"
            style={{ fontSize: 10, fontWeight: 600, background: "var(--warn)", color: "#0a0c0f", borderRadius: 10, padding: "1px 7px" }}
          >
            {data.length}
          </span>
        ) : null}
        <div className="grow" />
        <button className="mono" style={{ fontSize: 10, color: "var(--dim)" }} onClick={onClose}>
          fechar ✕
        </button>
      </div>

      <div className="scroll">
        {!data ? (
          <Empty>carregando…</Empty>
        ) : data.length === 0 ? (
          <Empty>nada aguardando você — o board segue sozinho</Empty>
        ) : (
          data.map((d) => (
            <div key={d.id} style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-soft)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  className="mono"
                  style={{ fontWeight: 600, fontSize: 11, color: d.kind === "stall" ? "var(--bad)" : "var(--warn)" }}
                >
                  {d.taskId}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  {d.kind === "stall" ? "stall" : d.kind === "review-blocked" ? "review bloqueado" : "bloqueada"}
                </span>
                <div className="grow" />
                <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
                  {ago(d.since)}
                </span>
              </div>

              <div style={{ fontSize: 11, color: "var(--muted)", margin: "6px 0 8px" }}>
                {d.projectName} · {d.taskTitle} · {d.reason}
              </div>

              {d.feedback ? (
                <div
                  className="mono"
                  style={{
                    background: "rgba(240,138,99,.06)",
                    borderLeft: "2px solid #f08a63",
                    padding: "7px 9px",
                    borderRadius: "0 5px 5px 0",
                    fontSize: 10.5,
                    lineHeight: 1.5,
                    color: "var(--soft)",
                  }}
                >
                  reviewer: “{d.feedback}”
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
                <button className={d.kind === "stall" ? "btn bad" : "btn warn"} onClick={() => answer(d, "retry")}>
                  {d.kind === "stall" ? "reiniciar task" : "corrigir de novo"}
                </button>
                {d.canAccept ? (
                  <button className="btn" onClick={() => answer(d, "accept")}>
                    aceitar
                  </button>
                ) : null}
                <button className="btn quiet" onClick={() => answer(d, "skip")}>
                  pular
                </button>
              </div>

              {d.runId && d.diffstat ? <Diff runId={d.runId} taskId={d.taskId} /> : null}

              <div className="mono" style={{ fontSize: 10, color: "var(--dim)", marginTop: 7, display: "flex", gap: 10 }}>
                {d.diffstat ? (
                  <span>
                    diff +{d.diffstat.added} −{d.diffstat.removed} · {d.diffstat.files} arquivos
                  </span>
                ) : null}
                {d.runId ? (
                  <button style={{ color: "var(--dim)", fontSize: 10 }} onClick={() => nav({ t: "run", runId: d.runId! })}>
                    abrir run ↗
                  </button>
                ) : (
                  <button style={{ color: "var(--dim)", fontSize: 10 }} onClick={() => nav({ t: "project", id: d.projectId })}>
                    abrir projeto ↗
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {resolved.length > 0 ? (
        <div
          className="mono"
          style={{ padding: "10px 14px", borderTop: "1px solid var(--line-soft)", fontSize: 10, lineHeight: 1.5, color: "var(--dim)" }}
        >
          resolvidas nesta sessão: {resolved.map((r) => `${r.text} (${clock(r.at)})`).join(" · ")}
        </div>
      ) : null}
    </>
  );
}

/**
 * The patch itself, one click away.
 *
 * "Aceitar" commits this work to the trunk. Approving it from a +/- count alone
 * is not reviewing it, so the diff has to be reachable right here — collapsed
 * by default, because the inbox is a queue and most decisions are answered by
 * the reviewer's words above.
 */
function Diff({ runId, taskId }: { runId: string; taskId: string }): ReactNode {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const toggle = async (): Promise<void> => {
    setOpen((v) => !v);
    if (text !== null) return;
    const res = await rpc.request.taskDiff({ runId, taskId });
    setText(res.diff || "(sem diff — o trabalho desta tentativa não está mais em disco)");
  };

  return (
    <div style={{ marginTop: 8 }}>
      <button className="mono" style={{ fontSize: 10, color: "var(--doing)" }} onClick={() => void toggle()}>
        {open ? "esconder diff ▴" : "ver diff ▾"}
      </button>
      {open ? (
        <pre
          className="mono"
          style={{
            margin: "6px 0 0",
            padding: "8px 10px",
            maxHeight: 260,
            overflow: "auto",
            background: "var(--deep)",
            border: "1px solid var(--line-soft)",
            borderRadius: 6,
            fontSize: 10.5,
            lineHeight: 1.5,
            whiteSpace: "pre",
            color: "var(--soft)",
          }}
        >
          {text ?? "carregando…"}
        </pre>
      ) : null}
    </div>
  );
}
