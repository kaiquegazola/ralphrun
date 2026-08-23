// runs.ts — the run supervisor, as one door.
//
// The supervisor is five jobs, and it used to be one file holding all of them:
// process lifecycle, NDJSON folding, decisions, diffs, history. They live one
// per module now, and the seams between them are imports instead of adjacency.
// This file only names what the rest of the app is allowed to call.
//
// prd.json stays the source of truth for STATUS. The child rewrites it on every
// transition and the loop re-reads it between waves, so the app both renders
// from it and steers through it.
//
// A LIVE review-blocked task is different: the child's review gate is holding
// that task open, waiting for the human. Those decisions are answered back down
// the child's stdin, not by writing the file — the loop then commits, retries or
// blocks through its own path, which is the only way the work actually lands.
// The file-write path stays for decisions whose run has already ended.

export { onRunChange, setNotifier } from "./store.ts";
export { listDecisions } from "./decisions.ts";
export { readHistory } from "./history.ts";
export { taskDiff } from "./taskdiff.ts";
export { activeRuns, getRunDetail, getStream, listRuns, runForPrd } from "./views.ts";
export { pumpQueue, resolveDecision, startRun, stopRun } from "./lifecycle.ts";
