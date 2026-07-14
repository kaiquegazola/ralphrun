// browser.ts — dev-browser, the optional browser-validation tool.
//
// NOT an agent (it writes no code): it's a Playwright-backed CLI the executor
// shells out to and the `verify` gate runs. Detected/installed exactly like the
// coding CLIs — ralphrun never bundles it (Playwright + Chromium is ~300MB of
// opt-in weight), and a bundled nested dep wouldn't be on the user's PATH where
// a `verify` shell command resolves it anyway.
//
// The "dev-browser" string and its install/update commands live ONLY here.

import { spawn, spawnSync } from "node:child_process";
import which from "which";
import type { Task } from "./prd.js";

export const BROWSER_TOOL = "dev-browser";
export const BROWSER_INSTALL_HINT = "npm i -g dev-browser && dev-browser install";
// dev-browser does NOT self-update: `dev-browser install` and the marketplace
// skill both copy a snapshot. Refreshing the binary is a manual npm step.
export const BROWSER_UPDATE_HINT = "npm update -g dev-browser";

// Match dev-browser as a COMMAND TOKEN, not a bare substring: preceded by the
// start or a shell separator, followed by whitespace / a redirection / the end.
// So `dev-browser --headless < e2e.mjs` and `npm run build && dev-browser < x`
// match, but `dev-browser-old`, `mydev-browser`, and `path/to/dev-browserish`
// do not — a substring match would falsely flag those and demand the tool.
//
// Accepted syntax = the canonical bare invocation the planner is told to emit.
// This is a heuristic, not a shell parser: it can still false-positive on a
// literal mention (`grep dev-browser ...`) or miss an unusual wrapping
// (`bash -lc '...'`). dev-browser is a GLOBAL tool, so a `./node_modules/.bin/`
// path form doesn't arise. A full shell lexer isn't worth it for a detector
// whose input is planner-generated; if a real verify needs an odd form, write
// the bare invocation.
const BROWSER_INVOCATION = new RegExp(
  `(^|[\\s|&;(])${BROWSER_TOOL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|<|>|$)`,
);

// A task opts into browser validation by invoking dev-browser in its verify gate.
// That single fact drives everything downstream — the executor gets the guide,
// preflight checks the binary. No separate flag: the verify command IS the
// decision, and it already lives in prd.json (the durable memory).
export function taskUsesBrowser(task: Task): boolean {
  return !!task.verify && BROWSER_INVOCATION.test(task.verify);
}

// Do any of these tasks invoke the browser tool? Callers pass the RUNNABLE set
// (the selected --task, or the todo tasks) — never the whole PRD — so a done or
// unrelated UI task can't demand the tool for work that won't run.
export function anyTaskUsesBrowser(tasks: Task[]): boolean {
  return tasks.some(taskUsesBrowser);
}

export type BrowserStatus = "ok" | "missing" | "broken";

// "installed" is not enough: a broken launcher (e.g. a Volta shim that resolves
// on PATH but points at a nonexistent bin) passes `which` yet fails every actual
// call — which would silently sink every browser task's verify. So we PROBE it:
// `dev-browser --help` exercises the real binary resolution (no browser launch,
// no Chromium download, fast) and must exit 0. missing → not on PATH; broken →
// on PATH but won't run.
//
// Scope note: "ok" means the LAUNCHER runs, not that Chromium is installed
// (`dev-browser install` is a separate step). Probing Chromium would mean
// launching a real browser on every run — too slow/flaky for a preflight — so a
// missing Chromium surfaces at verify time with dev-browser's own clear
// "run dev-browser install" error instead. The install hint already names it.
export function browserStatus(): BrowserStatus {
  if (!which.sync(BROWSER_TOOL, { nothrow: true })) return "missing";
  // shell:true so a Windows `.cmd`/`.ps1` global shim is launched correctly —
  // Node cannot exec those directly and would return status:null (a false
  // "broken"). Command + args are compile-time constants, so no injection risk.
  const p = spawnSync(BROWSER_TOOL, ["--help"], { stdio: "ignore", timeout: 15_000, shell: true });
  return p.status === 0 ? "ok" : "broken";
}

// Async twin of browserStatus for the live init wizard: the sync spawn above
// would block the Ink render (and freeze a blank alt-screen for the full 15s if
// the binary hangs). Same classification, non-blocking; any spawn error maps to
// "broken", so a probe failure can never crash the wizard mount.
export function browserStatusAsync(): Promise<BrowserStatus> {
  if (!which.sync(BROWSER_TOOL, { nothrow: true })) return Promise.resolve("missing");
  return new Promise((resolve) => {
    const p = spawn(BROWSER_TOOL, ["--help"], { stdio: "ignore", timeout: 15_000, shell: true });
    p.on("error", () => resolve("broken")); // spawn failed
    p.on("close", (code) => resolve(code === 0 ? "ok" : "broken")); // non-zero / killed-by-timeout → broken
  });
}

// Injected into the executor prompt for browser-validated tasks. Points to the
// binary's OWN `--help` (compiled into it, so always in sync with the installed
// version) instead of embedding a copy of the guide that would rot. Plain text,
// so it works for every executor cli, not just claude-with-the-skill.
export function browserGuidance(): string {
  return `
## Browser validation (this task's verify runs \`${BROWSER_TOOL}\`)
This task is checked in a real browser via \`${BROWSER_TOOL}\`, a Playwright-backed CLI that runs a JS script from stdin against a browser and exits non-zero when the script throws. Your \`verify\` command runs it, so it must pass.
Before writing any browser script, run \`${BROWSER_TOOL} --help\` to read the current API (getPage, goto, click, fill, snapshotForAI, screenshot). Write the e2e script so it throws on any failed assertion, and target the local dev server (e.g. http://localhost:3000) with \`waitUntil: "domcontentloaded"\`.`;
}
