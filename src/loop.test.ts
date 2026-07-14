// loop.test.ts — covers runLoop: preflight gates, dry-run, task lifecycle,
// and the TTY Ink dashboard wiring (mount/control/reporter) vs non-TTY fallback.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("./config.js", () => ({ loadConfig: vi.fn(), parseAgent: vi.fn() }));
// i18n (real) imports userconfig, whose node:fs named imports the partial fs
// mock above would not satisfy — stub the module instead.
vi.mock("./userconfig.js", () => ({ loadUserConfig: vi.fn(() => ({ version: 1 })) }));
vi.mock("./diagnostics.js", () => ({ checkAgent: vi.fn() }));
// browser.js runs REAL against these mocks (its only external calls) so the
// dev-browser preflight is drivable without stubbing the module.
vi.mock("which", () => ({ default: { sync: vi.fn() } }));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
// prdload is NOT mocked: the intake pipeline runs REAL against the fs mock,
// so every test's mRead must return a parseable+valid PRD for the preflight.
// findTask/nextTask are driven per-test; sessionRunnableIds (pure) runs REAL so
// the browser-preflight scope reflects the actual dependency closure.
vi.mock("./prd.js", async (importActual) => {
  const actual = await importActual<typeof import("./prd.js")>();
  return { findTask: vi.fn(), nextTask: vi.fn(), sessionRunnableIds: actual.sessionRunnableIds };
});
vi.mock("./log.js", () => ({ log: vi.fn(), setReporter: vi.fn() }));
vi.mock("./git.js", () => ({ git: vi.fn(), headCommit: vi.fn(() => null), captureReviewBase: vi.fn(() => "base-tree") }));
vi.mock("./run.js", () => ({ runTask: vi.fn() }));
vi.mock("./tui/mount.js", () => ({ mount: vi.fn() }));
vi.mock("./configcmd.js", () => ({ pickModel: vi.fn() }));
vi.mock("@clack/prompts", () => ({
  select: vi.fn(async () => "start"),
  text: vi.fn(),
  isCancel: vi.fn(() => false),
}));

import { runLoop } from "./loop.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, parseAgent } from "./config.js";
import { checkAgent } from "./diagnostics.js";
import { findTask, nextTask } from "./prd.js";
import { log, setReporter } from "./log.js";
import { git, headCommit, captureReviewBase } from "./git.js";
import { runTask } from "./run.js";
import { mount } from "./tui/mount.js";
import { pickModel } from "./configcmd.js";
import { isCancel, select } from "@clack/prompts";
import which from "which";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.js";

const mWhichSync = vi.mocked(which.sync);
const mSpawnSync = vi.mocked(spawnSync);
const browserTask = (over: Record<string, unknown> = {}) => ({
  id: "T1", title: "UI", status: "todo", deps: [], retries: 0, description: "d", acceptance: [],
  verify: "dev-browser --headless < e2e.mjs", ...over,
});
const prdWith = (tasks: unknown[]) => JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks });
const BROWSER_PRD = prdWith([browserTask()]);

const mExists = vi.mocked(existsSync);
const mRead = vi.mocked(readFileSync);
const mWrite = vi.mocked(writeFileSync);
const mLoadConfig = vi.mocked(loadConfig);
const mParseAgent = vi.mocked(parseAgent);
const mCheckAgent = vi.mocked(checkAgent);
const mFindTask = vi.mocked(findTask);
const mNextTask = vi.mocked(nextTask);
const mLog = vi.mocked(log);
const mSetReporter = vi.mocked(setReporter);
const mGit = vi.mocked(git);
const mHeadCommit = vi.mocked(headCommit);
const mCaptureReviewBase = vi.mocked(captureReviewBase);
const mRunTask = vi.mocked(runTask);
const mMount = vi.mocked(mount);
const mPickModel = vi.mocked(pickModel);
const mSelect = vi.mocked(select);
const mIsCancel = vi.mocked(isCancel);

const TASK = { id: "T1", title: "Task one", status: "todo", deps: [], retries: 0, description: "d", acceptance: [] };
const PRD_JSON = JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks: [TASK] });

function cfg(over: Partial<Config> = {}): Config {
  return {
    executor: { cli: "claude", model: "sonnet" },
    advisor: { cli: "claude", model: "fable" },
    task_timeout: 1800,
    advisor_timeout: 300,
    max_retries_per_task: 3,
    review_after: true,
    max_review_rounds: 3,
    max_stalled_review_rounds: 2,
    heartbeat_secs: 30,
    commit_per_task: true,
    commit_message_template: "{id}: {title}",
    stop_on_blocked: false,
    extra_executor_args: [],
    ...over,
  };
}

const SIG = new AbortController().signal;
type Handle = ReturnType<typeof mMount>;
function makeHandle(over: {
  shouldQuit?: boolean;
  takeSkip?: boolean;
  reviewAction?: "retry" | "approve" | "block" | "quit";
} = {}): Handle {
  return {
    update: vi.fn(),
    control: {
      isPaused: vi.fn(() => false),
      shouldQuit: vi.fn(() => over.shouldQuit ?? false),
      takeSkip: vi.fn(() => over.takeSkip ?? false),
      beginTask: vi.fn(() => SIG),
    },
    waitConfigOrResume: vi.fn(async () => "resume"),
    waitStalled: vi.fn(async () => "quit"),
    waitReviewBlocked: vi.fn(async () => over.reviewAction ?? "block"),
    unmount: vi.fn(),
  } as unknown as Handle;
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

// existsSync flags
let prdExists: boolean, progressExists: boolean, gitExists: boolean;

const origTTY = process.stdout.isTTY;
function setTTY(v: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
}
// fire timers synchronously so the multi-iteration loop terminates in-test.
function fastTimers(): void {
  vi.stubGlobal("setTimeout", (fn: () => void) => {
    fn();
    return 0;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setTTY(false);
  prdExists = true;
  progressExists = true;
  gitExists = true;
  mExists.mockImplementation((pth) => {
    const p = String(pth);
    if (p.endsWith("progress.md")) return progressExists;
    if (p.endsWith(".git")) return gitExists;
    return prdExists;
  });
  mRead.mockReturnValue(PRD_JSON);
  mLoadConfig.mockReturnValue(cfg());
  mParseAgent.mockReturnValue({ cli: "claude", model: "sonnet" });
  mCheckAgent.mockReturnValue({ cli: "claude", installed: true, loggedIn: true, loginCommand: "claude auth login" });
  mNextTask.mockReturnValueOnce(TASK as never).mockReturnValue(null);
  mFindTask.mockReturnValue(TASK as never);
  mRunTask.mockResolvedValue({ ok: true });
  mHeadCommit.mockReturnValue(null);
  mCaptureReviewBase.mockReturnValue("base-tree");
  mMount.mockReturnValue(makeHandle());
  mSelect.mockResolvedValue("start" as never);
  mPickModel.mockResolvedValue("claude:sonnet");
  mIsCancel.mockReset();
  mIsCancel.mockReturnValue(false);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error("exit:" + code);
  }) as never) as unknown as typeof exitSpy;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errSpy.mockRestore();
  logSpy.mockRestore();
  vi.unstubAllGlobals();
  Object.defineProperty(process.stdout, "isTTY", { value: origTTY, configurable: true });
});

describe("runLoop preflight", () => {
  it("exits when PRD missing", async () => {
    prdExists = false;
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("no PRD at"));
  });

  it("exits when CLI not installed", async () => {
    mCheckAgent.mockReturnValue({ cli: "claude", installed: false, loggedIn: "unknown" });
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("not installed"));
  });

  it("exits when CLI not logged in", async () => {
    mCheckAgent.mockReturnValue({ cli: "claude", installed: true, loggedIn: false, loginCommand: "claude auth login" });
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("NOT logged in"));
  });

  it("exits when a task's verify needs dev-browser but it's not on PATH", async () => {
    mRead.mockReturnValue(BROWSER_PRD);
    mWhichSync.mockReturnValue(null as never);
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("not on your PATH"));
  });

  it("exits when dev-browser resolves but won't run (broken shim)", async () => {
    mRead.mockReturnValue(BROWSER_PRD);
    mWhichSync.mockReturnValue("/usr/local/bin/dev-browser" as never);
    mSpawnSync.mockReturnValue({ status: 1 } as never); // `--help` fails
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("won't run"));
  });

  it("proceeds and logs the update reminder when dev-browser is runnable", async () => {
    fastTimers();
    mRead.mockReturnValue(BROWSER_PRD);
    mWhichSync.mockReturnValue("/usr/local/bin/dev-browser" as never);
    mSpawnSync.mockReturnValue({ status: 0 } as never); // `--help` exits 0
    await runLoop({ prd: "prd.json" });
    expect(mLog).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("browser validation active"));
  });

  it("on a TTY, demands dev-browser for a BLOCKED browser task (menus can promote it)", async () => {
    setTTY(true);
    mSelect.mockResolvedValue("start" as never); // resume menu → start (blocked stays blocked)
    mRead.mockReturnValue(prdWith([browserTask({ status: "blocked" })]));
    mWhichSync.mockReturnValue(null as never);
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("not on your PATH"));
  });

  it("in non-TTY/CI, does NOT demand dev-browser for a BLOCKED browser task (it can never run)", async () => {
    fastTimers();
    mRead.mockReturnValue(prdWith([
      browserTask({ id: "T0", status: "blocked" }),
      { id: "T1", title: "back", status: "todo", deps: [], retries: 0, description: "d", acceptance: [], verify: "npm test" },
    ]));
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce({ id: "T1", title: "back", status: "todo", deps: [], retries: 0, description: "d", acceptance: [] } as never).mockReturnValue(null);
    mWhichSync.mockReturnValue(null as never); // dev-browser absent — must NOT matter in non-TTY
    await runLoop({ prd: "prd.json" });
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("dev-browser"));
  });

  it("does NOT demand dev-browser for a DONE browser task alongside non-browser work", async () => {
    fastTimers();
    mRead.mockReturnValue(prdWith([
      browserTask({ id: "T0", status: "done" }),
      { id: "T1", title: "back", status: "todo", deps: [], retries: 0, description: "d", acceptance: [], verify: "npm test" },
    ]));
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce({ id: "T1", title: "back", status: "todo", deps: [], retries: 0, description: "d", acceptance: [] } as never).mockReturnValue(null);
    mWhichSync.mockReturnValue(null as never); // dev-browser absent — must NOT matter
    await runLoop({ prd: "prd.json" });
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("dev-browser"));
  });

  it("allows changing an unavailable initial agent before preflight", async () => {
    setTTY(true);
    mLoadConfig.mockReturnValue(cfg({ executor: { cli: "missing", model: "" }, advisor: null }));
    mSelect.mockResolvedValueOnce("config" as never).mockResolvedValueOnce("start" as never);
    mPickModel.mockResolvedValueOnce("cursor:composer-2.5").mockResolvedValueOnce("none");
    mParseAgent.mockImplementation((spec) => {
      if (spec === "none") return null;
      const [cli, model = ""] = String(spec).split(":", 2);
      return { cli, model };
    });
    mCheckAgent.mockImplementation((cli) => ({
      cli,
      installed: cli === "cursor",
      loggedIn: true,
      loginCommand: "cursor agent login",
    }));

    await runLoop({ prd: "prd.json" });

    expect(mPickModel).toHaveBeenCalledTimes(2);
    expect(mCheckAgent).toHaveBeenCalledWith("cursor");
    expect(mCheckAgent).not.toHaveBeenCalledWith("missing");
  });

  it("exits cleanly from the initial menu when selection is cancelled", async () => {
    setTTY(true);
    vi.mocked(select).mockResolvedValueOnce(Symbol("cancel") as never);
    mIsCancel.mockReturnValueOnce(true);
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:0");
  });

  it("resumes blocked tasks from the initial menu", async () => {
    fastTimers();
    setTTY(true);
    const blocked = { ...TASK, status: "blocked", retries: 2 };
    mRead.mockReturnValue(JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks: [blocked] }));
    mSelect.mockResolvedValue("retry_blocked" as never);
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValue(null);

    await runLoop({ prd: "prd.json" });

    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    expect(writes.some((s) => JSON.parse(s).tasks[0].status === "todo" && JSON.parse(s).tasks[0].retries === 0)).toBe(true);
  });

  it("persists explicit config paths and non-null agents chosen from the initial menu", async () => {
    fastTimers();
    setTTY(true);
    mSelect.mockResolvedValueOnce("config" as never).mockResolvedValueOnce("start" as never);
    mPickModel.mockResolvedValueOnce("cursor:composer-2.5").mockResolvedValueOnce("codex:gpt-5.6-sol");
    mParseAgent.mockImplementation((spec) => {
      if (spec === "none") return null;
      const [cli, model = ""] = String(spec).split(":", 2);
      return { cli, model };
    });

    await runLoop({ prd: "prd.json", config: "alternate.json" });

    expect(mWrite).toHaveBeenCalledWith(expect.stringMatching(/alternate\.json$/), expect.stringContaining('"codex"'));
  });

  it("keeps the active agents when configuration selection is cancelled or invalid", async () => {
    fastTimers();
    setTTY(true);
    mSelect.mockResolvedValueOnce("config" as never).mockResolvedValueOnce("config" as never).mockResolvedValueOnce("start" as never);
    mPickModel.mockResolvedValueOnce(Symbol("cancel")).mockResolvedValueOnce("none");
    mParseAgent.mockImplementation((spec) => (spec === "none" ? null : { cli: "claude", model: "sonnet" }));

    await runLoop({ prd: "prd.json" });

    expect(mPickModel).toHaveBeenCalledTimes(4);
  });

  it("keeps configuration unchanged when the executor picker is cancelled", async () => {
    fastTimers();
    setTTY(true);
    mSelect.mockResolvedValueOnce("config" as never).mockResolvedValueOnce("start" as never);
    mPickModel.mockResolvedValueOnce(Symbol("cancel"));
    mIsCancel.mockReturnValueOnce(false).mockReturnValueOnce(true);

    await runLoop({ prd: "prd.json" });

    expect(mPickModel).toHaveBeenCalledTimes(1);
  });

  it("keeps configuration unchanged when an executor selection parses to none", async () => {
    fastTimers();
    setTTY(true);
    mSelect.mockResolvedValueOnce("config" as never).mockResolvedValueOnce("start" as never);
    mPickModel.mockResolvedValueOnce("none");
    mParseAgent.mockReturnValue(null);

    await runLoop({ prd: "prd.json" });

    expect(mPickModel).toHaveBeenCalledTimes(1);
  });

  it("keeps configuration unchanged when the advisor picker is cancelled", async () => {
    fastTimers();
    setTTY(true);
    mSelect.mockResolvedValueOnce("config" as never).mockResolvedValueOnce("start" as never);
    mPickModel.mockResolvedValueOnce("claude:sonnet").mockResolvedValueOnce(Symbol("cancel"));
    mIsCancel.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);

    await runLoop({ prd: "prd.json" });

    expect(mPickModel).toHaveBeenCalledTimes(2);
  });

  it("invalid-shape PRD → exit 1 with header, error lines and the init hint", async () => {
    mRead.mockReturnValue(JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks: {} }));
    await expect(runLoop({ prd: "prd.json", dryRun: true })).rejects.toThrow("exit:1");
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toContain("invalid PRD at");
    expect(lines.some((l) => l.startsWith("  "))).toBe(true); // indented validatePrd lines
    expect(lines.at(-1)).toContain("ralphrun init");
    expect(mWrite).not.toHaveBeenCalled(); // never persists a broken file
  });

  it("malformed prd.json → clean exit 1 with invalid JSON, no stack", async () => {
    mRead.mockReturnValue("{oops");
    await expect(runLoop({ prd: "prd.json", task: "T1" })).rejects.toThrow("exit:1");
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.join("\n")).toContain("invalid JSON");
    expect(lines.join("\n")).not.toContain("    at "); // no stack frames
  });

  it("malformed ralph.config.json → one-line exit 1", async () => {
    mLoadConfig.mockImplementation(() => {
      throw new Error("invalid JSON in /x/ralph.config.json: boom");
    });
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith("invalid JSON in /x/ralph.config.json: boom");
  });

  it("non-Error config failure is stringified", async () => {
    mLoadConfig.mockImplementation(() => {
      throw "cfg-string";
    });
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith("cfg-string");
  });
});

describe("runLoop dry-run", () => {
  it("NATIVE + recovery", async () => {
    // a task missing retries drives normalized:true through the real pipeline
    // (JSON.stringify drops undefined-valued keys)
    const bare = { ...TASK, retries: undefined };
    mRead.mockReturnValue(JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks: [bare] }));
    await runLoop({ prd: "prd.json", dryRun: true });
    expect(mWrite).toHaveBeenCalled(); // savePRD after normalize
    const written = JSON.parse(String(mWrite.mock.calls[0][1]));
    expect(written.tasks[0].retries).toBe(0); // the cleanup is persisted
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("mode: NATIVE");
    expect(out).toContain("review-after: native");
    expect(mMount).not.toHaveBeenCalled(); // no TUI in dry-run
  });

  it("CROSS review on (executor non-claude)", async () => {
    mLoadConfig.mockReturnValue(cfg({ executor: { cli: "grok", model: "g" } }));
    await runLoop({ prd: "prd.json", dryRun: true });
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("mode: CROSS");
    expect(out).toContain("review-after: on");
  });

  it("CROSS review off (advisor present, review_after false)", async () => {
    mLoadConfig.mockReturnValue(cfg({ advisor: { cli: "grok", model: "g" }, review_after: false }));
    await runLoop({ prd: "prd.json", dryRun: true });
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("mode: CROSS");
    expect(out).toContain("review-after: off");
  });

  it("no advisor → adv none, review off", async () => {
    mLoadConfig.mockReturnValue(cfg({ advisor: null }));
    await runLoop({ prd: "prd.json", dryRun: true });
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("advisor none");
    expect(out).toContain("review-after: off");
  });

  it("stops immediately when every task is already done", async () => {
    mRead.mockReturnValue(JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks: [{ ...TASK, status: "done" }] }));
    mNextTask.mockReset();
    mNextTask.mockReturnValue(null);
    await runLoop({ prd: "prd.json" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("all tasks done"));
  });
});

describe("runLoop real run (non-TTY fallback)", () => {
  it("done → commit; inits git; writes missing progress; no TUI; overrides", async () => {
    fastTimers();
    gitExists = false; // trigger git init
    progressExists = false; // trigger progress write
    await runLoop({ prd: "prd.json", executor: "claude:sonnet", advisor: "claude:fable", noReviewAfter: true });
    expect(mParseAgent).toHaveBeenCalled();
    expect(mMount).not.toHaveBeenCalled(); // non-TTY: no dashboard
    expect(mRunTask).toHaveBeenCalledWith(TASK, expect.anything(), expect.anything(), expect.any(String), expect.any(String), undefined, undefined, "base-tree");
    expect(mGit).toHaveBeenCalledWith(expect.any(String), "init");
    expect(mGit).toHaveBeenCalledWith(expect.any(String), "add", "-A");
    expect(mGit).toHaveBeenCalledWith(expect.any(String), "commit", "-m", expect.stringContaining("T1"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("DONE T1"));
    expect(mSetReporter).toHaveBeenLastCalledWith(null); // cleaned up on exit
  });

  it("failing task (runTask throws) → retry (todo); parseAgent null skips override", async () => {
    fastTimers();
    mParseAgent.mockReturnValueOnce(null); // if(ex) false branch
    mRunTask.mockRejectedValue("boom-string"); // non-Error → String(e) branch
    await runLoop({ prd: "prd.json", executor: "bad" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("retry 1"));
  });

  it("blocked on max retries → stop_on_blocked returns", async () => {
    mLoadConfig.mockReturnValue(cfg({ max_retries_per_task: 1, stop_on_blocked: true, advisor: null, commit_per_task: false, review_after: false }));
    mRunTask.mockRejectedValue(new Error("boom")); // Error branch of crash log; crash → ok false
    await runLoop({ prd: "prd.json" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("BLOCKED T1"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("stopping on blocked"));
    expect(mSetReporter).toHaveBeenCalledWith(null);
    expect(mGit).not.toHaveBeenCalled(); // no init: commit_per_task && review_after both false
  });

  it("review failure blocks immediately without consuming task retries", async () => {
    mRunTask.mockResolvedValue({ ok: false, reason: "review_changes", verificationPassed: true });
    await runLoop({ prd: "prd.json" });
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const saved = JSON.parse(writes[writes.length - 1]);
    expect(saved.tasks[0]).toMatchObject({ status: "blocked", retries: 0 });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("review requested changes"));
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("retry 1"));
  });

  it("reports a stalled-review reason and compacts long reviewer feedback", async () => {
    const feedback = "x".repeat(300);
    mRunTask.mockResolvedValue({ ok: false, reason: "review_stalled", reviewChanges: feedback, verificationPassed: true });
    await runLoop({ prd: "prd.json" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("review loop stalled"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("…"));
  });

  it("retries review failures with the reason when reviewer feedback is empty", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "retry" });
    mMount.mockReturnValue(handle);
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValue(null);
    mRunTask.mockResolvedValueOnce({ ok: false, reason: "review_changes", reviewChanges: "" }).mockResolvedValueOnce({ ok: true });

    await runLoop({ prd: "prd.json" });

    expect(mRunTask.mock.calls[1][6]).toContain("review requested changes");
  });

  it("does not report a commit hash when HEAD is unchanged", async () => {
    mHeadCommit.mockReturnValue("same-commit");
    await runLoop({ prd: "prd.json" });
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("committed —"));
  });

  it("reports the hash when the automatic task commit advances HEAD", async () => {
    mHeadCommit
      .mockReturnValueOnce("before") // task start
      .mockReturnValueOnce("before") // task end
      .mockReturnValueOnce("before") // commit before
      .mockReturnValueOnce("after"); // commit after
    await runLoop({ prd: "prd.json" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("after"));
  });

  it("TTY review failure can be accepted by the user and committed as done", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "approve" });
    mMount.mockReturnValue(handle);
    mRunTask.mockResolvedValue({ ok: false, reason: "review_changes", verificationPassed: true });
    await runLoop({ prd: "prd.json" });
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const saved = JSON.parse(writes[writes.length - 1]);
    expect(saved.tasks[0]).toMatchObject({ status: "done", retries: 0 });
    expect(handle.waitReviewBlocked).toHaveBeenCalledWith(expect.any(String), true);
    expect(mGit).toHaveBeenCalledWith(expect.any(String), "commit", "-m", expect.stringContaining("T1"));
  });

  it("does not allow accepting a rejected review when verification failed", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "approve" });
    mMount.mockReturnValue(handle);
    mRunTask.mockResolvedValue({ ok: false, reason: "review_exhausted", verificationPassed: false });

    await runLoop({ prd: "prd.json" });

    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const saved = JSON.parse(writes[writes.length - 1]);
    expect(saved.tasks[0]).toMatchObject({ status: "blocked", retries: 0 });
    expect(handle.waitReviewBlocked).toHaveBeenCalledWith(expect.any(String), false);
  });

  it("TTY review retry passes reviewer feedback into the next runTask call", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "retry" });
    mMount.mockReturnValue(handle);
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValue(null);
    mRunTask
      .mockResolvedValueOnce({ ok: false, reason: "review_changes", reviewChanges: "fix the typecheck gate" })
      .mockResolvedValueOnce({ ok: true });

    await runLoop({ prd: "prd.json" });

    expect(mRunTask).toHaveBeenCalledTimes(2);
    expect(mRunTask.mock.calls[1][6]).toBe("fix the typecheck gate");
    expect(mRunTask.mock.calls[0][7]).toBe("base-tree");
    expect(mRunTask.mock.calls[1][7]).toBe("base-tree");
    expect(mCaptureReviewBase).toHaveBeenCalledTimes(1);
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("retry review feedback"));
  });

  it("reviews from the task-start commit and reports a commit made during execution", async () => {
    mLoadConfig.mockReturnValue(cfg({ commit_per_task: false }));
    mHeadCommit.mockReturnValueOnce("before-commit").mockReturnValueOnce("after-commit");

    await runLoop({ prd: "prd.json" });

    expect(mRunTask.mock.calls[0][7]).toBe("base-tree");
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("after-commit"));
  });

  it("--task found → runs then returns (no commit when commit_per_task false)", async () => {
    mLoadConfig.mockReturnValue(cfg({ commit_per_task: false }));
    await runLoop({ prd: "prd.json", task: "T1" });
    expect(mFindTask).toHaveBeenCalled();
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("DONE T1"));
    expect(mGit).not.toHaveBeenCalledWith(expect.any(String), "commit", "-m", expect.anything());
  });

  it("--task not found → exits", async () => {
    mFindTask.mockReturnValue(null);
    await expect(runLoop({ prd: "prd.json", task: "X" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("no task X"));
  });
});

describe("runLoop TTY dashboard", () => {
  it("opens configuration while paused, remounts, and resumes with the new agents", async () => {
    fastTimers();
    setTTY(true);
    const first = makeHandle();
    first.waitConfigOrResume = vi.fn().mockResolvedValueOnce("config").mockResolvedValueOnce("resume");
    const second = makeHandle();
    mMount.mockReturnValueOnce(first).mockReturnValueOnce(second);
    mPickModel.mockResolvedValueOnce("cursor:composer-2.5").mockResolvedValueOnce("none");
    mParseAgent.mockImplementation((spec) => {
      if (spec === "none") return null;
      const [cli, model = ""] = String(spec).split(":", 2);
      return { cli, model };
    });

    await runLoop({ prd: "prd.json" });

    expect(first.unmount).toHaveBeenCalled();
    expect(mMount).toHaveBeenCalledTimes(2);
    expect(mRunTask.mock.calls[0][2].executor).toEqual({ cli: "cursor", model: "composer-2.5" });
  });

  it("falls back to the initial PRD snapshot when reloading after paused configuration fails", async () => {
    fastTimers();
    setTTY(true);
    const first = makeHandle();
    first.waitConfigOrResume = vi.fn().mockResolvedValueOnce("config").mockResolvedValueOnce("resume");
    mMount.mockReturnValueOnce(first).mockReturnValueOnce(makeHandle());
    mPickModel.mockResolvedValueOnce("claude:sonnet").mockResolvedValueOnce("claude:fable");
    mRead.mockReturnValueOnce(PRD_JSON).mockReturnValue("{broken");

    await runLoop({ prd: "prd.json" });

    expect(mMount).toHaveBeenCalledTimes(2);
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("unreadable mid-run"));
  });

  it("retries every blocked task when the queue is stalled", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle();
    handle.waitStalled = vi.fn().mockResolvedValueOnce("retry").mockResolvedValueOnce("quit");
    mMount.mockReturnValue(handle);
    const blocked = { ...TASK, status: "blocked", retries: 2 };
    mRead.mockReturnValue(JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks: [blocked] }));
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(null).mockReturnValueOnce(TASK as never).mockReturnValue(null);

    await runLoop({ prd: "prd.json" });

    expect(handle.waitStalled).toHaveBeenCalled();
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("retrying blocked tasks"));
  });

  it("mounts TUI, routes reporter lines + skip signal, unmounts on all-done", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle();
    mMount.mockReturnValue(handle);
    // capture the reporter and fire a line mid-task (curTaskId is set by then)
    let reporter: ((line: string) => void) | null = null;
    mSetReporter.mockImplementation((r) => {
      reporter = r;
    });
    mRunTask.mockImplementation(async () => {
      reporter?.("mid");
      return { ok: true };
    });
    await runLoop({ prd: "prd.json" });
    expect(mMount).toHaveBeenCalledWith(
      [{ id: "T1", title: "Task one", status: "todo" }],
      "P — exec: claude:sonnet | adv: claude:fable",
      "P",
    );
    // reporter routed into the TUI as an event carrying the current task id
    expect(handle.update).toHaveBeenCalledWith({ taskId: "T1", line: "mid", lineSource: "system" });
    // per-task abort signal came from the handle
    expect(mRunTask).toHaveBeenCalledWith(TASK, expect.anything(), expect.anything(), expect.any(String), expect.any(String), SIG, undefined, "base-tree");
    expect(handle.control.takeSkip).toHaveBeenCalled();
    expect(handle.unmount).toHaveBeenCalled();
  });

  it("quit → unmounts and stops before running a task", async () => {
    setTTY(true);
    const handle = makeHandle({ shouldQuit: true });
    mMount.mockReturnValue(handle);
    await runLoop({ prd: "prd.json" });
    expect(handle.waitConfigOrResume).toHaveBeenCalled();
    expect(mRunTask).not.toHaveBeenCalled();
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("quit by user"));
    expect(handle.unmount).toHaveBeenCalled();
  });

  it("quits from the review decision dialog without changing task state", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "quit" });
    mMount.mockReturnValue(handle);
    mRunTask.mockResolvedValue({ ok: false, reason: "review_exhausted", verificationPassed: true });

    await runLoop({ prd: "prd.json" });

    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("quit by user"));
  });

  it("accepts a verified review failure for a single requested task", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "approve" });
    mMount.mockReturnValue(handle);
    mRunTask.mockResolvedValue({ ok: false, reason: "review_exhausted", verificationPassed: true });

    await runLoop({ prd: "prd.json", task: "T1" });

    expect(handle.unmount).toHaveBeenCalled();
    expect(mGit).toHaveBeenCalledWith(expect.any(String), "commit", "-m", expect.stringContaining("T1"));
  });

  it("skip → marks task blocked (skipped by user) and continues", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ takeSkip: true });
    mMount.mockReturnValue(handle);
    await runLoop({ prd: "prd.json" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("SKIPPED T1"));
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const saved = JSON.parse(writes[writes.length - 1]);
    expect(saved.tasks[0]).toMatchObject({ status: "blocked", retries: 0 });
    expect(mGit).not.toHaveBeenCalledWith(expect.any(String), "commit", "-m", expect.anything());
    expect(handle.unmount).toHaveBeenCalled();
  });

  it("quit pressed mid-task → exits after runTask without munging status", async () => {
    setTTY(true);
    const handle = makeHandle();
    // false at loop top (task runs), true after runTask (mid-task quit fires)
    handle.control.shouldQuit = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    mMount.mockReturnValue(handle);
    await runLoop({ prd: "prd.json" });
    expect(mRunTask).toHaveBeenCalled();
    const logs = mLog.mock.calls.map((c) => c[1]).join("\n");
    expect(logs).toContain("quit by user");
    expect(logs).not.toContain("DONE T1"); // interrupted task not marked done
    expect(handle.unmount).toHaveBeenCalled();
  });

  it("prd.json corrupted before the loop-top reload → graceful stop, no task run", async () => {
    setTTY(true);
    const handle = makeHandle();
    mMount.mockReturnValue(handle);
    // preflight read is valid; the per-iteration reload throws (non-Error branch)
    mRead.mockReturnValueOnce(PRD_JSON).mockImplementation(() => {
      throw "io-error";
    });
    await runLoop({ prd: "prd.json" });
    expect(mRunTask).not.toHaveBeenCalled();
    const logs = mLog.mock.calls.map((c) => c[1]).join("\n");
    expect(logs).toContain("unreadable mid-run");
    expect(handle.unmount).toHaveBeenCalled();
  });

  it("prd.json corrupted after the task ran → graceful stop, status write skipped", async () => {
    setTTY(true);
    const handle = makeHandle();
    mMount.mockReturnValue(handle);
    // preflight + loop-top reads valid; the post-task fresh reload gets garbage
    mRead.mockReturnValueOnce(PRD_JSON).mockReturnValueOnce(PRD_JSON).mockReturnValue("{garbage");
    await runLoop({ prd: "prd.json" });
    expect(mRunTask).toHaveBeenCalled();
    const logs = mLog.mock.calls.map((c) => c[1]).join("\n");
    expect(logs).toContain("unreadable mid-run");
    expect(logs).not.toContain("DONE T1"); // iteration failed before the status write
    expect(handle.unmount).toHaveBeenCalled();
  });

  it("shape-invalid prd.json mid-run (valid JSON) → graceful stop, never reaches runTask", async () => {
    setTTY(true);
    const handle = makeHandle();
    mMount.mockReturnValue(handle);
    // preflight read is valid; the per-iteration reload gets a tasks-less object
    mRead.mockReturnValueOnce(PRD_JSON).mockReturnValue(JSON.stringify({ project: "P" }));
    await runLoop({ prd: "prd.json" });
    expect(mRunTask).not.toHaveBeenCalled();
    const logs = mLog.mock.calls.map((c) => c[1]).join("\n");
    expect(logs).toContain("unreadable mid-run");
    expect(handle.unmount).toHaveBeenCalled();
  });

  it("task removed from prd.json mid-run → graceful stop instead of a raw throw", async () => {
    setTTY(true);
    const handle = makeHandle();
    mMount.mockReturnValue(handle);
    const without = JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks: [{ ...TASK, id: "T2" }] });
    // preflight + loop-top valid with T1; the post-task fresh reload lost T1
    mRead.mockReturnValueOnce(PRD_JSON).mockReturnValueOnce(PRD_JSON).mockReturnValue(without);
    await runLoop({ prd: "prd.json" });
    expect(mRunTask).toHaveBeenCalled();
    const logs = mLog.mock.calls.map((c) => c[1]).join("\n");
    expect(logs).toContain("disappeared");
    expect(logs).not.toContain("DONE T1"); // no status write for a vanished task
    expect(handle.unmount).toHaveBeenCalled();
  });

  it("skip continues even when stop_on_blocked is true", async () => {
    fastTimers();
    setTTY(true);
    mLoadConfig.mockReturnValue(cfg({ stop_on_blocked: true }));
    const handle = makeHandle({ takeSkip: true });
    mMount.mockReturnValue(handle);
    await runLoop({ prd: "prd.json" });
    const logs = mLog.mock.calls.map((c) => c[1]).join("\n");
    expect(logs).toContain("SKIPPED T1");
    expect(logs).not.toContain("stopping on blocked task"); // skip overrides the gate
    expect(handle.unmount).toHaveBeenCalled();
  });
});
