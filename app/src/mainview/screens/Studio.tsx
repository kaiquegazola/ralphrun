// Studio.tsx — 1h. Chat on the left, the PRD it is producing on the right,
// both live. The planner streams, so a turn shows its text arriving instead of
// a spinner; the PRD pane redraws when the turn lands.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { act, onChunk, rpc } from "../api.ts";
import type { Nav } from "../app.tsx";
import type { StudioView, TaskView } from "../../shared/types.ts";
import { Avatar, Empty, STATUS_COLOR } from "../ui.tsx";

export function Studio({
  projectId,
  prdPath,
  fresh,
  nav,
}: {
  projectId: string;
  prdPath?: string;
  fresh?: boolean;
  nav: Nav;
}): ReactNode {
  const [state, setState] = useState<StudioView | null>(null);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void rpc.request.studioOpen({ projectId, prdPath, fresh }).then(setState);
  }, [projectId, prdPath, fresh]);

  useEffect(
    () =>
      onChunk((p, text) => {
        if (p === projectId) setStreaming((prev) => prev + text);
      }),
    [projectId],
  );

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [state?.messages.length, streaming]);

  if (!state) return <Empty>abrindo studio…</Empty>;

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setStreaming("");
    setBusy(true);
    try {
      setState(await rpc.request.studioSend({ projectId, text }));
    } finally {
      setStreaming("");
      setBusy(false);
    }
  };

  const build = async (): Promise<void> => {
    const saved = await rpc.request.studioSave({ projectId });
    setState(saved);
    // `dirty` is what a SUCCESSFUL save clears. A failed write leaves the old
    // prdPath in place, and building on it would run the previous backlog while
    // the chat shows the error for the one that never landed.
    if (!saved.prdPath || saved.dirty) return;
    act(rpc.request.startRun({ projectId, prdPath: saved.prdPath }), ({ runId }) => nav({ t: "run", runId }));
  };

  const taskCount = state.tasks.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="topbar" style={{ gap: 14 }}>
        <button className="crumb" onClick={() => nav({ t: "project", id: projectId })}>
          projeto /
        </button>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Studio</span>
        <span
          className="mono"
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 4,
            background: state.depsOk ? "rgba(83,208,138,.12)" : "rgba(238,106,95,.12)",
            color: state.depsOk ? "var(--done)" : "var(--bad)",
          }}
        >
          {taskCount} tarefas · {state.depsOk ? "deps ok" : `${state.errors.length} erro(s)`}
        </span>
        <div className="grow" />
        <button
          className="mono"
          style={{ fontSize: 10, color: state.undoDepth > 0 ? "var(--muted)" : "var(--dim)" }}
          disabled={state.undoDepth === 0}
          onClick={() => void rpc.request.studioUndo({ projectId }).then(setState)}
        >
          ↶ desfazer (v{state.undoDepth + 1})
        </button>
        <button className="btn" disabled={!state.depsOk} onClick={() => void rpc.request.studioSave({ projectId }).then(setState)}>
          salvar PRD
        </button>
        <button className="btn go" disabled={!state.depsOk || busy} onClick={() => void build()}>
          construir ▶
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 400px", flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid var(--line)", minHeight: 0 }}>
          <div ref={chatRef} className="scroll" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
            {state.messages.length === 0 && !streaming ? (
              <div style={{ color: "var(--dim)", fontSize: 12 }}>
                descreva o produto. o planner responde com um ESQUELETO primeiro (ids, títulos, deps) e expande as tasks
                nos turnos seguintes.
              </div>
            ) : null}

            {state.messages.map((m, i) =>
              m.role === "you" ? (
                <div
                  key={i}
                  style={{
                    alignSelf: "flex-end",
                    maxWidth: "70%",
                    background: "#1c2431",
                    borderRadius: "10px 10px 3px 10px",
                    padding: "9px 13px",
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {m.text}
                </div>
              ) : (
                <PlannerBubble key={i} text={m.text} planner={state.planner} error={m.role === "error"} />
              ),
            )}

            {streaming ? <PlannerBubble text={streaming} planner={state.planner} typing /> : null}
          </div>

          <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
            {state.attachments.length > 0 ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                {state.attachments.map((a) => (
                  <span
                    key={a}
                    className="mono"
                    style={{ fontSize: 10, background: "var(--chip)", color: "var(--muted)", padding: "3px 8px", borderRadius: 4 }}
                  >
                    @{a.split("/").slice(-1)[0]}
                  </span>
                ))}
              </div>
            ) : null}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "var(--panel)",
                border: "1px solid rgba(255,255,255,.12)",
                borderRadius: 8,
                padding: "10px 14px",
              }}
            >
              <button
                className="mono"
                style={{ fontSize: 12, color: "var(--dim)" }}
                title="anexar arquivo"
                onClick={() => void rpc.request.studioAttach({ projectId }).then(setState)}
              >
                @
              </button>
              <input
                style={{ flex: 1, fontSize: 12.5 }}
                placeholder={busy ? "planner respondendo…" : "descreva o que construir…"}
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button className="btn primary" disabled={busy || draft.trim() === ""} onClick={() => void send()}>
                enviar ⏎
              </button>
            </div>
            {state.errors.length > 0 ? (
              <div className="mono" style={{ marginTop: 8, fontSize: 10.5, color: "var(--bad)", lineHeight: 1.5 }}>
                {state.errors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <PrdPane state={state} />
      </div>
    </div>
  );
}

function PlannerBubble({
  text,
  planner,
  typing,
  error,
}: {
  text: string;
  planner: { cli: string; model: string };
  typing?: boolean;
  error?: boolean;
}): ReactNode {
  return (
    <div style={{ maxWidth: "82%", display: "flex", gap: 10 }}>
      <Avatar cli={planner.cli} size={26} />
      <div
        style={{
          background: "var(--panel)",
          border: `1px solid ${error ? "rgba(238,106,95,.4)" : "var(--line-soft)"}`,
          borderRadius: "3px 10px 10px 10px",
          padding: "9px 13px",
          fontSize: 12.5,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          color: error ? "var(--bad)" : "var(--text)",
        }}
      >
        <div className="mono" style={{ fontSize: 10, color: "var(--dim)", marginBottom: 6 }}>
          planner · {planner.cli}:{planner.model}
        </div>
        {text}
        {typing ? <span className="pulse">▌</span> : null}
      </div>
    </div>
  );
}

function PrdPane({ state }: { state: StudioView }): ReactNode {
  const waves = state.tasks.length === 0 ? 0 : Math.max(...state.tasks.map((t) => t.wave)) + 1;
  const widest = countWidest(state.tasks);

  return (
    <div style={{ background: "var(--inset)", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "11px 14px", borderBottom: "1px solid var(--line)" }}>
        <span className="mono" style={{ fontWeight: 600, fontSize: 11 }}>
          PRD.json
        </span>
        <div className="grow" />
        <span className="mono" style={{ fontSize: 10, color: state.depsOk ? "var(--done)" : "var(--bad)" }}>
          {state.depsOk ? "✓ validado" : "✗ inválido"}
        </span>
      </div>

      <div className="scroll" style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
        {state.tasks.length === 0 ? (
          <div style={{ color: "var(--dim)", fontSize: 11.5 }}>o PRD aparece aqui conforme o planner responde</div>
        ) : (
          state.tasks.map((t) => <TaskRow key={t.id} t={t} />)
        )}
      </div>

      <div
        className="mono"
        style={{ padding: "10px 14px", borderTop: "1px solid var(--line-soft)", fontSize: 10, lineHeight: 1.6, color: "var(--dim)" }}
      >
        waves previstas: {waves} · paralelismo máx: {widest}
        <br />
        undo stack: {state.undoDepth} versão(ões) · {state.dirty ? "não salvo" : state.prdPath ? "salvo" : "sem arquivo"}
      </div>
    </div>
  );
}

function TaskRow({ t }: { t: TaskView }): ReactNode {
  // a skeleton task (no verify yet) reads as "still to expand" — the planner
  // fills those in a later turn and the run refuses to start without them.
  const skeleton = !t.verify;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "6px 9px",
        borderRadius: 6,
        background: skeleton ? "var(--sel-blue-soft)" : "var(--panel)",
        outline: skeleton ? "1px solid rgba(90,167,240,.4)" : undefined,
      }}
    >
      <span className="dot" style={{ width: 7, height: 7, background: STATUS_COLOR[t.status] }} />
      <span className="mono" style={{ fontWeight: 600, fontSize: 10.5, color: skeleton ? "var(--doing)" : "var(--muted)" }}>
        {t.id}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t.title}
      </span>
      {t.deps.length > 0 ? (
        <span className="mono" style={{ fontSize: 9, color: "var(--dim)" }}>
          ←{t.deps.join(",")}
        </span>
      ) : null}
    </div>
  );
}

/** The widest wave — the real ceiling on parallelism, set by the plan not the config. */
function countWidest(tasks: TaskView[]): number {
  const perWave = new Map<number, number>();
  for (const t of tasks) perWave.set(t.wave, (perWave.get(t.wave) ?? 0) + 1);
  return perWave.size === 0 ? 0 : Math.max(...perWave.values());
}
