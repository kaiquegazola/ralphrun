// Settings.tsx — 3a + 3b. Two scopes in one nav: the project's own knobs on
// top, ralphrun's globals below. The distinction is not cosmetic — the project
// values are written to a ralph.config.json the CLI reads too, so a change here
// is a change to every future run of that repo.

import { useEffect, useState, type ReactNode } from "react";

import { act, rpc, useQuery } from "../api.ts";
import type { Nav } from "../app.tsx";
import type { GlobalSettingsView, ProjectSettingsView } from "../../shared/types.ts";
import { applyTheme } from "../theme.ts";
import { Empty, InheritBadge, Kicker, Seg, SettingRow, Toggle } from "../ui.tsx";
import { PairPicker } from "./Workforce.tsx";

type Section = "geral" | "par" | "verify" | "git" | "clis" | "limites" | "notif" | "aparencia";

export function Settings({ projectId, nav }: { projectId?: string; nav: Nav }): ReactNode {
  const projects = useQuery(() => rpc.request.listProjects({}), []);
  const active = projectId ?? projects.data?.[0]?.id;
  const [section, setSection] = useState<Section>(active ? "geral" : "limites");

  const projectName = projects.data?.find((p) => p.id === active)?.name ?? "—";

  return (
    <div>
      <div className="topbar">
        <span className="brand">
          ralph<b>run</b>
        </span>
        <span className="crumb">/ configurações</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "230px 1fr", minHeight: 520 }}>
        <div
          style={{
            borderRight: "1px solid var(--line)",
            background: "var(--chrome)",
            padding: "14px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div className="kicker" style={{ fontSize: 9, padding: "4px 10px 6px" }}>
            PROJETO · {projectName.toUpperCase()}
          </div>
          <NavItem icon="⚙" label="Geral" on={section === "geral"} disabled={!active} onClick={() => setSection("geral")} />
          <NavItem icon="⇄" label="Par executor/advisor" on={section === "par"} disabled={!active} onClick={() => setSection("par")} />
          <NavItem icon="✓" label="Verify & review" on={section === "verify"} disabled={!active} onClick={() => setSection("verify")} />
          <NavItem icon="⌥" label="Git & worktrees" on={section === "git"} disabled={!active} onClick={() => setSection("git")} />

          <div className="kicker" style={{ fontSize: 9, padding: "16px 10px 6px" }}>
            RALPHRUN · GLOBAL
          </div>
          <NavItem icon="cl" label="CLIs & agentes" on={section === "clis"} onClick={() => setSection("clis")} />
          <NavItem icon="◔" label="Limites & paralelismo" on={section === "limites"} onClick={() => setSection("limites")} />
          <NavItem icon="◉" label="Notificações" on={section === "notif"} onClick={() => setSection("notif")} />
          <NavItem icon="✦" label="Aparência" on={section === "aparencia"} onClick={() => setSection("aparencia")} />

          <div className="mono" style={{ marginTop: "auto", padding: "8px 10px", fontSize: 9.5, lineHeight: 1.6, color: "var(--dim)" }}>
            config do projeto vive em
            <br />
            ralph.config.json ↗
          </div>
        </div>

        <div style={{ padding: "20px 24px" }}>
          {section === "clis" ? (
            <div>
              <Kicker>CLIS & AGENTES</Kicker>
              <p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
                o roster completo, com preflight contínuo e o par por projeto, mora na tela Workforce.
              </p>
              <button className="btn primary" onClick={() => nav({ t: "workforce" })}>
                abrir Workforce
              </button>
            </div>
          ) : section === "limites" || section === "notif" || section === "aparencia" ? (
            <GlobalPanel section={section} />
          ) : active ? (
            <ProjectPanel projectId={active} section={section} name={projectName} />
          ) : (
            <Empty>nenhum projeto selecionado</Empty>
          )}
        </div>
      </div>
    </div>
  );
}

function NavItem({
  icon,
  label,
  on,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "7px 10px",
        borderRadius: 6,
        fontSize: 12.5,
        textAlign: "left",
        background: on ? "var(--sel-blue)" : "transparent",
        fontWeight: on ? 600 : 400,
        color: disabled ? "var(--dim)" : on ? "var(--text)" : "var(--muted)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span className="mono" style={{ fontSize: 11, color: on ? "var(--doing)" : undefined }}>
        {icon}
      </span>
      {label}
    </button>
  );
}

function ProjectPanel({ projectId, section, name }: { projectId: string; section: Section; name: string }): ReactNode {
  const [s, setS] = useState<ProjectSettingsView | null>(null);
  // WHICH fields changed, not just "something did". Sending the whole view as
  // the patch would write every inherited value into ralph.config.json and
  // freeze this project out of later global changes.
  const [changed, setChanged] = useState<Partial<ProjectSettingsView>>({});
  const dirty = Object.keys(changed).length > 0;
  const wf = useQuery(() => rpc.request.workforce({}), ["workforce"]);

  useEffect(() => {
    setChanged({});
    void rpc.request.projectSettings({ projectId }).then(setS);
  }, [projectId]);

  if (!s) return <Empty>carregando…</Empty>;
  const patch = (p: Partial<ProjectSettingsView>): void => {
    setS({ ...s, ...p });
    setChanged((prev) => ({ ...prev, ...p }));
  };
  const save = (): void => {
    // a checkout git refused, or a live run in the way — the screen has to say
    // so instead of looking like it saved
    act(rpc.request.saveProjectSettings({ projectId, patch: changed }), () => {
      void rpc.request.projectSettings({ projectId }).then(setS);
      setChanged({});
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title(section)} — {name}</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 3 }}>
          valores do projeto sobrepõem o global · <span className="mono" style={{ fontSize: 10.5 }}>herda ⌂</span> marca
          herança
        </div>
      </div>

      {section === "geral" ? (
        <div className="rowsheet">
          <SettingRow label="Diretório do repositório" hint="raiz onde as worktrees nascem">
            <span className="mono field">{s.dir}</span>
          </SettingRow>
          <SettingRow label="Branch trunk" hint="destino dos cherry-picks por task">
            <select className="mono field" value={s.branch ?? ""} onChange={(e) => patch({ branch: e.target.value })}>
              {s.branches.length === 0 ? <option value="">—</option> : null}
              {s.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="Paralelismo máximo"
            hint={
              s.worktreePerTask
                ? "tasks simultâneas nesta run"
                : "requer worktree por task — sem isolamento, o loop recusa mais de 1"
            }
            badge={<InheritBadge value={s.inheritedParallel} />}
          >
            <Seg
              value={s.maxParallel}
              options={[1, 2, 3, 4, 6].map((v) => ({ value: v }))}
              onChange={(v) => patch({ maxParallel: s.worktreePerTask ? v : 1 })}
            />
          </SettingRow>
          <SettingRow label="Retries por task antes de escalar" hint="depois disso vira decisão humana (inbox)" badge={<InheritBadge value={s.inheritedRetries} />}>
            <Seg value={s.maxRetries} options={[1, 2, 3, 5].map((v) => ({ value: v }))} onChange={(v) => patch({ maxRetries: v })} />
          </SettingRow>
        </div>
      ) : null}

      {section === "par" ? (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>executor</div>
          <PairPicker
            spec={s.executor}
            agents={(wf.data?.agents ?? []).filter((a) => a.installed && a.loggedIn)}
            onChange={(spec) => spec && patch({ executor: spec })}
          />
          <div className="mono" style={{ textAlign: "center", margin: "8px 0", fontSize: 10, color: "var(--dim)" }}>
            {s.advisor
              ? s.advisor.cli !== s.executor.cli
                ? "× família diferente — CROSS"
                : "mesma cli — NATIVE"
              : "sem advisor"}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
            advisor <span style={{ color: "var(--dim)" }}>(pode desligar)</span>
          </div>
          <PairPicker
            spec={s.advisor}
            agents={(wf.data?.agents ?? []).filter((a) => a.installed && a.loggedIn)}
            allowNone
            onChange={(spec) => patch({ advisor: spec })}
          />
        </div>
      ) : null}

      {section === "verify" ? (
        <div className="rowsheet">
          <SettingRow label="Review depois do exec" hint="segundo agente revisando cada task antes do commit">
            <Toggle on={s.reviewAfter} onChange={(v) => patch({ reviewAfter: v })} />
          </SettingRow>
          <SettingRow
            label="Aceitar review bloqueado quando os testes passam"
            hint="desligado = toda recusa do reviewer vira decisão sua no inbox"
          >
            <Toggle
              on={s.reviewBlockedPolicy === "accept"}
              onChange={(v) => patch({ reviewBlockedPolicy: v ? "accept" : "block" })}
            />
          </SettingRow>
          <SettingRow
            label="Commit por task"
            hint={
              s.worktreePerTask
                ? "obrigatório com worktree por task — o commit é como o trabalho sai da mesa"
                : "cada task aprovada vira um commit no trunk"
            }
          >
            <Toggle
              on={s.commitPerTask || s.worktreePerTask}
              onChange={(v) => !s.worktreePerTask && patch({ commitPerTask: v })}
            />
          </SettingRow>
        </div>
      ) : null}

      {section === "git" ? (
        <div className="rowsheet">
          <SettingRow
            label="Worktree por task"
            hint={
              s.worktreesSupported
                ? "cada task doing ganha um checkout isolado; ao aprovar, volta por cherry-pick"
                : "o git desta máquina é anterior ao 2.5 e não tem "
            }
          >
            <Toggle
              on={s.worktreePerTask && s.worktreesSupported}
              onChange={(v) =>
                s.worktreesSupported &&
                patch({
                  worktreePerTask: v,
                  maxParallel: v ? s.maxParallel : 1,
                  // turning worktrees ON forces commits on: the core refuses
                  // the other combination outright
                  commitPerTask: v ? true : s.commitPerTask,
                })
              }
            />
          </SettingRow>
          <SettingRow label="Arquivo de configuração" hint="o mesmo que a CLI lê">
            <button className="mono field" onClick={() => void rpc.request.openPath({ path: s.configPath })}>
              {s.configPath} ↗
            </button>
          </SettingRow>
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
          alterações valem para a PRÓXIMA run — uma run já em andamento leu o config quando começou
        </span>
        <div className="grow" />
        <button
          className="btn quiet"
          disabled={!dirty}
          onClick={() =>
            void rpc.request.projectSettings({ projectId }).then((v) => {
              setS(v);
              setChanged({});
            })
          }
        >
          descartar
        </button>
        <button className="btn primary" disabled={!dirty} onClick={save}>
          salvar
        </button>
      </div>
    </div>
  );
}

function title(section: Section): string {
  switch (section) {
    case "geral":
      return "Geral";
    case "par":
      return "Par executor/advisor";
    case "verify":
      return "Verify & review";
    case "git":
      return "Git & worktrees";
    default:
      return "";
  }
}

function GlobalPanel({ section }: { section: Section }): ReactNode {
  const [g, setG] = useState<GlobalSettingsView | null>(null);

  useEffect(() => {
    void rpc.request.globalSettings({}).then(setG);
  }, []);
  if (!g) return <Empty>carregando…</Empty>;

  // saved on change: these are single-value preferences with no cross-field
  // invariant, so a save button would be one extra click for nothing.
  const patch = (p: Partial<GlobalSettingsView>): void => {
    const next = { ...g, ...p };
    setG(next);
    if (p.theme) applyTheme(p.theme);
    // through act(): an unwritable config dir would otherwise leave the toggle
    // looking saved and the preference gone on the next start
    act(rpc.request.saveGlobalSettings({ patch: p }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {section === "limites" ? (
        <>
          <Kicker>LIMITES & PARALELISMO</Kicker>
          <div className="rowsheet">
            <SettingRow label="Timeout de stall" hint="sem output → vira decisão no inbox">
              <Seg
                value={g.stallMinutes}
                options={[
                  { value: 5, label: "5m" },
                  { value: 10, label: "10m" },
                  { value: 20, label: "20m" },
                  { value: 0, label: "∞" },
                ]}
                onChange={(v) => patch({ stallMinutes: v })}
              />
            </SettingRow>
            <SettingRow label="Runs simultâneas (máquina)" hint="acima disso, novas runs entram em fila">
              <Seg value={g.maxConcurrentRuns} options={[1, 2, 4].map((v) => ({ value: v }))} onChange={(v) => patch({ maxConcurrentRuns: v })} />
            </SettingRow>
          </div>
        </>
      ) : null}

      {section === "notif" ? (
        <>
          <Kicker>NOTIFICAÇÕES</Kicker>
          <div className="rowsheet">
            <SettingRow label="Decisão pendente (review bloqueado, stall)">
              <NotifySeg value={g.notifyDecision} onChange={(v) => patch({ notifyDecision: v })} />
            </SettingRow>
            <SettingRow label="Task mergeada no trunk">
              <NotifySeg value={g.notifyMerge} onChange={(v) => patch({ notifyMerge: v })} />
            </SettingRow>
            <SettingRow label="Run terminou (sucesso ou não)">
              <NotifySeg value={g.notifyRunEnd} onChange={(v) => patch({ notifyRunEnd: v })} />
            </SettingRow>
          </div>
        </>
      ) : null}

      {section === "aparencia" ? (
        <>
          <Kicker>APARÊNCIA</Kicker>
          <div className="rowsheet">
            <SettingRow label="Idioma" hint="usado também pela CLI">
              <Seg
                value={g.language}
                options={[
                  { value: "pt-br" as const, label: "pt-BR" },
                  { value: "en" as const, label: "en" },
                ]}
                onChange={(v) => patch({ language: v })}
              />
            </SettingRow>
            <SettingRow label="Tema">
              <Seg
                value={g.theme}
                options={[
                  { value: "dark" as const, label: "escuro" },
                  { value: "light" as const, label: "claro" },
                  { value: "system" as const, label: "sistema" },
                ]}
                onChange={(v) => patch({ theme: v })}
              />
            </SettingRow>
            <SettingRow label="Modo padrão do run detail" hint="calmo esconde streams até você pedir">
              <Seg
                value={g.runDetailMode}
                options={[
                  { value: "calm" as const, label: "calmo" },
                  { value: "surgical" as const, label: "cirúrgico" },
                ]}
                onChange={(v) => patch({ runDetailMode: v })}
              />
            </SettingRow>
          </div>
        </>
      ) : null}
    </div>
  );
}

function NotifySeg({
  value,
  onChange,
}: {
  value: "silent" | "system" | "sound";
  onChange: (v: "silent" | "system" | "sound") => void;
}): ReactNode {
  return (
    <Seg
      value={value}
      options={[
        { value: "silent" as const, label: "silencioso" },
        { value: "system" as const, label: "sistema" },
        { value: "sound" as const, label: "som" },
      ]}
      onChange={onChange}
    />
  );
}
