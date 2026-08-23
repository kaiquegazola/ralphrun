// api.ts — the webview half of the RPC, plus the two hooks every screen uses.
// Screens never poll: the main process pushes a "something changed" message and
// whatever is mounted refetches itself.

import { Electroview } from "electrobun/view";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AppRPC } from "../shared/rpc.ts";
import type { StreamLine } from "../shared/types.ts";

type Topic = "runs" | "decisions" | "workforce" | "projects";

const subs: Record<Topic, Set<() => void>> = {
  runs: new Set(),
  decisions: new Set(),
  workforce: new Set(),
  projects: new Set(),
};

type StreamListener = (runId: string, taskId: string, line: StreamLine) => void;
const streamSubs = new Set<StreamListener>();

type ErrorListener = (message: string) => void;
const errorSubs = new Set<ErrorListener>();

/** Subscribe to failures raised by `act()`. The shell renders them. */
export function onError(cb: ErrorListener): () => void {
  errorSubs.add(cb);
  return () => errorSubs.delete(cb);
}

/** Report a failure the shell should show — for refusals that are not throws. */
export function reportError(message: string): void {
  for (const cb of errorSubs) cb(message);
}

/**
 * Run an RPC the user asked for, and SHOW the failure if there is one.
 *
 * A bare `.then(...)` on a rejecting request leaves an unhandled promise and a
 * button that silently did nothing — which is exactly what a malformed
 * ralph.config.json produces when a run refuses to start.
 */
export function act<T>(work: Promise<T>, then?: (value: T) => void): void {
  void work.then(then).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    for (const cb of errorSubs) cb(message);
  });
}

type ChunkListener = (projectId: string, text: string) => void;
const chunkSubs = new Set<ChunkListener>();

function fire(topic: Topic): void {
  for (const cb of subs[topic]) cb();
}

export const rpc = Electroview.defineRPC<AppRPC>({
  // Above the planner's own 30-minute ceiling (prdChat.MAX_TURN_MS). A shorter
  // window would reject in the UI while the turn kept running in the main
  // process, letting a second turn start and the first one land on top of it.
  maxRequestTime: 35 * 60_000,
  handlers: {
    requests: {},
    messages: {
      runsChanged: () => fire("runs"),
      decisionsChanged: () => {
        fire("decisions");
        fire("runs");
      },
      workforceChanged: () => fire("workforce"),
      projectsChanged: () => fire("projects"),
      streamAppended: ({ runId, taskId, line }) => {
        for (const cb of streamSubs) cb(runId, taskId, line);
      },
      studioChunk: ({ projectId, text }) => {
        for (const cb of chunkSubs) cb(projectId, text);
      },
    },
  },
});

export const view = new Electroview({ rpc });

export function onStream(cb: StreamListener): () => void {
  streamSubs.add(cb);
  return () => streamSubs.delete(cb);
}

export function onChunk(cb: ChunkListener): () => void {
  chunkSubs.add(cb);
  return () => chunkSubs.delete(cb);
}

/**
 * Fetch once, then refetch on every named topic. `key` exists so a screen that
 * changes what it is looking at (another run, another project) refetches
 * without the caller having to remember a dependency array.
 */
export function useQuery<T>(
  fetcher: () => Promise<T>,
  topics: Topic[],
  key: string = "",
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const topicKey = topics.join(",");
  // A monotonic request id, NOT a per-call flag: a push can fire reload while
  // the previous one is still in flight, and without an ordering the older
  // answer can land last and overwrite fresher state with a stale snapshot.
  const latest = useRef(0);
  const alive = useRef(true);

  const reload = useCallback(() => {
    const seq = ++latest.current;
    fetcherRef
      .current()
      .then((d) => {
        if (!alive.current || seq !== latest.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive.current || seq !== latest.current) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    const list = topicKey.split(",").filter(Boolean) as Topic[];
    for (const t of list) subs[t].add(reload);
    return () => {
      alive.current = false;
      for (const t of list) subs[t].delete(reload);
    };
  }, [reload, topicKey, key]);

  return { data, error, reload };
}
