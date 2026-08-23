// Home.test.tsx — 5a's ordering contract: decisions first, then runs, then
// what you can resume. api.ts is mocked WHOLE because importing it constructs
// an Electroview, which only exists inside a real webview.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

const requests = {
  home: vi.fn(),
  listDecisions: vi.fn(),
  startRun: vi.fn(),
  resolveDecision: vi.fn(),
};

vi.mock("../api.ts", () => ({
  rpc: { request: requests, send: {} },
  // act() is how a screen fires a request the user asked for: it awaits and
  // reports a failure to the shell. Under test the reporting has no shell, so
  // the stub keeps only the awaiting half.
  act: <T,>(work: Promise<T>, then?: (v: T) => void) => void work.then(then).catch(() => {}),

  onStream: () => () => {},
  onChunk: () => () => {},
  // a faithful-enough useQuery: fetch on mount, expose reload. The push
  // subscription is what the real one adds, and no screen test asserts on it.
  useQuery: <T,>(fetcher: () => Promise<T>) => {
    const [data, setData] = useState<T | null>(null);
    useEffect(() => {
      void fetcher().then(setData);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return { data, error: null, reload: () => {} };
  },
}));

const { Home } = await import("./Home.tsx");
const { decision, home, run } = await import("../testing.tsx");

beforeEach(() => {
  vi.clearAllMocks();
  requests.listDecisions.mockResolvedValue([]);
});

describe("Home", () => {
  it("says so plainly when nothing needs a human", async () => {
    requests.home.mockResolvedValue(home());
    render(<Home nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/nada travado/)).toBeTruthy());
    expect(screen.getByText(/nenhuma run ativa/)).toBeTruthy();
  });

  it("shows a pending decision with its task, project and action", async () => {
    requests.home.mockResolvedValue(home({ decisions: [decision()] }));
    render(<Home nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("t1")).toBeTruthy());
    expect(screen.getByText(/review bloqueado/)).toBeTruthy();
    expect(screen.getByText(/qc-colombia/)).toBeTruthy();
    expect(screen.getByText("resolver")).toBeTruthy();
  });

  it("counts the active runs in the section heading", async () => {
    requests.home.mockResolvedValue(home({ runs: [run(), run({ id: "run-2" })] }));
    render(<Home nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/AGORA RODANDO · 2 RUNS/)).toBeTruthy());
  });
});
