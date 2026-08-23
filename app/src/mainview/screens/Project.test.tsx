// Project.test.tsx — 4b. A PRD is drafting, running, or history, and the card
// has to make that obvious at a glance: a running PRD gets a badge and a way
// in, a drafting one gets the studio and a build button the validator can veto.
// Worktrees on/off lives in the header because it decides whether a second run
// can start at all. api.ts is mocked WHOLE (importing it builds an Electroview).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

const requests = {
  getProject: vi.fn(),
  projectSettings: vi.fn(),
  startRun: vi.fn(),
};

vi.mock("../api.ts", () => ({
  rpc: { request: requests, send: {} },
  // act() is how a screen fires a request the user asked for: it awaits and
  // reports a failure to the shell. Under test the reporting has no shell, so
  // the stub keeps only the awaiting half.
  act: <T,>(work: Promise<T>, then?: (v: T) => void) => void work.then(then).catch(() => {}),

  onStream: () => () => {},
  onChunk: () => () => {},
  useQuery: <T,>(fetcher: () => Promise<T>) => {
    const [data, setData] = useState<T | null>(null);
    useEffect(() => {
      void fetcher().then(setData);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return { data, error: null, reload: () => {} };
  },
}));

const { Project } = await import("./Project.tsx");
const { prd, project, projectSettings, run } = await import("../testing.tsx");

beforeEach(() => {
  vi.clearAllMocks();
  requests.projectSettings.mockResolvedValue(projectSettings());
});

describe("Project", () => {
  it("shows the run badge and a way into the run when a PRD is building", async () => {
    requests.getProject.mockResolvedValue({
      project: project({ runs: [run()] }),
      prds: [prd({ runId: "run-1" })],
      history: [],
    });
    render(<Project id="p1" nav={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("RODANDO · WAVE 2/5")).toBeTruthy());
    expect(screen.getByText("abrir run →")).toBeTruthy();
    // a running PRD is not editable from here — the studio door is closed
    expect(screen.queryByText("studio ✎")).toBeNull();
  });

  it("offers studio and construir while a PRD has no run", async () => {
    requests.getProject.mockResolvedValue({ project: project(), prds: [prd()], history: [] });
    render(<Project id="p1" nav={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("construir ▶")).toBeTruthy());
    expect(screen.getByText("studio ✎")).toBeTruthy();
    expect(screen.getByText("PRONTO")).toBeTruthy();
    expect((screen.getByText("construir ▶") as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses to build a PRD whose deps do not validate", async () => {
    requests.getProject.mockResolvedValue({
      project: project(),
      prds: [prd({ depsOk: false, depErrors: ["t3 depende de t9 inexistente"] })],
      history: [],
    });
    render(<Project id="p1" nav={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("construir ▶")).toBeTruthy());
    const build = screen.getByText("construir ▶") as HTMLButtonElement;
    expect(build.disabled).toBe(true);
    // the errors are the tooltip, so the reason is one hover away
    expect(build.title).toBe("t3 depende de t9 inexistente");
    expect(screen.getByText("RASCUNHO")).toBeTruthy();
    expect(screen.getByText("1 problema(s) de validação")).toBeTruthy();
  });

  it("reads worktrees ON from the project settings", async () => {
    requests.getProject.mockResolvedValue({ project: project(), prds: [], history: [] });
    render(<Project id="p1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/worktree ON — runs em paralelo/)).toBeTruthy());
  });

  it("falls back to the queue wording when worktrees are off", async () => {
    requests.projectSettings.mockResolvedValue(projectSettings({ worktreePerTask: false }));
    requests.getProject.mockResolvedValue({ project: project(), prds: [], history: [] });
    render(<Project id="p1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/worktree OFF — uma run por vez \(fila\)/)).toBeTruthy());
  });
});
