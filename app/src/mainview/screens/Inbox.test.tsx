// Inbox.test.tsx — 1e. The drawer is the only place a human answers the loop,
// so what matters is that each decision kind offers the actions that make sense
// for it and that clicking one writes the right (run, task, action) triple.
// api.ts is mocked WHOLE because importing it constructs an Electroview, which
// only exists inside a real webview.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

const reportError = vi.fn();

const requests = {
  taskDiff: vi.fn(),
  listDecisions: vi.fn(),
  resolveDecision: vi.fn(),
};

vi.mock("../api.ts", () => ({
  rpc: { request: requests, send: {} },
  // act() is how a screen fires a request the user asked for: it awaits and
  // reports a failure to the shell. Under test the reporting has no shell, so
  // the stub keeps only the awaiting half.
  act: <T,>(work: Promise<T>, then?: (v: T) => void) => void work.then(then).catch(() => {}),
  reportError: (m: string) => reportError(m),

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

const { Inbox } = await import("./Inbox.tsx");
const { decision } = await import("../testing.tsx");

beforeEach(() => {
  vi.clearAllMocks();
  requests.resolveDecision.mockResolvedValue({ ok: true, message: "t1 refeita" });
});

describe("Inbox", () => {
  it("says the board is self-sufficient when nothing is waiting", async () => {
    requests.listDecisions.mockResolvedValue([]);
    render(<Inbox nav={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/nada aguardando você/)).toBeTruthy());
    // no count badge to shout about an empty drawer
    expect(screen.queryByText("0")).toBeNull();
  });

  it("quotes the reviewer and offers all three ways out of a review block", async () => {
    requests.listDecisions.mockResolvedValue([decision()]);
    render(<Inbox nav={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("t1")).toBeTruthy());
    expect(screen.getByText("review bloqueado")).toBeTruthy();
    // the feedback is the whole reason the human was called in
    expect(screen.getByText(/reviewer: “score não pode viver em Question”/)).toBeTruthy();
    expect(screen.getByText("corrigir de novo")).toBeTruthy();
    expect(screen.getByText("aceitar")).toBeTruthy();
    expect(screen.getByText("pular")).toBeTruthy();
  });

  it("sends retry for the run and task of the card that was clicked", async () => {
    requests.listDecisions.mockResolvedValue([
      decision({ id: "run-9:t7", runId: "run-9", taskId: "t7" }),
    ]);
    render(<Inbox nav={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("corrigir de novo")).toBeTruthy());

    fireEvent.click(screen.getByText("corrigir de novo"));
    await waitFor(() =>
      expect(requests.resolveDecision).toHaveBeenCalledWith({ runId: "run-9", projectId: "p1", prdPath: "/dev/qc/prd.json", taskId: "t7", action: "retry" }),
    );
    // the receipt stays in session memory — progress.md is the durable record
    await waitFor(() => expect(screen.getByText(/resolvidas nesta sessão: t1 refeita/)).toBeTruthy());
  });

  it("sends skip when the human decides the task is not worth another turn", async () => {
    requests.listDecisions.mockResolvedValue([decision()]);
    render(<Inbox nav={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("pular")).toBeTruthy());

    fireEvent.click(screen.getByText("pular"));
    await waitFor(() =>
      expect(requests.resolveDecision).toHaveBeenCalledWith({ runId: "run-1", projectId: "p1", prdPath: "/dev/qc/prd.json", taskId: "t1", action: "skip" }),
    );
  });

  it("reports a refused decision instead of filing it as resolved", async () => {
    requests.listDecisions.mockResolvedValue([decision()]);
    // the RPC RESOLVES with ok:false — the task moved on, or another run owns
    // the workspace. Listing that under "resolvidas" would be the app claiming
    // it handled something it did not.
    requests.resolveDecision.mockResolvedValue({ ok: false, message: "há uma run do ralphrun (pid 4242)" });
    render(<Inbox nav={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("pular")).toBeTruthy());
    fireEvent.click(screen.getByText("pular"));

    await waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.stringContaining("4242")));
    expect(screen.queryByText(/resolvidas nesta sessão/)).toBeNull();
  });

  it("puts the patch itself one click away — approving a +/- count is not reviewing", async () => {
    requests.listDecisions.mockResolvedValue([decision()]);
    requests.taskDiff.mockResolvedValue({ diff: "--- a/src/a.ts\n+++ b/src/a.ts\n+novo" });
    render(<Inbox nav={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/ver diff/)).toBeTruthy());
    fireEvent.click(screen.getByText(/ver diff/));

    await waitFor(() => expect(screen.getByText(/\+novo/)).toBeTruthy());
    expect(requests.taskDiff).toHaveBeenCalledWith({ runId: "run-1", taskId: "t1" });
  });

  it("offers restart but never accept on a stall — there is no work to accept", async () => {
    requests.listDecisions.mockResolvedValue([
      decision({ kind: "stall", reason: "sem output há 10 min", feedback: null, diffstat: null }),
    ]);
    render(<Inbox nav={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("stall")).toBeTruthy());
    expect(screen.getByText("reiniciar task")).toBeTruthy();
    expect(screen.queryByText("aceitar")).toBeNull();
    expect(screen.queryByText(/reviewer:/)).toBeNull();

    fireEvent.click(screen.getByText("reiniciar task"));
    await waitFor(() =>
      expect(requests.resolveDecision).toHaveBeenCalledWith({ runId: "run-1", projectId: "p1", prdPath: "/dev/qc/prd.json", taskId: "t1", action: "retry" }),
    );
  });
});
