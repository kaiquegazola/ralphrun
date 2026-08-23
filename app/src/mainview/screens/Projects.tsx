// Projects.tsx — 4a. A project is a FOLDER: an existing repo, an empty
// directory the app initialises, or one registered from a terminal. The three
// doors are shown together because which one applies is obvious to the user and
// not to us.

import { useState, type ReactNode } from "react";

import { act, rpc, useQuery } from "../api.ts";
import type { Nav } from "../app.tsx";
import type { NewProjectProbe, ProjectView } from "../../shared/types.ts";
import { Chip, Empty, Kicker } from "../ui.tsx";

export function Projects({ nav }: { nav: Nav }): ReactNode {
  const { data, reload } = useQuery(() => rpc.request.listProjects({}), ["runs", "projects"]);
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 20px 0" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Projetos</span>
        <div className="grow" />
        <button className="btn primary" onClick={() => setCreating((v) => !v)}>
          + Novo projeto
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 20px" }}>
        {data === null ? (
          <Empty>carregando…</Empty>
        ) : data.length === 0 ? (
          <Empty>nenhum projeto ainda — aponte para uma pasta abaixo</Empty>
        ) : (
          data.map((p) => <ProjectRow key={p.id} p={p} nav={nav} onForget={reload} />)
        )}
      </div>

      {creating || (data && data.length === 0) ? (
        <NewProject
          onCreated={(id) => {
            setCreating(false);
            reload();
            nav({ t: "project", id });
          }}
        />
      ) : null}
    </div>
  );
}

function ProjectRow({ p, nav, onForget }: { p: ProjectView; nav: Nav; onForget: () => void }): ReactNode {
  const initials = p.name.slice(0, 2).toLowerCase();
  const attention = p.runs.filter((r) => r.status === "attention").length;
  const running = p.runs.filter((r) => r.status === "running").length;

  return (
    <div
      className="card clickable"
      style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 16px" }}
      onClick={() => nav({ t: "project", id: p.id })}
    >
      <span
        className="avatar"
        style={{ width: 36, height: 36, borderRadius: 9, background: "var(--sel-blue)", color: "var(--doing)", fontSize: 13 }}
      >
        {initials}
      </span>
      <div style={{ minWidth: 250 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{p.name}</div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--dim)" }}>
          {p.shortDir} · {p.git ? `git · ${p.branch ?? "—"}` : "pasta sem git"}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {attention > 0 ? (
          <Chip color="#f0b04e" tint>
            {attention} run ⚠ attention
          </Chip>
        ) : null}
        {running > 0 ? (
          <Chip color="#5aa7f0" tint>
            {running} run ● ativa
          </Chip>
        ) : null}
        {p.draftCount > 0 ? (
          <Chip color="#a98cf5" tint>
            {p.draftCount} PRD em rascunho
          </Chip>
        ) : null}
      </div>
      <div className="grow" />
      <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
        {p.prdCount} {p.prdCount === 1 ? "PRD" : "PRDs"}
      </span>
      <button
        className="btn quiet"
        title="remover da lista (não apaga nada no disco)"
        onClick={(e) => {
          e.stopPropagation();
          act(rpc.request.forgetProject({ id: p.id }), onForget);
        }}
      >
        ✕
      </button>
      <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
        ›
      </span>
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: (id: string) => void }): ReactNode {
  const [probe, setProbe] = useState<NewProjectProbe | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (): Promise<void> => {
    const { dir } = await rpc.request.pickDirectory({});
    if (!dir) return;
    setProbe(await rpc.request.probeDir({ dir }));
  };

  const create = (): void => {
    if (!probe) return;
    setBusy(true);
    // `git init` can refuse (no git, unwritable folder); the panel has to
    // report that instead of leaving a button that did nothing
    act(rpc.request.createProject({ dir: probe.dir, init: !probe.git }), ({ id }) => onCreated(id));
    setBusy(false);
  };

  return (
    <div
      style={{
        margin: "0 20px 18px",
        background: "#151a23",
        border: "1px solid rgba(90,167,240,.4)",
        borderRadius: 10,
        padding: "14px 16px",
      }}
    >
      <Kicker color="var(--doing)">NOVO PROJETO</Kicker>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
        <button
          onClick={() => void pick()}
          style={{
            background: "var(--inset)",
            border: "1px solid rgba(90,167,240,.5)",
            borderRadius: 8,
            padding: "11px 13px",
            textAlign: "left",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>📁 Pasta existente</div>
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
            aponta pra um repo git (ou qualquer pasta) — o ralphrun detecta trunk, package manager e scripts
          </div>
          <div className="mono field" style={{ marginTop: 8, fontSize: 10.5 }}>
            {probe?.dir ?? "~/dev/meu-repo"} <span style={{ color: "var(--dim)" }}>— procurar…</span>
          </div>
        </button>

        <button
          onClick={() => void pick()}
          style={{
            background: "var(--inset)",
            border: "1px solid rgba(255,255,255,.1)",
            borderRadius: 8,
            padding: "11px 13px",
            textAlign: "left",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3, color: "var(--soft)" }}>✦ Pasta vazia</div>
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
            começa do zero — o ralphrun roda git init e o primeiro PRD define o scaffold
          </div>
          <div
            className="mono"
            style={{
              marginTop: 8,
              fontSize: 10.5,
              color: "var(--dim)",
              background: "var(--deep)",
              border: "1px dashed rgba(255,255,255,.12)",
              borderRadius: 5,
              padding: "5px 9px",
            }}
          >
            ~/dev/nome-do-projeto
          </div>
        </button>

        <div
          style={{
            background: "var(--inset)",
            border: "1px solid rgba(255,255,255,.1)",
            borderRadius: 8,
            padding: "11px 13px",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3, color: "var(--soft)" }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--done)" }}>
              $
            </span>{" "}
            Pelo terminal
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
            de dentro da pasta, um comando registra o projeto — ele aparece aqui na hora
          </div>
          <button
            className="mono field"
            style={{ marginTop: 8, fontSize: 10.5, display: "flex", alignItems: "center", gap: 8, width: "100%" }}
            onClick={() => void navigator.clipboard.writeText("ralphrun create .")}
          >
            <span style={{ color: "var(--done)" }}>$</span> ralphrun create .
            <span className="grow" />
            <span style={{ color: "var(--dim)" }}>copiar ⧉</span>
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <span className="mono" style={{ fontSize: 10, color: probe ? "var(--done)" : "var(--dim)" }}>
          {probe
            ? `✓ git ${probe.gitVersion ?? "?"} · ${probe.packageManager ?? "sem package manager"} · ${
                probe.worktreesSupported ? "worktrees suportadas" : "worktrees indisponíveis"
              }${probe.git ? "" : " · git init será executado"}`
            : "escolha uma pasta para conferir git, package manager e suporte a worktrees"}
        </span>
        <div className="grow" />
        <button className="btn primary" disabled={!probe || busy} onClick={create}>
          criar projeto
        </button>
      </div>
    </div>
  );
}
