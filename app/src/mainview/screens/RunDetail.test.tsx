// RunDetail.test.tsx — the board's job is to make the loop's shape legible:
// one column group per wave, the running wave loud and the pending ones dim,
// history folded away. api.ts is mocked WHOLE (it constructs an Electroview),
// and onStream is mocked so a test can push a line the way the loop does.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

import type { StreamLine } from "../../shared/types.ts";

const requests = {
  getRun: vi.fn(),
  globalSettings: vi.fn(),
  getStream: vi.fn(),
  stopRun: vi.fn(),
};

type StreamListener = (runId: string, taskId: string, line: StreamLine) => void;
let listener: StreamListener | null = null;
const unsubscribe = vi.fn();

vi.mock("../api.ts", () => ({
  rpc: { request: requests, send: {} },
  // act() is how a screen fires a request the user asked for: it awaits and
  // reports a failure to the shell. Under test the reporting has no shell, so
  // the stub keeps only the awaiting half.
  act: <T,>(work: Promise<T>, then?: (v: T) => void) => void work.then(then).catch(() => {}),

  // capturing the listener is the whole point: the stream pane is push-fed,
  // so a test has to be able to play the main process.
  onStream: (fn: StreamListener) => {
    listener = fn;
    return unsubscribe;
  },
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

const { RunDetail } = await import("./RunDetail.tsx");
const { globalSettings, runDetail, task } = await import("../testing.tsx");

// wave 0 finished, wave 1 is what the loop dispatches now (run.wave is 1-based),
// wave 2 still waits on its deps.
const board = () =>
  runDetail({
    wave: 2,
    waveCount: 3,
    tasks: [
      task({ id: "t1", status: "done", wave: 0 }),
      task({ id: "t2", status: "done", wave: 0 }),
      task({ id: "t3", status: "doing", wave: 1, deps: ["t1"], subphase: "executing" }),
      task({ id: "t4", status: "blocked", wave: 1, deps: ["t2"], reason: "review recusou 3x" }),
      task({ id: "t5", status: "todo", wave: 2, deps: ["t3", "t4"] }),
    ],
    focusTaskId: "t3",
  });

beforeEach(() => {
  vi.clearAllMocks();
  listener = null;
  requests.getRun.mockResolvedValue(board());
  requests.globalSettings.mockResolvedValue(globalSettings());
  requests.getStream.mockResolvedValue([]);
});

describe("RunDetail", () => {
  it("labels the running wave and the ones still waiting on deps", async () => {
    render(<RunDetail runId="run-1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("WAVE 2 · EM EXECUÇÃO")).toBeTruthy());
    expect(screen.getByText("WAVE 3 · AGUARDANDO DEPS")).toBeTruthy();
  });

  it("folds a finished wave into one line and expands it on click", async () => {
    render(<RunDetail runId="run-1" nav={vi.fn()} />);
    // folded: the cards are gone, the summary names the tasks that landed
    await waitFor(() => expect(screen.getByText(/t1 t2 — mergeadas no trunk/)).toBeTruthy());
    expect(screen.queryByText("WAVE 1 · CONCLUÍDA")).toBeNull();

    fireEvent.click(screen.getByText(/expandir/));
    expect(screen.getByText("WAVE 1 · CONCLUÍDA")).toBeTruthy();
    expect(screen.getAllByText("mergeada no trunk").length).toBe(2);

    fireEvent.click(screen.getByText(/recolher/));
    expect(screen.getByText(/mergeadas no trunk/)).toBeTruthy();
  });

  it("tells a waiting task what it waits on, and marks a blocked one for review", async () => {
    render(<RunDetail runId="run-1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("espera t3, t4")).toBeTruthy());
    expect(screen.getByText("⚠ REVIEW")).toBeTruthy();
    // the reason replaces the progress line — that is what the human acts on
    expect(screen.getByText("review recusou 3x")).toBeTruthy();
  });

  it("hides the stream in calmo and brings it back in cirúrgico", async () => {
    render(<RunDetail runId="run-1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/seguir/)).toBeTruthy());

    fireEvent.click(screen.getByText("calmo"));
    expect(screen.queryByText(/seguir/)).toBeNull();

    fireEvent.click(screen.getByText("cirúrgico"));
    expect(screen.getByText(/seguir/)).toBeTruthy();
  });

  // The stored preference has to REACH the screen. Seeded with "calm" rather
  // than the component's own initial state, so deleting the effect that reads
  // globalSettings fails this test instead of silently passing it.
  it("starts in the mode the global setting says, not in its own default", async () => {
    requests.globalSettings.mockResolvedValue(globalSettings({ runDetailMode: "calm" }));
    render(<RunDetail runId="run-1" nav={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("WAVE 2 · EM EXECUÇÃO")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText(/seguir/)).toBeNull());
  });

  it("opens the stream on the focused task and grows it with pushed lines", async () => {
    requests.getStream.mockResolvedValue([{ at: 1, text: "npm test", source: "executor" }]);
    render(<RunDetail runId="run-1" nav={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("npm test")).toBeTruthy());
    expect(requests.getStream).toHaveBeenCalledWith({ runId: "run-1", taskId: "t3" });

    act(() => listener?.("run-1", "t3", { at: 2, text: "linha empurrada", source: "executor" }));
    expect(screen.getByText("linha empurrada")).toBeTruthy();

    // a line from another task must not leak into the focused pane
    act(() => listener?.("run-1", "t4", { at: 3, text: "outra task", source: "executor" }));
    expect(screen.queryByText("outra task")).toBeNull();
  });

  it("opens the run's own log — a stream key of \"\", not a task", async () => {
    // the key is EMPTY on purpose: a named one like "run" could be a task id,
    // since ids are free text. The pane has to treat "" as a selection.
    render(<RunDetail runId="run-1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("t4")).toBeTruthy());
    requests.getStream.mockResolvedValue([{ at: 1, text: "wave 1 iniciada", source: "system" }]);

    fireEvent.click(screen.getByText(/log da run/));

    await waitFor(() => expect(requests.getStream).toHaveBeenCalledWith({ runId: "run-1", taskId: "" }));
    expect(screen.getByText("wave 1 iniciada")).toBeTruthy();
  });

  it("follows the card you click instead of the run's own focus", async () => {
    render(<RunDetail runId="run-1" nav={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("t4")).toBeTruthy());

    fireEvent.click(screen.getByText("t4"));
    await waitFor(() => expect(requests.getStream).toHaveBeenCalledWith({ runId: "run-1", taskId: "t4" }));
  });
});
