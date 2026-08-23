// RunDetail.tsx — 1c. The board is grouped by WAVE because that is what the
// loop actually dispatches: a wave is the set of tasks whose deps are all done,
// so the columns are the parallelism, not a decoration. Two modes: calm hides
// the raw stream, surgical puts it next to the board.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { onStream, rpc, useQuery } from "../api.ts";
import type { Nav } from "../app.tsx";
import type { StreamLine, TaskView, TimelineEvent } from "../../shared/types.ts";
import { Avatar, Empty, Kicker, Seg, elapsed, useNow } from "../ui.tsx";

export function RunDetail({ runId, nav }: { runId: string; nav: Nav }): ReactNode {
  const { data: run } = useQuery(() => rpc.request.getRun({ runId }), ["runs", "decisions"], runId);
  const [mode, setMode] = useState<"calm" | "surgical">("surgical");
  const [focus, setFocus] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    void rpc.request.globalSettings({}).then((g) => setMode(g.runDetailMode));
  }, []);

  if (!run) return <Empty>carregando…</Empty>;

  const focused = focus ?? run.focusTaskId ?? run.tasks.find((t) => t.status === "doing")?.id ?? null;
  const waves = groupByWave(run.tasks);
  // only a run with a child on the other end has a wave IN EXECUTION. A
  // finished run reports wave === waveCount, which would otherwise label its
  // last completed wave as still running; a queued one has not started at all.
  // `attention` outlives the child: a run that exits cleanly with tasks still
  // blocked keeps that status. endedAt is what actually says it stopped.
  const live = run.endedAt === null && (run.status === "running" || run.status === "attention");
  const currentWave = live ? run.wave - 1 : -1;
  // configured for parallelism, but this wave holds a task with no declared
  // scope — the core refuses to dispatch those together
  const serialized =
    run.parallel > 1 &&
    run.tasks.some((t) => t.wave === currentWave && t.status !== "done" && t.scope.length === 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="topbar" style={{ gap: 14 }}>
        <button className="crumb" onClick={() => nav({ t: "project", id: run.projectId })}>
          {run.projectName} /
        </button>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{run.prdName}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
          wave {run.wave}/{run.waveCount} · {run.done}/{run.total} done · elapsed{" "}
          {elapsed(run.startedAt, run.endedAt ?? now)}
        </span>
        {serialized ? (
          // The board groups by DEPENDENCY wave, which is the plan. The
          // scheduler adds one rule the plan cannot show: tasks that declare no
          // scope run one at a time, because nothing proves they will not
          // collide. Saying so beats a board that looks stalled.
          <span className="mono" style={{ fontSize: 10, color: "var(--warn)" }} title="tasks sem scope declarado rodam uma por vez">
            ⚠ serializado — tasks sem scope
          </span>
        ) : null}
        <div className="grow" />
        <Seg
          value={mode}
          options={[
            { value: "calm" as const, label: "calmo" },
            { value: "surgical" as const, label: "cirúrgico" },
          ]}
          onChange={setMode}
        />
        <button
          className="btn"
          disabled={run.endedAt !== null}
          onClick={() => void rpc.request.stopRun({ runId })}
        >
          ⏸ pausar
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mode === "surgical" ? "1fr 460px" : "1fr", flex: 1, minHeight: 0 }}>
        <div className="scroll" style={{ padding: "16px 18px", borderRight: mode === "surgical" ? "1px solid var(--line)" : undefined }}>
          {waves.map(([wave, tasks]) => (
            <Wave
              key={wave}
              wave={wave}
              tasks={tasks}
              current={wave === currentWave}
              focused={focused}
              now={now}
              onFocus={setFocus}
            />
          ))}
          <Timeline events={run.timeline} />
        </div>

        {mode === "surgical" ? (
          <Stream
            runId={runId}
            taskId={focused}
            executor={`${run.executor.cli}:${run.executor.model}`}
            task={run.tasks.find((t) => t.id === focused) ?? null}
            onSelect={setFocus}
          />
        ) : null}
      </div>
    </div>
  );
}

function groupByWave(tasks: TaskView[]): [number, TaskView[]][] {
  const map = new Map<number, TaskView[]>();
  for (const t of tasks) {
    const arr = map.get(t.wave) ?? [];
    arr.push(t);
    map.set(t.wave, arr);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function Wave({
  wave,
  tasks,
  current,
  focused,
  now,
  onFocus,
}: {
  wave: number;
  tasks: TaskView[];
  current: boolean;
  focused: string | null;
  now: number;
  onFocus: (id: string) => void;
}): ReactNode {
  const allDone = tasks.every((t) => t.status === "done");
  const [open, setOpen] = useState(!allDone);

  // a finished wave collapses to one line: it is history, and the board's
  // vertical space belongs to what is running.
  if (allDone && !open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          background: "var(--panel-dim)",
          border: "1px solid var(--line-soft)",
          borderRadius: 7,
          marginBottom: 12,
          width: "100%",
          textAlign: "left",
        }}
      >
        <span className="mono" style={{ fontWeight: 600, fontSize: 10, color: "var(--done)" }}>
          WAVE {wave + 1}
        </span>
        <span style={{ fontSize: 11, color: "var(--dim)" }}>
          {tasks.map((t) => t.id).join(" ")} — mergeadas no trunk
        </span>
        <span className="mono" style={{ fontSize: 10, color: "var(--done)" }}>
          {tasks.map(() => "✓").join("")}
        </span>
        <div className="grow" />
        <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
          expandir ▾
        </span>
      </button>
    );
  }

  const label = current ? "EM EXECUÇÃO" : allDone ? "CONCLUÍDA" : "AGUARDANDO DEPS";
  const waiting = !current && !allDone;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
        <Kicker color={current ? "var(--doing)" : allDone ? "var(--done)" : "var(--dim)"}>
          WAVE {wave + 1} · {label}
        </Kicker>
        {allDone ? (
          <button className="mono" style={{ fontSize: 10, color: "var(--dim)" }} onClick={() => setOpen(false)}>
            recolher ▴
          </button>
        ) : null}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, opacity: waiting ? 0.5 : 1 }}>
        {tasks.map((t) => (
          <TaskCard key={t.id} t={t} waiting={waiting} focused={focused === t.id} now={now} onFocus={onFocus} />
        ))}
      </div>
    </div>
  );
}

function TaskCard({
  t,
  waiting,
  focused,
  now,
  onFocus,
}: {
  t: TaskView;
  waiting: boolean;
  focused: boolean;
  now: number;
  onFocus: (id: string) => void;
}): ReactNode {
  if (waiting) {
    return (
      <div
        style={{
          background: "var(--panel-dim)",
          border: "1px dashed var(--line-hard)",
          borderRadius: 8,
          padding: "11px 12px",
        }}
      >
        <span className="mono" style={{ fontWeight: 600, fontSize: 11, color: "var(--muted)" }}>
          {t.id}
        </span>
        <div style={{ fontSize: 12, margin: "7px 0", lineHeight: 1.35 }}>{t.title}</div>
        <div className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
          espera {t.deps.join(", ") || "—"}
        </div>
      </div>
    );
  }

  const blocked = t.status === "blocked";
  const done = t.status === "done";
  const tone = blocked ? "var(--warn)" : done ? "var(--done)" : "var(--doing)";

  return (
    <button
      onClick={() => onFocus(t.id)}
      style={{
        background: "var(--panel)",
        border: `1px solid ${blocked ? "rgba(240,176,78,.55)" : done ? "rgba(83,208,138,.35)" : "rgba(90,167,240,.45)"}`,
        borderRadius: 8,
        padding: "11px 12px",
        textAlign: "left",
        outline: focused ? "2px solid var(--doing)" : undefined,
        outlineOffset: 1,
        boxShadow: blocked ? "0 0 18px rgba(240,176,78,.12)" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono" style={{ fontWeight: 600, fontSize: 11, color: tone }}>
          {t.id}
        </span>
        {t.agentCli ? <Avatar cli={t.agentCli} size={16} /> : null}
        <div className="grow" />
        {blocked ? (
          <span className="mono pulse" style={{ fontWeight: 600, fontSize: 9, color: "var(--warn)" }}>
            ⚠ REVIEW
          </span>
        ) : (
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
            {t.elapsedMs !== undefined ? elapsed(now - t.elapsedMs, now) : ""}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, fontWeight: 500, margin: "7px 0", lineHeight: 1.35 }}>{t.title}</div>
      <Gates gates={t.gates} status={t.status} />
      <div className="mono" style={{ fontSize: 10, color: blocked ? "var(--warn)" : "var(--muted)", marginTop: 6 }}>
        {statusLine(t)}
      </div>
    </button>
  );
}

function Gates({ gates, status }: { gates: TaskView["gates"]; status: TaskView["status"] }): ReactNode {
  const value = (v: boolean | undefined, active: boolean): string =>
    v === true ? "var(--done)" : v === false ? "var(--bad)" : active ? "var(--doing)" : "var(--chip)";
  const done = status === "done";
  return (
    <div style={{ display: "flex", gap: 3 }}>
      <span style={{ flex: 1, height: 3, borderRadius: 2, background: done ? "var(--done)" : value(gates?.exec, true) }} />
      <span style={{ flex: 1, height: 3, borderRadius: 2, background: done ? "var(--done)" : value(gates?.tests, false) }} />
      <span
        style={{
          flex: 1,
          height: 3,
          borderRadius: 2,
          background: done ? "var(--done)" : status === "blocked" ? "var(--warn)" : value(gates?.review, false),
        }}
      />
    </div>
  );
}

function statusLine(t: TaskView): string {
  if (t.status === "blocked") return t.reason || "aguarda você";
  if (t.status === "done") return "mergeada no trunk";
  const parts: string[] = [];
  if (t.subphase) parts.push(`${t.subphase} ●`);
  if (t.round) parts.push(`rodada ${t.round.n}/${t.round.max}`);
  if (t.retries > 0) parts.push(`retries ${t.retries}`);
  return parts.join(" · ") || "aguardando";
}

function Timeline({ events }: { events: TimelineEvent[] }): ReactNode {
  if (events.length === 0) return null;
  const first = events[0].at;
  const span = Math.max(1, Date.now() - first);
  const color: Record<TimelineEvent["kind"], string> = {
    start: "var(--done)",
    pass: "var(--done)",
    done: "var(--done)",
    merge: "var(--teal)",
    fail: "var(--bad)",
    blocked: "var(--warn)",
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line-soft)" }}>
      <Kicker>TIMELINE</Kicker>
      <div style={{ position: "relative", height: 26, marginTop: 8 }}>
        <span style={{ position: "absolute", left: 0, right: 0, top: 12, height: 2, background: "var(--chip)" }} />
        {events.map((e, i) => (
          <span
            key={i}
            title={e.label}
            style={{
              position: "absolute",
              left: `${Math.min(96, ((e.at - first) / span) * 100)}%`,
              top: 8,
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: color[e.kind],
              border: "2px solid var(--card)",
            }}
          />
        ))}
        <span
          className="pulse"
          style={{
            position: "absolute",
            left: "97%",
            top: 6,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "var(--doing)",
            border: "2px solid var(--card)",
          }}
        />
      </div>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--dim)" }}>
        {events.slice(-4).map((e, i) => (
          <span key={i}>{e.label}</span>
        ))}
        <span>agora</span>
      </div>
    </div>
  );
}

/** The stream key the supervisor files run-level lines under. */
/** The run's own stream — "" because no task id can be empty. */
export const RUN_LOG = "";

function Stream({
  runId,
  taskId,
  executor,
  task,
  onSelect,
}: {
  runId: string;
  taskId: string | null;
  executor: string;
  task: TaskView | null;
  onSelect: (id: string | null) => void;
}): ReactNode {
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // `=== null`, not falsy: "" IS a stream key — the run's own log
    if (taskId === null) {
      setLines([]);
      return;
    }
    let live = true;
    void rpc.request.getStream({ runId, taskId }).then((l) => {
      if (live) setLines(l);
    });
    const off = onStream((r, t, line) => {
      if (r === runId && t === taskId) setLines((prev) => [...prev.slice(-799), line]);
    });
    return () => {
      live = false;
      off();
    };
  }, [runId, taskId]);

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, follow]);

  return (
    <div style={{ display: "flex", flexDirection: "column", background: "var(--deep)", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
        <span className="mono" style={{ fontWeight: 600, fontSize: 11, color: "var(--doing)" }}>
          {taskId === RUN_LOG ? "run" : (taskId ?? "—")}
        </span>
        <span className="mono" style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {taskId === RUN_LOG ? "preflight, waves, encerramento" : executor}
        </span>
        <div className="grow" />
        {/* Startup, preflight and the run's own errors are filed under this
            pseudo-task; without a way to select it those diagnostics — the ones
            that explain a run that never got going — are unreachable. */}
        <button
          className="mono"
          style={{ fontSize: 10, color: taskId === RUN_LOG ? "var(--doing)" : "var(--dim)" }}
          onClick={() => onSelect(taskId === RUN_LOG ? null : RUN_LOG)}
        >
          log da run
        </button>
        <button className="mono" style={{ fontSize: 10, color: follow ? "var(--doing)" : "var(--dim)" }} onClick={() => setFollow((v) => !v)}>
          seguir ⏷
        </button>
      </div>

      <div
        ref={boxRef}
        className="mono"
        style={{ flex: 1, overflow: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, fontSize: 11.5, lineHeight: 1.55 }}
      >
        {lines.length === 0 ? (
          <span style={{ color: "var(--dim)" }}>sem output ainda</span>
        ) : (
          lines.map((l, i) => <Line key={i} line={l} />)
        )}
      </div>

      <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--line)" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
          {task
            ? `rodada ${task.round?.n ?? 1} · exec_ok=${fmt(task.gates?.exec)} tests_ok=${fmt(task.gates?.tests)} approved=${fmt(task.gates?.review)}`
            : taskId === RUN_LOG
              ? "log da run — preflight, waves, encerramento"
              : "nenhuma task em foco"}
        </span>
      </div>
    </div>
  );
}

function fmt(v: boolean | undefined): string {
  return v === undefined ? "—" : String(v);
}

function Line({ line }: { line: StreamLine }): ReactNode {
  if (line.source === "advisor") {
    return (
      <div
        style={{
          background: "rgba(240,138,99,.06)",
          borderLeft: "2px solid #f08a63",
          padding: "7px 10px",
          borderRadius: "0 5px 5px 0",
          color: "var(--soft)",
        }}
      >
        <span style={{ color: "#f08a63", fontWeight: 600 }}>advisor</span> — {line.text}
      </div>
    );
  }
  if (line.source === "review") {
    return (
      <div
        style={{
          background: "rgba(240,176,78,.06)",
          borderLeft: "2px solid var(--warn)",
          padding: "7px 10px",
          borderRadius: "0 5px 5px 0",
          color: "var(--soft)",
        }}
      >
        <span style={{ color: "var(--warn)", fontWeight: 600 }}>review</span> — {line.text}
      </div>
    );
  }
  if (line.source === "system") {
    return (
      <div style={{ background: "var(--panel)", borderLeft: "2px solid var(--teal)", padding: "7px 10px", borderRadius: "0 5px 5px 0", color: "var(--muted)" }}>
        {line.text}
      </div>
    );
  }
  const failed = /error|failed|✗|falhou/i.test(line.text);
  return (
    <div
      style={
        failed
          ? {
              background: "rgba(238,106,95,.07)",
              border: "1px solid rgba(238,106,95,.3)",
              padding: "8px 10px",
              borderRadius: 6,
              color: "var(--muted)",
            }
          : { color: "var(--soft)" }
      }
    >
      {line.text}
    </div>
  );
}
