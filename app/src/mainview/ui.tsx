// ui.tsx — the pieces the mockups repeat. Everything here is presentational;
// no screen reaches past it into raw styling for these shapes.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { agentColor, agentInitials } from "../shared/identity.ts";
import type { RunStatus, TaskStatus } from "../shared/types.ts";

export const STATUS_COLOR: Record<TaskStatus, string> = {
  done: "var(--done)",
  doing: "var(--doing)",
  todo: "var(--dim)",
  blocked: "var(--bad)",
};

export function Avatar({ cli, size = 24 }: { cli: string; size?: number }): ReactNode {
  const color = agentColor(cli);
  return (
    <span
      className="avatar"
      title={cli}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        background: `${color}33`,
        color,
        fontSize: Math.max(8, Math.round(size * 0.42)),
        fontFamily: "var(--mono)",
        fontWeight: 600,
      }}
    >
      {agentInitials(cli)}
    </span>
  );
}

/** The multi-segment run bar: done ▸ doing ▸ blocked, over the whole backlog. */
export function ProgressBar({
  done,
  doing,
  blocked,
  total,
  height = 5,
}: {
  done: number;
  doing: number;
  blocked: number;
  total: number;
  height?: number;
}): ReactNode {
  const pct = (n: number) => (total > 0 ? `${(n / total) * 100}%` : "0%");
  return (
    <div className="bar" style={{ height }}>
      <span style={{ width: pct(done), background: "var(--done)" }} />
      <span className={doing > 0 ? "pulse" : undefined} style={{ width: pct(doing), background: "var(--doing)" }} />
      <span style={{ width: pct(blocked), background: "var(--warn)" }} />
    </div>
  );
}

export function Kicker({ children, color }: { children: ReactNode; color?: string }): ReactNode {
  return (
    <div className="kicker" style={color ? { color } : undefined}>
      {children}
    </div>
  );
}

export function Chip({
  children,
  color,
  tint,
  style,
}: {
  children: ReactNode;
  color?: string;
  tint?: boolean;
  style?: CSSProperties;
}): ReactNode {
  return (
    <span
      className="chip"
      style={{
        ...(color ? { color, background: tint ? `${color}22` : undefined, border: tint ? `1px solid ${color}59` : undefined } : {}),
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): ReactNode {
  return (
    <button className={`toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} aria-pressed={on}>
      <i />
    </button>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label?: string }[];
  onChange: (v: T) => void;
}): ReactNode {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label ?? String(o.value)}
        </button>
      ))}
    </div>
  );
}

export function SettingRow({
  label,
  hint,
  badge,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="settingrow">
      <div style={{ flex: 1 }}>
        <div className="label">
          {label}
          {badge}
        </div>
        {hint ? <div className="hint">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function InheritBadge({ value }: { value: number | string }): ReactNode {
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        color: "var(--dim)",
        border: "1px dashed var(--line-hard)",
        borderRadius: 4,
        padding: "1px 6px",
        marginLeft: 6,
      }}
    >
      herda ⌂ {value}
    </span>
  );
}

const RUN_TONE: Record<RunStatus, { color: string; label: string }> = {
  queued: { color: "var(--dim)", label: "NA FILA" },
  running: { color: "var(--doing)", label: "RODANDO" },
  attention: { color: "var(--warn)", label: "ATTENTION" },
  paused: { color: "var(--dim)", label: "PAUSADA" },
  done: { color: "var(--done)", label: "CONCLUÍDA" },
  failed: { color: "var(--bad)", label: "ABORTADA" },
};

export function RunBadge({ status, suffix }: { status: RunStatus; suffix?: string }): ReactNode {
  const tone = RUN_TONE[status];
  return (
    <span
      className="mono"
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 12,
        background: `${tone.color.startsWith("var") ? "rgba(255,255,255,.08)" : tone.color}`,
        color: tone.color,
        whiteSpace: "nowrap",
      }}
    >
      {tone.label}
      {suffix ? ` · ${suffix}` : ""}
    </span>
  );
}

export function elapsed(fromMs: number, toMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

export function ago(at: number): string {
  const min = Math.floor((Date.now() - at) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="empty">{children}</div>;
}

/**
 * A clock that ticks the component. Elapsed times are the only thing on these
 * screens that changes with no event behind it, so this is the one interval in
 * the app — everything else is pushed.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return now;
}
