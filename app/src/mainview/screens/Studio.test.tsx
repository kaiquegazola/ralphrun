// Studio.test.tsx — 1h. The chat and the PRD it produces are one screen, so
// the tests cover both halves: what a turn does to the input, and what the
// planner's answer does to the PRD pane. api.ts is mocked WHOLE (it constructs
// an Electroview), and onChunk is captured so a test can play the streaming
// planner the way the main process does.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

const requests = {
  studioOpen: vi.fn(),
  studioSend: vi.fn(),
  studioSave: vi.fn(),
  studioUndo: vi.fn(),
  studioAttach: vi.fn(),
  startRun: vi.fn(),
};

type ChunkListener = (projectId: string, text: string) => void;
let listener: ChunkListener | null = null;

vi.mock("../api.ts", () => ({
  rpc: { request: requests, send: {} },
  // act() is how a screen fires a request the user asked for: it awaits and
  // reports a failure to the shell. Under test the reporting has no shell, so
  // the stub keeps only the awaiting half.
  act: <T,>(work: Promise<T>, then?: (v: T) => void) => void work.then(then).catch(() => {}),

  onStream: () => () => {},
  onChunk: (fn: ChunkListener) => {
    listener = fn;
    return () => {};
  },
  useQuery: <T,>(fetcher: () => Promise<T>) => {
    const [data, setData] = useState<T | null>(null);
    useEffect(() => {
      void fetcher().then(setData);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return { data, error: null, reload: () => {} };
  },
}));

const { Studio } = await import("./Studio.tsx");
const { studio, task } = await import("../testing.tsx");

beforeEach(() => {
  vi.clearAllMocks();
  listener = null;
  requests.studioOpen.mockResolvedValue(studio());
});

describe("Studio", () => {
  it("explains the skeleton-first flow while the chat is empty", async () => {
    render(<Studio projectId="p1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/ESQUELETO primeiro/)).toBeTruthy());
    // the PRD pane says the same thing from the other side: nothing yet
    expect(screen.getByText(/o PRD aparece aqui conforme o planner responde/)).toBeTruthy();
  });

  it("sends the typed turn and empties the box so the next one starts clean", async () => {
    requests.studioSend.mockResolvedValue(studio({ messages: [{ role: "you", text: "um blog" }] }));
    render(<Studio projectId="p1" nav={vi.fn()} />);

    const input = await screen.findByPlaceholderText(/descreva o que construir/);
    fireEvent.change(input, { target: { value: "um blog" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(requests.studioSend).toHaveBeenCalledWith({ projectId: "p1", text: "um blog" }));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("renders a pushed chunk as a typing bubble, and ignores another project's", async () => {
    render(<Studio projectId="p1" nav={vi.fn()} />);
    await waitFor(() => expect(listener).not.toBeNull());

    act(() => listener?.("p1", "esqueleto:"));
    act(() => listener?.("p1", " t1, t2"));
    // chunks accumulate into one bubble — a turn is a single message arriving
    expect(screen.getByText(/esqueleto: t1, t2/)).toBeTruthy();
    expect(document.querySelector(".pulse")).toBeTruthy();
    // the empty-state hint steps aside as soon as text arrives
    expect(screen.queryByText(/ESQUELETO primeiro/)).toBeNull();

    act(() => listener?.("p2", " de outro projeto"));
    expect(screen.queryByText(/de outro projeto/)).toBeNull();
  });

  it("lists tasks with their deps and marks the ones still without verify", async () => {
    requests.studioOpen.mockResolvedValue(
      studio({
        tasks: [
          task({ id: "t1", title: "Contracts", verify: "npm test" }),
          task({ id: "t2", title: "API", wave: 1, deps: ["t1"] }),
        ],
      }),
    );
    render(<Studio projectId="p1" nav={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Contracts")).toBeTruthy());
    expect(screen.getByText("←t1")).toBeTruthy();

    // t2 has no verify yet: it is a skeleton the planner still has to expand,
    // and the pane says so in the id's colour instead of a second badge.
    expect(screen.getByText("t2").getAttribute("style")).toContain("var(--doing)");
    expect(screen.getByText("t1").getAttribute("style")).toContain("var(--muted)");
  });

  it("refuses to save or build while the deps do not close", async () => {
    requests.studioOpen.mockResolvedValue(studio({ errors: ["t2 depende de t9 inexistente"] }));
    render(<Studio projectId="p1" nav={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/1 erro\(s\)/)).toBeTruthy());
    expect((screen.getByText("salvar PRD") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("construir ▶") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("✗ inválido")).toBeTruthy();
  });

  it("opens both buttons once the plan validates", async () => {
    requests.studioOpen.mockResolvedValue(studio({ depsOk: true, tasks: [task()] }));
    render(<Studio projectId="p1" nav={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/deps ok/)).toBeTruthy());
    expect((screen.getByText("salvar PRD") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("construir ▶") as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves, then starts the run on the file it just wrote", async () => {
    const nav = vi.fn();
    requests.studioOpen.mockResolvedValue(studio({ depsOk: true, tasks: [task()] }));
    requests.studioSave.mockResolvedValue(studio({ depsOk: true, prdPath: "/repo/prd.json", dirty: false }));
    requests.startRun.mockResolvedValue({ runId: "run-9" });
    render(<Studio projectId="p1" nav={nav} />);

    await waitFor(() => expect(screen.getByText(/deps ok/)).toBeTruthy());
    fireEvent.click(screen.getByText("construir ▶"));

    await waitFor(() =>
      expect(requests.startRun).toHaveBeenCalledWith({ projectId: "p1", prdPath: "/repo/prd.json" }),
    );
    expect(nav).toHaveBeenCalledWith({ t: "run", runId: "run-9" });
  });

  it("does not build on a stale file when the save failed", async () => {
    const nav = vi.fn();
    requests.studioOpen.mockResolvedValue(studio({ depsOk: true, tasks: [task()] }));
    // a failed write keeps the PREVIOUS prdPath and leaves the draft dirty —
    // building anyway would run the old backlog while the chat shows the error
    requests.studioSave.mockResolvedValue(studio({ depsOk: true, prdPath: "/repo/prd.json", dirty: true }));
    render(<Studio projectId="p1" nav={nav} />);

    await waitFor(() => expect(screen.getByText(/deps ok/)).toBeTruthy());
    fireEvent.click(screen.getByText("construir ▶"));

    await waitFor(() => expect(requests.studioSave).toHaveBeenCalled());
    expect(requests.startRun).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });
});
