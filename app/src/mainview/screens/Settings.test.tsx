// Settings.test.tsx — 3a + 3b. Two scopes with two different save contracts:
// the project panel batches into an explicit save (it writes the
// ralph.config.json the CLI also reads), the global panel commits on change.
// api.ts is mocked WHOLE because importing it constructs an Electroview.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

const requests = {
  listProjects: vi.fn(),
  workforce: vi.fn(),
  projectSettings: vi.fn(),
  saveProjectSettings: vi.fn(),
  globalSettings: vi.fn(),
  saveGlobalSettings: vi.fn(),
  openPath: vi.fn(),
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

const { Settings } = await import("./Settings.tsx");
const { globalSettings, project, projectSettings, workforce } = await import("../testing.tsx");

const saveButton = (): HTMLButtonElement => screen.getByText("salvar") as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  requests.listProjects.mockResolvedValue([project()]);
  requests.workforce.mockResolvedValue(workforce());
  requests.projectSettings.mockResolvedValue(projectSettings());
  requests.saveProjectSettings.mockResolvedValue(undefined);
  requests.globalSettings.mockResolvedValue(globalSettings());
  requests.saveGlobalSettings.mockResolvedValue(undefined);
});

describe("Settings", () => {
  it("splits the nav into the project's scope and ralphrun's own", async () => {
    render(<Settings projectId="p1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/PROJETO · QC-COLOMBIA/)).toBeTruthy());
    expect(screen.getByText(/RALPHRUN · GLOBAL/)).toBeTruthy();
    expect(screen.getByText("Git & worktrees")).toBeTruthy();
    expect(screen.getByText("Notificações")).toBeTruthy();
  });

  it("keeps salvar shut until something actually changed", async () => {
    render(<Settings projectId="p1" nav={vi.fn()} />);
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect((screen.getByText("descartar") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText("4")); // paralelismo máximo 3 → 4
    expect(saveButton().disabled).toBe(false);
    // nothing reaches disk before the click — the wave in flight keeps its config
    expect(requests.saveProjectSettings).not.toHaveBeenCalled();
  });

  it("drops paralelismo to 1 when worktree por task goes off", async () => {
    render(<Settings projectId="p1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Git & worktrees")).toBeTruthy());
    fireEvent.click(screen.getByText("Git & worktrees"));

    const toggle = await waitFor(() => {
      const t = document.querySelector("button.toggle");
      if (!t) throw new Error("sem toggle");
      return t;
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);

    // without an isolated checkout the loop refuses more than one task at a
    // time, so the patch has to carry that consequence with it.
    fireEvent.click(saveButton());
    await waitFor(() => expect(requests.saveProjectSettings).toHaveBeenCalled());
    expect(requests.saveProjectSettings.mock.calls[0][0].patch).toMatchObject({
      worktreePerTask: false,
      maxParallel: 1,
    });
  });

  it("commits a global preference on the click that changes it", async () => {
    render(<Settings projectId="p1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Limites & paralelismo")).toBeTruthy());
    fireEvent.click(screen.getByText("Limites & paralelismo"));

    await waitFor(() => expect(screen.getByText("LIMITES & PARALELISMO")).toBeTruthy());
    expect(screen.queryByText("salvar")).toBeNull(); // no button: these have no cross-field invariant

    fireEvent.click(screen.getByText("20m")); // timeout de stall 10m → 20m
    await waitFor(() => expect(requests.saveGlobalSettings).toHaveBeenCalledWith({ patch: { stallMinutes: 20 } }));
  });
});
