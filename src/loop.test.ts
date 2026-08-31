// loop.test.ts — covers runLoop: preflight gates, dry-run, task lifecycle,
// and the TTY Ink dashboard wiring (mount/control/reporter) vs non-TTY fallback.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

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
// findTask/nextTask/readyTasks are driven per-test; sessionRunnableIds (pure)
// runs REAL so the browser-preflight scope reflects the actual dependency closure.
vi.mock("./prd.js", async (importActual) => {
  const actual = await importActual<typeof import("./prd.js")>();
  return { findTask: vi.fn(), nextTask: vi.fn(), readyTasks: vi.fn(), sessionRunnableIds: actual.sessionRunnableIds };
});
vi.mock("./log.js", () => ({ log: vi.fn(), setReporter: vi.fn() }));
vi.mock("./git.js", () => ({
  git: vi.fn(),
  gitOut: vi.fn(() => null),
  headCommit: vi.fn(() => null),
  captureReviewBase: vi.fn(() => "base-tree"),
  taskChangedPaths: vi.fn(() => ["src/a.ts"]),
  preserveWorkAsRef: vi.fn(() => null),
  commitPaths: vi.fn(() => true),
  commitAllExcept: vi.fn(() => true),
}));
// worktree.js is real git plumbing — proven against real repositories in
// git.integration.test.ts. Here it is a seam, so the loop's routing (degrade to
// serial, conflict → retry ladder, discard on every exit) is drivable.
vi.mock("./worktree.js", () => ({
  createTaskWorktree: vi.fn(() => "/ws/.ralphrun/worktrees/T1"),
  mergeBackTaskWork: vi.fn(() => ({ status: "ok", head: "wt-head" })),
  removeTaskWorktree: vi.fn(),
  reapOrphanWorktrees: vi.fn(() => 0),
  worktreeLoss: vi.fn(() => ({ head: null, dirty: false })),
  // false = this filesystem clones, so cells are isolated and there is no hazard
  ignoredDirsWouldBeShared: vi.fn(() => false),
  // by default every configured link exists in the workspace — the filter is
  // exercised on its own below, and in the real thing by git.integration.test.ts
  linkedDirsPresent: vi.fn((_ws: string, links: string[]) => links),
  tasksInstallingDeps: vi.fn(() => []),
  // the same detector, asked about worktree_setup instead of a task's verify.
  // What counts as an install is tested for real in prd.test.ts; here it is a
  // seam, so the refusal can be driven without re-stating the tokeniser.
  verifyInstallsDeps: vi.fn(() => false),
  // null = the workspace was free
  claimRunLock: vi.fn(() => null),
  releaseRunLock: vi.fn(),
}));
vi.mock("./run.js", () => ({ runTask: vi.fn() }));
// the JIT-expansion hook must never spawn a REAL advisor here: fixtures are
// skeletal tasks and the config carries an advisor, so without this stub the
// hook would launch an actual cli process mid-loop-test.
vi.mock("./expand.js", () => ({ isSkeletonTask: vi.fn(() => false), expandSkeletonTask: vi.fn(async () => null) }));
// the wave integration gate shells out for real otherwise — every existing wave
// test happens to have tasks with no verify, which is exactly the case that skips
vi.mock("./verify.js", () => ({ runVerifyCommand: vi.fn(async () => ({ passed: true, output: "" })) }));
// only the key is stubbed — invalidatePlan is pure, and the stall tests are
// about the plan actually leaving prd.json, not about a spy having been called
vi.mock("./plan-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plan-cache.js")>()),
  advisorPlanKey: vi.fn(() => "plan-key"),
}));
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
import { findTask, nextTask, readyTasks } from "./prd.js";
import { log, setReporter } from "./log.js";
import { git, headCommit, captureReviewBase, taskChangedPaths, commitPaths, commitAllExcept } from "./git.js";
import {
  claimRunLock,
  createTaskWorktree,
  ignoredDirsWouldBeShared,
  linkedDirsPresent,
  mergeBackTaskWork,
  reapOrphanWorktrees,
  releaseRunLock,
  removeTaskWorktree,
  tasksInstallingDeps,
  verifyInstallsDeps,
  worktreeLoss,
} from "./worktree.js";
import { runTask } from "./run.js";
import { expandSkeletonTask } from "./expand.js";
import { runVerifyCommand } from "./verify.js";
import { advisorPlanKey } from "./plan-cache.js";
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
const prdWith = (tasks: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks, ...over });
const BROWSER_PRD = prdWith([browserTask()]);

const mExists = vi.mocked(existsSync);
const mRead = vi.mocked(readFileSync);
const mWrite = vi.mocked(writeFileSync);
const mLoadConfig = vi.mocked(loadConfig);
const mParseAgent = vi.mocked(parseAgent);
const mCheckAgent = vi.mocked(checkAgent);
const mFindTask = vi.mocked(findTask);
const mNextTask = vi.mocked(nextTask);
const mReadyTasks = vi.mocked(readyTasks);
const mLog = vi.mocked(log);
const mSetReporter = vi.mocked(setReporter);
const mGit = vi.mocked(git);
const mHeadCommit = vi.mocked(headCommit);
const mCaptureReviewBase = vi.mocked(captureReviewBase);
const mTaskChangedPaths = vi.mocked(taskChangedPaths);
const mCommitPaths = vi.mocked(commitPaths);
const mCommitAllExcept = vi.mocked(commitAllExcept);
const mCreateWorktree = vi.mocked(createTaskWorktree);
const mMergeBack = vi.mocked(mergeBackTaskWork);
const mReapWorktrees = vi.mocked(reapOrphanWorktrees);
const mRemoveWorktree = vi.mocked(removeTaskWorktree);
const mWorktreeLoss = vi.mocked(worktreeLoss);
const mDepsShared = vi.mocked(ignoredDirsWouldBeShared);
const mLinksPresent = vi.mocked(linkedDirsPresent);
const mClaimLock = vi.mocked(claimRunLock);
const mReleaseLock = vi.mocked(releaseRunLock);
const mTasksInstalling = vi.mocked(tasksInstallingDeps);
const mSetupInstalls = vi.mocked(verifyInstallsDeps);
const mRunTask = vi.mocked(runTask);
const mExpandSkeletonTask = vi.mocked(expandSkeletonTask);
const mVerifyCmd = vi.mocked(runVerifyCommand);
const mAdvisorPlanKey = vi.mocked(advisorPlanKey);
const mMount = vi.mocked(mount);
const mPickModel = vi.mocked(pickModel);
const mSelect = vi.mocked(select);
const mIsCancel = vi.mocked(isCancel);

// the default for tests that are not about money: a metered run that spent nothing
const NO_COST = { usd: 0, unknown: false };

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
      endTask: vi.fn(),
    },
    waitConfigOrResume: vi.fn(async () => "resume"),
    waitStalled: vi.fn(async () => "quit"),
    waitReviewBlocked: vi.fn(async () => over.reviewAction ?? "block"),
    unmount: vi.fn(),
  } as unknown as Handle;
}

/** the whole prd.json as last written — architecture_notes is not a task field */
function livePrdRaw(): () => { architecture_notes: string } {
  let content = PRD_JSON;
  mRead.mockImplementation(() => content);
  mWrite.mockImplementation((p, data) => {
    if (String(p).endsWith("prd.json")) content = String(data);
  });
  return () => JSON.parse(content);
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

// existsSync flags
let prdExists: boolean, progressExists: boolean, gitExists: boolean;
let commitSequence = 0;

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
  // The loop schedules off readyTasks now. Every pre-existing test drives ONE
  // task at a time through mNextTask, so keep that seam and let the set-returning
  // picker delegate to it; the wave tests below override mReadyTasks directly.
  mReadyTasks.mockImplementation(((p: never) => {
    const one = mNextTask(p);
    return one ? [one] : [];
  }) as never);
  mFindTask.mockReturnValue(TASK as never);
  mRunTask.mockResolvedValue({ ok: true, cost: NO_COST });
  mHeadCommit.mockReset();
  mHeadCommit.mockReturnValue(null);
  commitSequence = 0;
  mGit.mockReset();
  mGit.mockReturnValue(null);
  mCaptureReviewBase.mockReturnValue("base-tree");
  mTaskChangedPaths.mockReturnValue(["src/a.ts"]);
  // A successful commit advances HEAD for the metadata commit as well. Tests
  // that model a hook refusal override this implementation explicitly.
  mCommitPaths.mockReset();
  mCommitPaths.mockImplementation((_workspace, paths) => {
    // Only the new metadata commit needs to be represented as a new HEAD in
    // these loop seams. Task-code commit hash tests configure HEAD explicitly.
    commitSequence += 1;
    mHeadCommit.mockReturnValue((paths as string[]).includes("prd.json") ? `prd-committed-${commitSequence}` : `task-committed-${commitSequence}`);
    return true;
  });
  mCommitAllExcept.mockReset();
  mCommitAllExcept.mockReturnValue(true);
  mCreateWorktree.mockReturnValue("/ws/.ralphrun/worktrees/T1");
  mMergeBack.mockReturnValue({ status: "ok", head: "wt-head" });
  mReapWorktrees.mockReturnValue(0);
  mWorktreeLoss.mockReturnValue({ head: null, dirty: false });
  mDepsShared.mockReturnValue(false);
  mLinksPresent.mockImplementation((_ws: string, links: string[]) => links);
  mTasksInstalling.mockReturnValue([]);
  mSetupInstalls.mockReturnValue(false);
  mVerifyCmd.mockResolvedValue({ passed: true, output: "" });
  mClaimLock.mockReturnValue(null);
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
  // A plan is written before the tree exists, so a missing scope directory is
  // usually the task's own output. Refusing the run stopped every greenfield
  // plan on its first task; the executor is told to create them instead.
  it("records a missing literal scope parent and still runs the task", async () => {
    fastTimers();
    mRead.mockReturnValue(
      prdWith([
        {
          ...TASK,
          scope: ["apps/api/src/modules/auth/**", "apps/api/src/db/schema/users.ts"],
        },
      ]),
    );
    mExists.mockImplementation((pth) => {
      const p = String(pth).replace(/\\/g, "/");
      if (p.endsWith("progress.md") || p.endsWith("prd.json") || p.endsWith("/.git")) return true;
      return !p.includes("apps/api/src/db");
    });

    await runLoop({ prd: "prd.json" });
    expect(mLog).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("apps/api/src/db/"));
    expect(mRunTask).toHaveBeenCalled();
  });

  it("allows a recursive scope to create its missing leaf directory", async () => {
    fastTimers();
    mRead.mockReturnValue(prdWith([{ ...TASK, scope: ["apps/api/src/modules/auth/**"] }]));
    mExists.mockImplementation((pth) => {
      const p = String(pth).replace(/\\/g, "/");
      if (p.endsWith("progress.md") || p.endsWith("prd.json") || p.endsWith("/.git")) return true;
      return !p.endsWith("/apps/api/src/modules/auth");
    });

    await runLoop({ prd: "prd.json" });
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("scope"));
    expect(mRunTask).toHaveBeenCalled();
  });

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
  it("blocks an incompatible task before worktree, expansion, advisor, or executor", async () => {
    fastTimers();
    const requiredHost = process.platform === "win32" ? "darwin" : "win32";
    const hostTask = { ...TASK, required_host: requiredHost };
    mRead.mockReturnValue(prdWith([hostTask]));
    mNextTask.mockReset();
    mNextTask.mockReturnValue(hostTask as never);
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true, stop_on_blocked: true }));
    mHeadCommit.mockReturnValue("base");

    await runLoop({ prd: "prd.json" });

    expect(mCreateWorktree).not.toHaveBeenCalled();
    expect(mExpandSkeletonTask).not.toHaveBeenCalled();
    expect(mRunTask).not.toHaveBeenCalled();
    expect(mWrite).toHaveBeenLastCalledWith(expect.stringContaining("prd.json"), expect.stringContaining('"status": "blocked"'));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(`required_host=${requiredHost}`));
  });
  it("done → commit; inits git; writes missing progress; no TUI; overrides", async () => {
    fastTimers();
    gitExists = false; // trigger git init
    progressExists = false; // trigger progress write
    await runLoop({ prd: "prd.json", executor: "claude:sonnet", advisor: "claude:fable", noReviewAfter: true });
    expect(mParseAgent).toHaveBeenCalled();
    expect(mMount).not.toHaveBeenCalled(); // non-TTY: no dashboard
    expect(mRunTask).toHaveBeenCalledWith(TASK, expect.anything(), expect.anything(), expect.any(String), expect.any(String), undefined, undefined, "base-tree", expect.any(Function), undefined, expect.objectContaining({ RALPHRUN_TASK_ID: "T1" }));
    expect(mGit).toHaveBeenCalledWith(expect.any(String), "init");
    // scoped to the task's own paths, so a file the user already had dirty is
    // never swept into a commit named after this task
    expect(mTaskChangedPaths).toHaveBeenCalledWith(expect.any(String), "base-tree", expect.any(Array));
    expect(mCommitPaths).toHaveBeenCalledWith(expect.any(String), ["src/a.ts"], expect.stringContaining("T1"));
    expect(mGit).not.toHaveBeenCalledWith(expect.any(String), "add", "-A");
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("DONE T1"));
    expect(mSetReporter).toHaveBeenLastCalledWith(null); // cleaned up on exit
  });

  it("blocks a serial task when its code commit is refused before the PRD commit", async () => {
    fastTimers();
    mHeadCommit.mockReturnValue("base-sha");
    mCommitPaths.mockImplementation((_workspace, paths) => !paths.includes("src/a.ts"));
    mCommitAllExcept.mockReturnValue(true);

    await runLoop({ prd: "prd.json", executor: "claude:sonnet", advisor: "claude:fable", noReviewAfter: true });

    const saved = JSON.parse(mWrite.mock.calls.at(-1)![1] as string);
    expect(saved.tasks[0].status).toBe("blocked");
    expect(mCommitPaths).not.toHaveBeenCalledWith(expect.any(String), ["prd.json"], expect.stringContaining("chore(prd)"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("PRD status commit"));
  });

  it("done → commit; falls back to default template when commit_message_template is empty", async () => {
    fastTimers();
    mLoadConfig.mockReturnValue(cfg({ commit_message_template: "" })); // Falsy forces fallback
    mRunTask.mockResolvedValueOnce({ ok: true, cost: NO_COST });
    mHeadCommit.mockReturnValueOnce("aaaa").mockReturnValueOnce("bbbb");
    await runLoop({ prd: "prd.json", executor: "claude:sonnet", advisor: "claude:fable", noReviewAfter: true });
    expect(mCommitPaths).toHaveBeenCalledWith(expect.any(String), ["src/a.ts"], "T1: Task one");
  });

  it("uses a valid reviewer commit proposal for an automatic commit", async () => {
    fastTimers();
    mRunTask.mockResolvedValueOnce({
      ok: true,
      cost: NO_COST,
      commit: { type: "fix", scope: "review", subject: "handle rejected input" },
    });
    await runLoop({ prd: "prd.json", executor: "claude:sonnet", advisor: "grok:g" });
    expect(mCommitPaths).toHaveBeenCalledWith(expect.any(String), ["src/a.ts"], "fix(review): handle rejected input");
  });

  it("skips the commit entirely when the task moved nothing", async () => {
    fastTimers();
    mTaskChangedPaths.mockReturnValue([]);
    await runLoop({ prd: "prd.json", executor: "claude:sonnet", advisor: "claude:fable" });
    expect(mCommitPaths).toHaveBeenCalledWith(expect.any(String), ["prd.json"], expect.stringContaining("chore(prd)"));
    expect(mGit).not.toHaveBeenCalledWith(expect.any(String), "commit", "-m", expect.anything());
  });

  // the executor staged a rename/deletion despite being told not to, so the
  // scoped stage cannot resolve the path — commit everything rather than nothing
  it("falls back to staging everything, loudly, when the scoped commit fails", async () => {
    fastTimers();
    mCommitPaths.mockReturnValue(false);
    await runLoop({ prd: "prd.json", executor: "claude:sonnet", advisor: "claude:fable" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("could not scope"));
    expect(mCommitAllExcept).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.stringContaining("T1"));
  });

  // no baseline (a repo with no commits yet) is not the executor's fault: fall
  // back silently, exactly as this did before commits were scoped
  it("falls back quietly when there is no baseline to scope against", async () => {
    fastTimers();
    mTaskChangedPaths.mockReturnValue(null);
    await runLoop({ prd: "prd.json", executor: "claude:sonnet", advisor: "claude:fable" });
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("could not scope"));
    expect(mCommitAllExcept).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.stringContaining("T1"));
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

  it("blocks after the second attempt with an identical failure signature", async () => {
    fastTimers();
    livePrdRaw();
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValue(null);
    mRunTask
      .mockResolvedValueOnce({ ok: false, reason: "failed", failureSignature: "scope-escape|src/i18n.ts", cost: NO_COST })
      .mockResolvedValueOnce({ ok: false, reason: "failed", failureSignature: "scope-escape|src/i18n.ts", cost: NO_COST });

    await runLoop({ prd: "prd.json" });

    expect(mRunTask).toHaveBeenCalledTimes(2);
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    expect(JSON.parse(writes[writes.length - 1]).tasks[0]).toMatchObject({ status: "blocked", retries: 2 });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("repeated failure signature"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("scope-escape|src/i18n.ts"));
  });

  it("keeps trying when consecutive failure signatures show different progress", async () => {
    fastTimers();
    livePrdRaw();
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValue(null);
    mRunTask
      .mockResolvedValueOnce({ ok: false, reason: "failed", failureSignature: "verify|missing auth", cost: NO_COST })
      .mockResolvedValueOnce({ ok: false, reason: "failed", failureSignature: "verify|missing users", cost: NO_COST })
      .mockResolvedValueOnce({ ok: true, cost: NO_COST });

    await runLoop({ prd: "prd.json" });

    expect(mRunTask).toHaveBeenCalledTimes(3);
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    expect(JSON.parse(writes[writes.length - 1]).tasks[0]).toMatchObject({ status: "done", retries: 2 });
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("repeated failure signature"));
  });

  it("review failure blocks immediately without consuming task retries", async () => {
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });
    await runLoop({ prd: "prd.json" });
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const saved = JSON.parse(writes[writes.length - 1]);
    expect(saved.tasks[0]).toMatchObject({ status: "blocked", retries: 0 });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("review not approved"));
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("retry 1"));
  });

  it("reports a stalled-review reason and compacts long reviewer feedback", async () => {
    const feedback = "x".repeat(300);
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_stalled", reviewChanges: feedback, verificationPassed: true });
    await runLoop({ prd: "prd.json" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("review loop stalled"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("…"));
  });

  // Replan rung of the recovery ladder. The plan key is a pure function of the
  // task, so a retry recomputes the same key and reuses the plan the fix loop
  // just failed with, round after round — the plan has to physically leave
  // prd.json or the next attempt replays it.
  it("drops the cached plan from prd.json when the review stalled", async () => {
    mRead.mockReturnValue(
      JSON.stringify({
        project: "P",
        stack: "S",
        architecture_notes: "A",
        tasks: [{ ...TASK, plan: "the plan that stalled", planKey: "plan-key" }],
      }),
    );
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_stalled", verificationPassed: true });
    await runLoop({ prd: "prd.json" });
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const saved = JSON.parse(writes[writes.length - 1]);
    expect(saved.tasks[0].plan).toBeUndefined();
    expect(saved.tasks[0].planKey).toBeUndefined();
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("plan discarded"));
  });

  // The cache exists to save advisor calls and that is correct on an ordinary
  // retry: only a stall is evidence against the plan itself.
  it("keeps the cached plan when the review merely requested changes", async () => {
    mRead.mockReturnValue(
      JSON.stringify({
        project: "P",
        stack: "S",
        architecture_notes: "A",
        tasks: [{ ...TASK, plan: "a plan worth keeping", planKey: "plan-key" }],
      }),
    );
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });
    await runLoop({ prd: "prd.json" });
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const saved = JSON.parse(writes[writes.length - 1]);
    expect(saved.tasks[0].plan).toBe("a plan worth keeping");
  });

  it("retries review failures with the reason when reviewer feedback is empty", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "retry" });
    mMount.mockReturnValue(handle);
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValue(null);
    mRunTask.mockResolvedValueOnce({ ok: false, cost: NO_COST, reason: "review_exhausted", reviewChanges: "" }).mockResolvedValueOnce({ ok: true, cost: NO_COST });

    await runLoop({ prd: "prd.json" });

    expect(mRunTask.mock.calls[1][6]).toContain("review not approved");
  });

  it("does not report a commit hash when HEAD is unchanged", async () => {
    mHeadCommit.mockReturnValue("same-commit");
    mGit.mockReturnValue(0);
    mCommitPaths.mockReset().mockReturnValue(true);
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
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });
    await runLoop({ prd: "prd.json" });
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const saved = JSON.parse(writes[writes.length - 1]);
    expect(saved.tasks[0]).toMatchObject({ status: "done", retries: 0 });
    expect(handle.waitReviewBlocked).toHaveBeenCalledWith(expect.any(String), true);
    // a user-accepted review commits through the same scoped path as a clean pass
    expect(mCommitPaths).toHaveBeenCalledWith(expect.any(String), ["src/a.ts"], expect.stringContaining("T1"));
  });

  it("does not allow accepting a rejected review when verification failed", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "approve" });
    mMount.mockReturnValue(handle);
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: false });

    await runLoop({ prd: "prd.json" });

    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const saved = JSON.parse(writes[writes.length - 1]);
    expect(saved.tasks[0]).toMatchObject({ status: "blocked", retries: 0 });
    expect(handle.waitReviewBlocked).toHaveBeenCalledWith(expect.any(String), false);
  });

  // The gap this closes: the approval decision used to live inside the `if (tui)`
  // branch, so a headless run had no gate at all — the task went blocked and the
  // run moved on with nothing in the log saying a decision was even made.
  it("headless review block logs the policy that refused it", async () => {
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });
    await runLoop({ prd: "prd.json" });
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    expect(JSON.parse(writes[writes.length - 1]).tasks[0]).toMatchObject({ status: "blocked" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("review_blocked_policy=block"));
  });

  it("headless accept policy marks a verified review-blocked task done and commits it", async () => {
    fastTimers();
    mLoadConfig.mockReturnValue(cfg({ review_blocked_policy: "accept" }));
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });

    await runLoop({ prd: "prd.json" });

    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    expect(JSON.parse(writes[writes.length - 1]).tasks[0]).toMatchObject({ status: "done", retries: 0 });
    // a policy-accepted change commits through the same scoped path as a clean pass
    expect(mCommitPaths).toHaveBeenCalledWith(expect.any(String), ["src/a.ts"], expect.stringContaining("T1"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("headless gate accepted"));
  });

  // The safety property: a policy is allowed to override a REVIEWER, never the
  // objective verify gate. If this ever passes with status done, an unattended
  // run can ship code whose tests failed.
  it("headless accept policy still blocks a task whose verification failed", async () => {
    mLoadConfig.mockReturnValue(cfg({ review_blocked_policy: "accept" }));
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: false });

    await runLoop({ prd: "prd.json" });

    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    expect(JSON.parse(writes[writes.length - 1]).tasks[0]).toMatchObject({ status: "blocked", retries: 0 });
    expect(mCommitPaths).not.toHaveBeenCalled();
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("did not pass"));
  });

  // The TUI owns the decision when there is one, so the policy must not reach in
  // and pre-empt the human it exists to stand in for.
  it("accept policy is ignored on a TTY — the dashboard still asks", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "block" });
    mMount.mockReturnValue(handle);
    mLoadConfig.mockReturnValue(cfg({ review_blocked_policy: "accept" }));
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });

    await runLoop({ prd: "prd.json" });

    expect(handle.waitReviewBlocked).toHaveBeenCalledWith(expect.any(String), true);
    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    expect(JSON.parse(writes[writes.length - 1]).tasks[0]).toMatchObject({ status: "blocked" });
  });

  // The status write re-reads prd.json because the review gate awaits, and an
  // await is long enough for the file to change underneath it. A task that is no
  // longer there gets no status written, rather than being resurrected into a
  // backlog somebody deliberately edited.
  it("writes no status for a task that left prd.json while the gate was open", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle();
    handle.waitReviewBlocked = vi.fn(async () => {
      mRead.mockReturnValue(prdWith([{ ...TASK, id: "T9" }]));
      return "block";
    }) as unknown as Handle["waitReviewBlocked"];
    mMount.mockReturnValue(handle);
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });

    await runLoop({ prd: "prd.json" });

    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const wroteT1Blocked = writes.some((w) =>
      (JSON.parse(w).tasks as { id: string; status: string }[]).some((x) => x.id === "T1" && x.status === "blocked"),
    );
    expect(wroteT1Blocked).toBe(false);
  });

  it("TTY review retry passes reviewer feedback into the next runTask call", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "retry" });
    mMount.mockReturnValue(handle);
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValue(null);
    mRunTask
      .mockResolvedValueOnce({ ok: false, cost: NO_COST, reason: "review_exhausted", reviewChanges: "fix the typecheck gate" })
      .mockResolvedValueOnce({ ok: true, cost: NO_COST });

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

  it("does not create a worktree when worktree_per_task is off", async () => {
    // default-off is the whole reason this ships alone: an existing run must
    // not change shape until the user opts in
    await runLoop({ prd: "prd.json" });
    expect(mCreateWorktree).not.toHaveBeenCalled();
    expect(mRunTask.mock.calls[0][3]).toBe(resolve("."));
  });

  // the reap force-deletes every cell under .ralphrun, so a second run would
  // delete the first one's live worktrees while its executors write into them
  it("refuses to start when another run holds the workspace, naming the pid", async () => {
    mClaimLock.mockReturnValue(4242);
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("4242"));
    expect(mReapWorktrees).not.toHaveBeenCalled();
    expect(mRunTask).not.toHaveBeenCalled();
  });

  // Three passes and no claim is a refusal with NO pid to name: the candidates
  // left are a record the loop positively judged dead and its own pid, so the
  // "another ralphrun (pid N) is already running" line told the user to wait for
  // a process that is not running, or to wait for themselves. Neither is
  // actionable; the file is.
  it("names the lock file, not a fabricated pid, when the lock cannot be claimed at all", async () => {
    mClaimLock.mockReturnValue("unknown");
    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("run.lock"));
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining(String(process.pid)));
    expect(mReapWorktrees).not.toHaveBeenCalled();
    expect(mRunTask).not.toHaveBeenCalled();
  });

  it("releases the workspace even when the run did nothing", async () => {
    mNextTask.mockReset();
    mNextTask.mockReturnValue(null);
    mReadyTasks.mockReturnValue([] as never);
    await runLoop({ prd: "prd.json" });
    // a claim left behind makes the NEXT run diagnose a stale pid instead of
    // just starting
    expect(mReleaseLock).toHaveBeenCalled();
  });

  // A retry gets a brand-new session and, in worktree mode, a workspace where
  // the failed attempt was rolled back. Without the handoff it re-derives the
  // dead ends the last one already paid for.
  it("hands the failed attempt's account to the retry", async () => {
    fastTimers();
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValue(null);
    mRunTask
      .mockResolvedValueOnce({ ok: false, reason: "failed", cost: NO_COST, handoff: "the webhook is unreachable from CI" })
      .mockResolvedValue({ ok: true, cost: NO_COST });

    await runLoop({ prd: "prd.json" });

    expect(mRunTask.mock.calls[1]?.[9]).toBe("the webhook is unreachable from CI");
  });

  // The TUI retry is a second door to the same retry, and it must carry the
  // account too or a user-driven retry starts blinder than an automatic one.
  // The reason is one run.ts can actually return. This used to be pinned on a
  // `review_changes` no producer ever emitted, so it stayed green while the real
  // review-refused path handed over nothing.
  it("hands the account over on a user-chosen review retry as well", async () => {
    fastTimers();
    setTTY(true);
    mMount.mockReturnValue(makeHandle({ reviewAction: "retry" }));
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValue(null);
    mRunTask
      .mockResolvedValueOnce({
        ok: false,
        reason: "review_exhausted",
        verificationPassed: true,
        cost: NO_COST,
        handoff: "tried the cache layer first",
      })
      .mockResolvedValue({ ok: true, cost: NO_COST });

    await runLoop({ prd: "prd.json" });

    expect(mRunTask.mock.calls[1]?.[9]).toBe("tried the cache layer first");
  });

  // architecture_notes is the memory slot that already survives between tasks;
  // this is a run finally writing to it, instead of only a human.
  it("writes a reviewer's durable note into architecture_notes on DONE", async () => {
    fastTimers();
    const read = livePrdRaw();
    mRunTask.mockResolvedValue({ ok: true, cost: NO_COST, note: "the webhook is unreachable from CI" });

    await runLoop({ prd: "prd.json" });

    expect(read().architecture_notes).toContain("## Learned during runs");
    expect(read().architecture_notes).toContain("- T1: the webhook is unreachable from CI");
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("learned"));
  });

  // a task that did not pass every gate has not earned a line in the file that
  // steers every later prompt
  it("writes nothing when the task did not reach done", async () => {
    fastTimers();
    const read = livePrdRaw();
    mRunTask.mockResolvedValue({ ok: false, reason: "failed", cost: NO_COST, note: "should never land" });

    await runLoop({ prd: "prd.json" });

    expect(read().architecture_notes).not.toContain("should never land");
  });

  // silence here would read as "the reviewer never wrote one", which is a
  // different situation and the one the operator would act on differently
  it("says so when a note is dropped as already known", async () => {
    fastTimers();
    mRead.mockReturnValue(
      prdWith([{ ...TASK }], { architecture_notes: "base\n\n## Learned during runs\n- T0: webhook unreachable\n" }),
    );
    mRunTask.mockResolvedValue({ ok: true, cost: NO_COST, note: "webhook unreachable" });

    await runLoop({ prd: "prd.json" });

    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("budget is full or already had it"));
  });

  it("leaves the notes alone when the reviewer wrote none", async () => {
    fastTimers();
    const read = livePrdRaw();
    const before = read().architecture_notes;
    mRunTask.mockResolvedValue({ ok: true, cost: NO_COST });

    await runLoop({ prd: "prd.json" });

    expect(read().architecture_notes).toBe(before);
  });

  it("hands nothing to a FIRST attempt", async () => {
    fastTimers();
    await runLoop({ prd: "prd.json" });
    expect(mRunTask.mock.calls[0]?.[9]).toBeUndefined();
  });

  // a task that passed has nothing to hand anyone, and one that blocked is not
  // about to run again — a leftover account would be stale by the time it did
  it("does not keep an account after the task settled", async () => {
    fastTimers();
    mNextTask.mockReset();
    mNextTask.mockReturnValueOnce(TASK as never).mockReturnValueOnce(TASK as never).mockReturnValue(null);
    mRunTask.mockResolvedValue({ ok: true, cost: NO_COST, handoff: "did the thing" });

    await runLoop({ prd: "prd.json" });

    expect(mRunTask.mock.calls[1]?.[9]).toBeUndefined();
  });

  it("reclaims orphan worktrees at boot even with the feature off", async () => {
    // a crash leaves them behind; turning the feature off afterwards must still
    // clean up, so the reap cannot be gated on the flag
    mReapWorktrees.mockReturnValue(2);
    await runLoop({ prd: "prd.json" });
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("2 orphan worktree"));
  });

  // Two parallel installs into ONE dependency tree corrupt the user's real
  // node_modules, and discarding a worktree cannot undo that. The three
  // conditions have to hold together, so each one alone must let the run start.
  describe("the shared-install refusal", () => {
    const parallelCfg = () => cfg({ worktree_per_task: true, max_parallel_tasks: 2, worktree_link: ["node_modules"] });

    it("refuses when the tree is shared AND a wave task installs, naming the tasks", async () => {
      mLoadConfig.mockReturnValue(parallelCfg());
      mDepsShared.mockReturnValue(true);
      mTasksInstalling.mockReturnValue(["T1", "T4"]);
      await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("T1, T4"));
      expect(mRunTask).not.toHaveBeenCalled();
    });

    it("starts when the filesystem clones, however many tasks install", async () => {
      mLoadConfig.mockReturnValue(parallelCfg());
      mDepsShared.mockReturnValue(false); // cells are isolated: no hazard at all
      mTasksInstalling.mockReturnValue(["T1"]);
      await runLoop({ prd: "prd.json" });
      expect(mRunTask).toHaveBeenCalled();
    });

    it("starts when the tree is shared but nothing installs into it", async () => {
      mLoadConfig.mockReturnValue(parallelCfg());
      mDepsShared.mockReturnValue(true);
      mTasksInstalling.mockReturnValue([]);
      await runLoop({ prd: "prd.json" });
      expect(mRunTask).toHaveBeenCalled();
    });

    it("does not even probe when tasks run one at a time", async () => {
      // serial installs into a shared tree are FINE — they are what the user
      // would have run by hand — so the probe is wasted work, not just harmless
      mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true, worktree_link: ["node_modules"] }));
      mTasksInstalling.mockReturnValue(["T1"]);
      await runLoop({ prd: "prd.json" });
      expect(mDepsShared).not.toHaveBeenCalled();
      expect(mRunTask).toHaveBeenCalled();
    });

    it("does not probe when nothing is seeded into the cells", async () => {
      mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true, max_parallel_tasks: 2, worktree_link: [] }));
      mTasksInstalling.mockReturnValue(["T1"]);
      await runLoop({ prd: "prd.json" });
      expect(mDepsShared).not.toHaveBeenCalled();
    });

    // CONFIGURED is not SHARED. A cell gets nothing seeded for a directory the
    // workspace does not have, so on a checkout with no node_modules every cell
    // installs a tree of its very own — and refusing on the configured list
    // alone rejected exactly the shape Windows users are told to adopt.
    it("starts when the configured links are not in the workspace yet", async () => {
      mLoadConfig.mockReturnValue(cfg({ ...parallelCfg(), worktree_setup: "npm ci" }));
      mLinksPresent.mockReturnValue([]);
      mSetupInstalls.mockReturnValue(true);
      mTasksInstalling.mockReturnValue(["T1"]);

      await runLoop({ prd: "prd.json" });

      expect(mDepsShared).not.toHaveBeenCalled(); // nothing to share: not even worth probing
      expect(mRunTask).toHaveBeenCalled();
    });

    it("still refuses over the linked directory that IS there, and names only that one", async () => {
      mLoadConfig.mockReturnValue(
        cfg({ worktree_per_task: true, max_parallel_tasks: 2, worktree_link: ["node_modules", ".venv"] }),
      );
      mLinksPresent.mockReturnValue([".venv"]); // the Python case, on a checkout that never ran npm
      mDepsShared.mockReturnValue(true);
      mTasksInstalling.mockReturnValue(["T1"]);

      await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");

      const msg = String(errSpy.mock.calls.at(-1)?.[0]);
      expect(msg).toContain(".venv");
      // naming a directory that is not even there sends the user emptying the
      // wrong half of worktree_link and hitting the same refusal again
      expect(msg).not.toContain("node_modules");
    });

    // worktree_setup is the STRICTLY WORSE shape of the same hazard: it runs in
    // every cell, so leaving worktree_link populated alongside it means an
    // install into the one shared tree from every task at once — with a backlog
    // whose verify is a blameless `npm test`. Inspecting task verify commands
    // alone sailed straight past it.
    it("refuses when worktree_setup installs into the shared tree, however innocent the tasks are", async () => {
      mLoadConfig.mockReturnValue(cfg({ ...parallelCfg(), worktree_setup: "npm ci" }));
      mDepsShared.mockReturnValue(true);
      mTasksInstalling.mockReturnValue([]); // every verify is "npm test"
      mSetupInstalls.mockReturnValue(true);

      await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");

      expect(mSetupInstalls).toHaveBeenCalledWith("npm ci");
      const msg = String(errSpy.mock.calls.at(-1)?.[0]);
      // it names the knob and the fix, not a list of task ids — the hazard is
      // not any task's doing, and pointing at ids sends the user editing prd.json
      expect(msg).toContain("worktree_setup");
      expect(msg).toContain("npm ci");
      expect(msg).toContain("worktree_link");
      expect(mRunTask).not.toHaveBeenCalled();
    });

    it("starts when worktree_setup is set but installs nothing", async () => {
      mLoadConfig.mockReturnValue(cfg({ ...parallelCfg(), worktree_setup: "npm run codegen" }));
      mDepsShared.mockReturnValue(true);
      mSetupInstalls.mockReturnValue(false);
      await runLoop({ prd: "prd.json" });
      expect(mRunTask).toHaveBeenCalled();
    });

    it("is fine with an installing worktree_setup once worktree_link is empty", async () => {
      // the documented way OUT of the refusal, and on Windows the only one:
      // nothing is seeded, so each cell installs a tree of its very own and
      // there is nothing shared left to corrupt
      mLoadConfig.mockReturnValue(
        cfg({ worktree_per_task: true, max_parallel_tasks: 2, worktree_link: [], worktree_setup: "npm ci" }),
      );
      mDepsShared.mockReturnValue(true);
      mSetupInstalls.mockReturnValue(true);
      await runLoop({ prd: "prd.json" });
      expect(mRunTask).toHaveBeenCalled();
    });

    it("still names the tasks when it is their verify that installs, not the setup", async () => {
      // the pre-existing refusal has to keep its own message: the two hazards
      // have different fixes, so one merged error would misdirect half of them
      mLoadConfig.mockReturnValue(cfg({ ...parallelCfg(), worktree_setup: "npm run codegen" }));
      mDepsShared.mockReturnValue(true);
      mSetupInstalls.mockReturnValue(false);
      mTasksInstalling.mockReturnValue(["T1", "T4"]);

      await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("exit:1");

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("T1, T4"));
    });
  });

  it("runs the task inside its worktree and cherry-picks the result back", async () => {
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
    mHeadCommit.mockReturnValue("base-sha");

    await runLoop({ prd: "prd.json" });

    expect(mRunTask.mock.calls[0][3]).toBe("/ws/.ralphrun/worktrees/T1");
    expect(mCaptureReviewBase).toHaveBeenCalledWith("/ws/.ralphrun/worktrees/T1");
    // the commit is the TRANSPORT: it happens in the cell, the pick brings it home
    expect(mCommitPaths).toHaveBeenCalledWith("/ws/.ralphrun/worktrees/T1", ["src/a.ts"], "T1: Task one");
    expect(mMergeBack).toHaveBeenCalledWith(resolve("."), "/ws/.ralphrun/worktrees/T1", "base-sha");
    expect(mRemoveWorktree).toHaveBeenCalledWith(resolve("."), "/ws/.ralphrun/worktrees/T1");
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("DONE T1"));
  });

  it("degrades to the main workspace when no worktree can be made", async () => {
    // no repo or no commit yet: infrastructure trouble is not something a retry
    // of the task could ever fix, so it must not cost the task an attempt
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
    mCreateWorktree.mockReturnValue(null);

    await runLoop({ prd: "prd.json" });

    expect(mRunTask.mock.calls[0][3]).toBe(resolve("."));
    expect(mMergeBack).not.toHaveBeenCalled();
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("no worktree available"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("DONE T1"));
  });
  describe("worktree_setup", () => {
    const setupCfg = (cmd: string) => cfg({ worktree_per_task: true, worktree_setup: cmd });

    it("runs the setup command inside the cell, before the executor starts", async () => {
      mLoadConfig.mockReturnValue(setupCfg("bun install"));

      await runLoop({ prd: "prd.json" });

      expect(mVerifyCmd).toHaveBeenCalledWith(
        "bun install",
        expect.stringContaining("T1"),
        "/ws/.ralphrun/worktrees/T1", // the CELL, never the workspace
        expect.any(String),
        undefined, // no TTY here, so there is no control to pass through
        // the TASK's environment, exactly as the executor and the verify gate
        // get it: a lifecycle script that names a scratch database from
        // TEST_DB_SUFFIX must not name the same one from every cell in a wave
        expect.objectContaining({ RALPHRUN_TASK_ID: "T1", TEST_DB_SUFFIX: expect.stringContaining("T1") }),
      );
      // ORDER is the point, not just the call: the executor works in this cell
      // too, so a setup that ran after it would hand the agent a tree with no
      // dependencies — it could not build the project it was asked to change.
      expect(mVerifyCmd.mock.invocationCallOrder[0]).toBeLessThan(mRunTask.mock.invocationCallOrder[0]);
      expect(mRunTask.mock.calls[0][3]).toBe("/ws/.ralphrun/worktrees/T1");
    });

    it("runs nothing when it is unset", async () => {
      mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
      await runLoop({ prd: "prd.json" });
      expect(mVerifyCmd).not.toHaveBeenCalled();
    });

    it("treats a whitespace-only command as off rather than shelling it", async () => {
      mLoadConfig.mockReturnValue(setupCfg("   "));
      await runLoop({ prd: "prd.json" });
      expect(mVerifyCmd).not.toHaveBeenCalled();
    });

    it("discards the cell and degrades when the setup fails", async () => {
      // a cell whose install failed has NO dependencies, so every verify in it
      // fails — using it anyway would burn the task's whole retry budget on
      // something no retry of the task can fix
      mLoadConfig.mockReturnValue(setupCfg("bun install"));
      mVerifyCmd.mockResolvedValue({ passed: false, output: "ENOTFOUND registry.npmjs.org" });

      await runLoop({ prd: "prd.json" });

      expect(mRemoveWorktree).toHaveBeenCalledWith(resolve("."), "/ws/.ralphrun/worktrees/T1");
      expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("worktree_setup failed"));
      // and the task still RUNS — in the main workspace, which has the deps
      expect(mRunTask.mock.calls[0][3]).toBe(resolve("."));
      expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("DONE T1"));
    });

    // The setup install is the LONGEST thing that happens before a task is even
    // "doing" — minutes of `npm ci` — and it used to be awaited before the task
    // had an AbortController at all. beginTask() hands out a fresh, never-aborted
    // signal, so a keypress landing in that window was invisible to every check
    // downstream: quit still launched an executor, skip still ran the task.
    describe("a control pressed while the setup is still installing", () => {
      /**
       * A TTY whose control is pressed WHILE the install is running — not
       * before it, which the loop's own pre-task checks would already catch.
       * That timing is the entire bug: the window opens after the task is
       * dispatched and closes before anything downstream looks at the control.
       */
      function pressDuringSetup(press?: "skip" | "quit"): { handle: Handle; ac: AbortController } {
        setTTY(true);
        const ac = new AbortController();
        const handle = makeHandle();
        let pressed = false;
        handle.control.beginTask = vi.fn(() => ac.signal);
        handle.control.shouldQuit = vi.fn(() => pressed && press === "quit");
        handle.control.takeSkip = vi.fn(() => pressed && press === "skip");
        mMount.mockReturnValue(handle);
        mLoadConfig.mockReturnValue(setupCfg("npm ci"));
        mVerifyCmd.mockImplementation(async () => {
          pressed = true;
          ac.abort(); // the keypress lands mid-install, and the install is killed
          return { passed: false, output: "" }; // which is how an aborted command settles
        });
        return { handle, ac };
      }

      it("hands the abort signal to the install so it is actually killable", async () => {
        const { ac } = pressDuringSetup();
        await runLoop({ prd: "prd.json" });
        expect(mVerifyCmd).toHaveBeenCalledWith(
          "npm ci",
          expect.stringContaining("T1"),
          "/ws/.ralphrun/worktrees/T1",
          expect.any(String),
          ac.signal,
          expect.objectContaining({ RALPHRUN_TASK_ID: "T1" }),
        );
      });

      it("skips the task instead of running the one the user just skipped", async () => {
        const { handle, ac } = pressDuringSetup("skip");

        await runLoop({ prd: "prd.json" });

        expect(mRunTask).not.toHaveBeenCalled();
        expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("skipped by user"));
        expect(mRemoveWorktree).toHaveBeenCalledWith(resolve("."), "/ws/.ralphrun/worktrees/T1");
        expect(handle.control.endTask).toHaveBeenCalledWith(ac.signal);
      });

      it("stops the run on quit rather than launching an executor anyway", async () => {
        const { handle, ac } = pressDuringSetup("quit");

        await runLoop({ prd: "prd.json" });

        expect(mRunTask).not.toHaveBeenCalled();
        expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("quit by user"));
        expect(handle.control.endTask).toHaveBeenCalledWith(ac.signal);
      });

      it("does not blame the user's keypress on the setup command", async () => {
        // an aborted command settles `passed: false` exactly like a broken one,
        // so triaging the failure first would log a setup failure that never
        // happened — and then carry on into a task the user abandoned
        pressDuringSetup("skip");

        await runLoop({ prd: "prd.json" });

        expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("worktree_setup failed"));
      });
    });
  });

  it("routes a merge-back conflict into the existing retry ladder", async () => {
    fastTimers();
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
    mHeadCommit.mockReturnValue("base-sha");
    mMergeBack.mockReturnValue({ status: "conflict", head: "loser-sha" });

    await runLoop({ prd: "prd.json" });

    // NOT done: nothing landed in the main workspace, so the next attempt gets a
    // worktree cut from the new HEAD and redoes the work on top of the winner
    const saved = JSON.parse(mWrite.mock.calls.at(-1)![1] as string);
    expect(saved.tasks[0].status).toBe("todo");
    expect(saved.tasks[0].retries).toBe(1);
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("loser-sha"));
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("DONE T1"));
  });

  it("blocks immediately when the user's own uncommitted change refuses the merge", async () => {
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
    mHeadCommit.mockReturnValue("base-sha");
    mMergeBack.mockReturnValue({ status: "dirty", head: "stranded-sha" });

    await runLoop({ prd: "prd.json" });

    // retrying cannot help — the user's edit will still be in the way — so
    // spending another full agent run on it would just burn money
    const saved = JSON.parse(mWrite.mock.calls.at(-1)![1] as string);
    expect(saved.tasks[0].status).toBe("blocked");
    expect(saved.tasks[0].retries).toBe(0);
    // and neither can any OTHER task: git refuses the pick while the trunk's
    // index holds staged content, whatever file it is in, so the whole backlog
    // would execute in full and block identically
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("workspace's, not the task's"));
  });

  it("blocks a task whose transport commit git refused, instead of calling it done", async () => {
    // A pre-commit hook (or an unset identity, or an unusable signing key) makes
    // `git commit` exit non-zero with nothing committed. The cell's HEAD then
    // never moves, so the pick has nothing to carry — and the finally block is
    // about to delete the directory that holds the only copy of the work. Marking
    // that done writes a task into prd.json with zero lines to show for it.
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
    mHeadCommit.mockReturnValue("base-sha"); // before === after: no commit happened
    mTaskChangedPaths.mockReturnValue(["src/a.ts"]);
    mCommitPaths.mockReset().mockReturnValue(false);
    mMergeBack.mockReturnValue({ status: "nothing", head: "base-sha" });

    await runLoop({ prd: "prd.json" });

    const saved = JSON.parse(mWrite.mock.calls.at(-1)![1] as string);
    expect(saved.tasks[0].status).toBe("blocked");
    expect(saved.tasks[0].retries).toBe(0); // a hook that refused once refuses again
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("DONE T1"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("refused the commit"));
  });

  it("still accepts a task that genuinely moved no files", async () => {
    // the other side of the check above: "nothing to pick" is legitimate when
    // there was nothing to commit, and blocking that would fail every task whose
    // work turned out to be a no-op
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
    mHeadCommit.mockReturnValue("base-sha");
    mTaskChangedPaths.mockReturnValue([]);
    mMergeBack.mockReturnValue({ status: "nothing", head: "base-sha" });

    await runLoop({ prd: "prd.json" });

    const saved = JSON.parse(mWrite.mock.calls.at(-1)![1] as string);
    expect(saved.tasks[0].status).toBe("done");
    expect(mCommitPaths).toHaveBeenCalledWith(expect.any(String), ["prd.json"], expect.stringContaining("chore(prd)"));
  });

  // The conflicting sha is what makes the loser's work recoverable by hand, but
  // it comes off a merge git may have refused before writing anything — the log
  // line still has to render rather than print "undefined".
  it("still reports a merge failure that came back without a sha", async () => {
    fastTimers();
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
    mHeadCommit.mockReturnValue("base-sha");
    mMergeBack.mockReturnValue({ status: "conflict", head: null });

    await runLoop({ prd: "prd.json" });

    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("recoverable at"));
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("undefined"));
  });

  // The gate approved the change; the workspace never received it. Recording that
  // as done writes a task into prd.json whose work exists only in a directory the
  // finally block is about to delete.
  it("blocks an approved task whose work could not be landed", async () => {
    fastTimers();
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true, review_blocked_policy: "accept" }));
    mHeadCommit.mockReturnValue("base-sha");
    mMergeBack.mockReturnValue({ status: "conflict", head: "loser-sha" });
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });

    await runLoop({ prd: "prd.json" });

    const saved = JSON.parse(mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.startsWith("{")).at(-1)!);
    expect(saved.tasks[0].status).toBe("blocked");
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("conflicted with work that landed first"));

    // and a single-task run ends there: there is no next task to move on to
    mRunTask.mockClear();
    await runLoop({ prd: "prd.json", task: "T1" });
    expect(mRunTask).toHaveBeenCalledTimes(1);
  });

  it("names the sha when it discards a worktree that still holds committed work", async () => {
    fastTimers();
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
    mRunTask.mockResolvedValue({ ok: false, reason: "failed", cost: NO_COST });
    mWorktreeLoss.mockReturnValue({ head: "abandonedsha", dirty: true });

    await runLoop({ prd: "prd.json" });

    // discarding the cell is the rollback the loop never had, but losing an
    // executor's work SILENTLY is worse than leaving it lying around
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("abandonedsha"));
    expect(mRemoveWorktree).toHaveBeenCalled();
  });

  // no commit at all: there is no sha to name and nothing survives the removal,
  // which is the WORSE of the two losses and so the one that must not be silent
  it("says the executor left uncommitted work when the discarded cell has no commit", async () => {
    fastTimers();
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true }));
    mRunTask.mockResolvedValue({ ok: false, reason: "failed", cost: NO_COST });
    mWorktreeLoss.mockReturnValue({ head: null, dirty: true });

    await runLoop({ prd: "prd.json" });

    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("uncommitted"));
  });

  // the CLI flag has to reach the resolved config, or `--on-review-blocked` is a
  // documented option that silently does nothing
  it("routes --on-review-blocked into the config as an override", async () => {
    await runLoop({ prd: "prd.json", onReviewBlocked: "accept" });
    expect(mLoadConfig).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({ review_blocked_policy: "accept" }),
    );
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

  it("CROSS mode advising -> triggers onPlanGenerated and saves to PRD", async () => {
    fastTimers();
    mRunTask.mockImplementationOnce(async (t, p, c, w, prog, sig, rfb, rb, onPlan) => {
      t.plan = "new-plan";
      t.planKey = "plan-key";
      if (onPlan) onPlan("new-plan", "plan-key");
      return { ok: true, cost: NO_COST };
    });
    await runLoop({ prd: "prd.json", executor: "claude:sonnet", advisor: "claude:fable", noReviewAfter: true });

    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const planWrites = writes.map((w) => JSON.parse(w)).filter((p) => p.tasks[0].plan === "new-plan");
    expect(planWrites).not.toHaveLength(0);
    expect(planWrites[0].tasks[0]).toMatchObject({ plan: "new-plan", planKey: "plan-key", status: "doing" });
  });

  it("does not restore an in-memory plan over a control-file replacement after a failed run", async () => {
    fastTimers();
    const initialTask = { ...TASK, plan: "old-plan", planKey: "old-key" };
    const humanTask = { ...TASK, status: "doing", plan: "human-plan", planKey: "human-key" };
    const initial = JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks: [initialTask] });
    const changed = JSON.stringify({ project: "P", stack: "S", architecture_notes: "A", tasks: [humanTask] });
    mRead.mockReturnValueOnce(initial).mockReturnValueOnce(initial).mockReturnValue(changed);
    mFindTask.mockReturnValue(initialTask as never);
    mRunTask.mockImplementationOnce(async (t, p, c, w, prog, sig, rfb, rb, onPlan) => {
      t.plan = "generated-plan";
      t.planKey = "plan-key";
      onPlan?.("generated-plan", "plan-key");
      return { ok: false, cost: NO_COST, reason: "failed" };
    });

    await runLoop({ prd: "prd.json", task: "T1" });

    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    const final = JSON.parse(writes.at(-1)!);
    expect(final.tasks[0]).toMatchObject({ plan: "human-plan", planKey: "human-key", status: "todo" });
    expect(writes.some((value) => value.includes("generated-plan"))).toBe(false);
  });

  it("does not persist generated advice when task prompt inputs changed mid-run", async () => {
    fastTimers();
    mAdvisorPlanKey.mockReturnValueOnce("changed-input-key");
    mRunTask.mockImplementationOnce(async (t, p, c, w, prog, sig, rfb, rb, onPlan) => {
      onPlan?.("generated-plan", "original-key");
      return { ok: true, cost: NO_COST };
    });

    await runLoop({ prd: "prd.json", task: "T1" });

    const writes = mWrite.mock.calls.map((c) => String(c[1])).filter((s) => s.trim().startsWith("{"));
    expect(writes.some((value) => value.includes("generated-plan"))).toBe(false);
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
      return { ok: true, cost: NO_COST };
    });
    await runLoop({ prd: "prd.json" });
    expect(mMount).toHaveBeenCalledWith(
      [{ id: "T1", title: "Task one", status: "todo" }],
      "P — exec: claude:sonnet | adv: claude:fable",
      "P",
      false,
      expect.any(Function),
    );
    // reporter routed into the TUI as an event carrying the current task id
    expect(handle.update).toHaveBeenCalledWith({ taskId: "T1", line: "mid", lineSource: "system" });
    // per-task abort signal came from the handle
    expect(mRunTask).toHaveBeenCalledWith(TASK, expect.anything(), expect.anything(), expect.any(String), expect.any(String), SIG, undefined, "base-tree", expect.any(Function), undefined, expect.objectContaining({ RALPHRUN_TASK_ID: "T1" }));
    expect(handle.control.takeSkip).toHaveBeenCalled();
    expect(handle.unmount).toHaveBeenCalled();
  });

  it("accounts for pause transitions between ticks and samples pause state at task stop", async () => {
    setTTY(true);
    let nowMs = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const handle = makeHandle();
    let paused = false;
    handle.control.isPaused = vi.fn(() => paused);
    mMount.mockReturnValue(handle);
    mRunTask.mockImplementation(async () => {
      const onPausedChange = mMount.mock.calls[0][4]!;
      nowMs = 100;
      paused = true;
      onPausedChange(true);
      nowMs = 400;
      paused = false;
      onPausedChange(false);
      nowMs = 1_000;
      paused = true;
      return { ok: true, cost: NO_COST };
    });

    await runLoop({ prd: "prd.json" });

    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("DONE T1 (1s)"));
    nowSpy.mockRestore();
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
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });

    await runLoop({ prd: "prd.json" });

    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("quit by user"));
  });

  it("accepts a verified review failure for a single requested task", async () => {
    fastTimers();
    setTTY(true);
    const handle = makeHandle({ reviewAction: "approve" });
    mMount.mockReturnValue(handle);
    mRunTask.mockResolvedValue({ ok: false, cost: NO_COST, reason: "review_exhausted", verificationPassed: true });

    await runLoop({ prd: "prd.json", task: "T1" });

    expect(handle.unmount).toHaveBeenCalled();
    expect(mCommitPaths).toHaveBeenCalledWith(expect.any(String), ["src/a.ts"], expect.stringContaining("T1"));
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

  it("reuses one time-ticker callback when config is modified mid-run", async () => {
    fastTimers();
    setTTY(true);
    const mockSetInterval = vi.spyOn(globalThis, "setInterval").mockImplementation((cb) => {
      cb();
      return 123 as any;
    });
    const mockClearInterval = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    const handle = makeHandle();
    handle.waitConfigOrResume = vi.fn().mockResolvedValueOnce("config").mockResolvedValueOnce("quit");
    mMount.mockReturnValue(handle);

    await runLoop({ prd: "prd.json" });

    expect(mockSetInterval).toHaveBeenCalledTimes(2);
    expect(mockSetInterval.mock.calls[0][0]).toBe(mockSetInterval.mock.calls[1][0]);
    mockSetInterval.mockRestore();
    mockClearInterval.mockRestore();
  });
});

describe("runLoop parallel waves", () => {
  const wtTask = (id: string, scope?: string[]) => ({
    id,
    title: id,
    status: "todo",
    deps: [],
    retries: 0,
    description: "d",
    acceptance: [],
    parallel: "safe",
    ...(scope ? { scope } : {}),
  });

  // prd.json as a real file rather than a constant: reads return whatever was
  // last written, which is the only way two tasks settling at once can actually
  // clobber each other's status if a read-modify-write ever stops being atomic.
  function livePrd(tasks: unknown[]): () => Record<string, { status: string; retries: number }> {
    let content = prdWith(tasks);
    mRead.mockImplementation(() => content);
    mWrite.mockImplementation((p, data) => {
      if (String(p).endsWith("prd.json")) content = String(data);
    });
    return () =>
      Object.fromEntries(JSON.parse(content).tasks.map((t: { id: string }) => [t.id, t])) as ReturnType<
        ReturnType<typeof livePrd>
      >;
  }

  // one wave, then nothing — readyTasks reads the LIVE prd so the tasks the loop
  // dispatches are the objects it later persists
  function dispatchOnce(): void {
    mReadyTasks.mockReset();
    mReadyTasks
      .mockImplementationOnce(((p: { tasks: { status: string }[] }) => p.tasks.filter((x) => x.status === "todo")) as never)
      .mockReturnValue([] as never);
  }

  // counts how many executors were alive at the same moment
  function trackConcurrency(): { peak: () => number } {
    let live = 0;
    let peak = 0;
    mRunTask.mockImplementation(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setImmediate(r));
      live -= 1;
      return { ok: true, cost: NO_COST };
    });
    return { peak: () => peak };
  }

  beforeEach(() => {
    fastTimers();
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true, max_parallel_tasks: 2 }));
    mHeadCommit.mockReturnValue("base-sha");
    // These tasks declare a scope, so the outer default (a path outside it)
    // would trip the scope gate in every one of them. Nothing moved = nothing
    // escaped; the tests that care about escaping set their own paths.
    mTaskChangedPaths.mockReturnValue([]);
  });

  it("runs two ready tasks at the same time and both reach done", async () => {
    const read = livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    dispatchOnce();
    const conc = trackConcurrency();

    await runLoop({ prd: "prd.json" });

    expect(conc.peak()).toBe(2);
    expect(read().A.status).toBe("done");
    expect(read().B.status).toBe("done");
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("WAVE of 2"));
  });

  it("serializes tasks that share an integration scope", async () => {
    const read = livePrd([
      { ...wtTask("A", ["src/a/**"]), shared_scope: ["src/app.ts"] },
      { ...wtTask("B", ["src/b/**"]), shared_scope: ["src/app.ts"] },
    ]);
    mReadyTasks.mockReset().mockImplementation(((p: { tasks: { status: string }[] }) => p.tasks.filter((x) => x.status === "todo")) as never);
    const conc = trackConcurrency();

    await runLoop({ prd: "prd.json" });

    expect(conc.peak()).toBe(1);
    expect(read().A.status).toBe("done");
    expect(read().B.status).toBe("done");
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("shared"));
  });
  it("blocks a wave task whose worktree_setup fails rather than sharing one checkout", async () => {
    // solo degrades to the main workspace; a wave cannot — N executors in one
    // checkout is precisely what loadConfig refuses, so blocked is the honest end
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true, max_parallel_tasks: 2, worktree_setup: "bun install" }));
    mVerifyCmd.mockResolvedValue({ passed: false, output: "ENOTFOUND registry.npmjs.org" });
    const read = livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    dispatchOnce();

    await runLoop({ prd: "prd.json" });

    expect(read().A.status).toBe("blocked");
    expect(read().B.status).toBe("blocked");
    expect(mRunTask).not.toHaveBeenCalled();
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("worktree_setup failed"));
    // WHY, not just that: the block reason is what the log line and the TUI
    // event carry, and it used to say "no worktree available, and a parallel
    // wave cannot share one checkout" — a cause that is flatly false here, since
    // the cell existed until the install failed inside it.
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/BLOCKED A .*worktree_setup failed/));
    // ...and the false one, which named a repo that was demonstrably there
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("no repo, or no commit yet"));
  });

  it("gives back the abort controller of a wave task it blocks for want of a cell", async () => {
    // this branch settles the task without ever reaching the try/finally, so it
    // is the one exit that has to hand the controller back by hand. Leaking it
    // grows the TUI's acs map for the rest of the run and leaves a settled task
    // among the ones a later keypress would abort.
    setTTY(true);
    const handle = makeHandle();
    mMount.mockReturnValue(handle);
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true, max_parallel_tasks: 2 }));
    mCreateWorktree.mockReturnValue(null); // no cell for either task
    livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    dispatchOnce();

    await runLoop({ prd: "prd.json" });

    expect(mRunTask).not.toHaveBeenCalled();
    expect(handle.control.beginTask).toHaveBeenCalledTimes(2);
    expect(handle.control.endTask).toHaveBeenCalledTimes(2);
  });

  // Each cell verified against the trunk it was CUT from, so N tasks can each
  // pass alone and be broken together the moment they land. Nothing else sees
  // that: the cherry-pick only refuses TEXTUAL conflicts, and the reviewer read
  // one task's diff.
  describe("the wave integration gate", () => {
    const verified = (id: string, scope: string[], verify: string) => ({ ...wtTask(id, scope), verify });

    it("re-runs the landed tasks' verify in the trunk, once per DISTINCT command", async () => {
      livePrd([verified("A", ["src/a/**"], "npm test"), verified("B", ["src/b/**"], "npm test")]);
      dispatchOnce();
      trackConcurrency();

      await runLoop({ prd: "prd.json" });

      // one run, not two: a wave whose tasks all say `npm test` deserves one
      expect(mVerifyCmd).toHaveBeenCalledTimes(1);
      // the 5th arg is the gate's OWN abort signal: every cell ended its own on the
      // way out, so without one this is the last thing a run does that a skip
      // cannot reach
      expect(mVerifyCmd).toHaveBeenCalledWith(
        "npm test",
        "wave",
        resolve("."),
        expect.any(String),
        undefined,
        expect.objectContaining({ RALPHRUN_TASK_ID: "__ralphrun_integration__" }),
      );
    });

    // Every cell ended its own signal on the way out, so without one of its own
    // this gate is the last thing a run does that a skip or quit cannot reach —
    // and it can hold a full verify timeout after the user asked to stop.
    it("runs under its own abort controller, and gives it back after", async () => {
      setTTY(true);
      const handle = makeHandle();
      mMount.mockReturnValue(handle);
      livePrd([verified("A", ["src/a/**"], "npm test"), verified("B", ["src/b/**"], "npm test")]);
      dispatchOnce();
      trackConcurrency();

      await runLoop({ prd: "prd.json" });

      expect(mVerifyCmd).toHaveBeenCalledWith(
        "npm test",
        "wave",
        expect.any(String),
        expect.any(String),
        SIG,
        expect.objectContaining({ RALPHRUN_TASK_ID: "__ralphrun_integration__" }),
      );
      // a settled phase must stop being one a keypress has to abort
      expect(handle.control.endTask).toHaveBeenCalledWith(SIG);
    });

    it("checks nothing more once the run was abandoned mid-gate", async () => {
      setTTY(true);
      const aborted = new AbortController();
      aborted.abort();
      const handle = makeHandle();
      handle.control.beginTask = vi.fn(() => aborted.signal);
      mMount.mockReturnValue(handle);
      livePrd([verified("A", ["src/a/**"], "npm test"), verified("B", ["src/b/**"], "npm run e2e")]);
      dispatchOnce();
      trackConcurrency();

      await runLoop({ prd: "prd.json" });

      // abandoned is not broken: the wave is not reported as an integration
      // failure just because the user stopped watching it
      expect(mVerifyCmd).not.toHaveBeenCalled();
      expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("WAVE BROKE"));
    });

    // An abort mid-command kills it and settles as `passed: false` — correct for
    // a gate that never finished, wrong as an answer to "did this wave break the
    // build". The already-aborted case never reaches the command at all, so it
    // cannot cover this.
    it("does not call an abandoned wave broken when the skip lands mid-check", async () => {
      setTTY(true);
      const ac = new AbortController();
      const handle = makeHandle();
      handle.control.beginTask = vi.fn(() => ac.signal);
      mMount.mockReturnValue(handle);
      livePrd([verified("A", ["src/a/**"], "npm test"), verified("B", ["src/b/**"], "npm test")]);
      dispatchOnce();
      trackConcurrency();
      mVerifyCmd.mockImplementation(async () => {
        ac.abort(); // the keypress lands while the suite is running
        return { passed: false, output: "" };
      });

      await runLoop({ prd: "prd.json" });

      expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("WAVE BROKE"));
    });

    it("runs each distinct command when the tasks verify differently", async () => {
      livePrd([verified("A", ["src/a/**"], "npm test"), verified("B", ["src/b/**"], "npm run e2e")]);
      dispatchOnce();
      trackConcurrency();

      await runLoop({ prd: "prd.json" });

      expect(mVerifyCmd.mock.calls.map((c) => c[0]).sort()).toEqual(["npm run e2e", "npm test"]);
    });

    it("stops the run when the merged result fails, and does NOT undo the commits", async () => {
      const read = livePrd([verified("A", ["src/a/**"], "npm test"), verified("B", ["src/b/**"], "npm test")]);
      dispatchOnce();
      trackConcurrency();
      mVerifyCmd.mockResolvedValue({ passed: false, output: "1 failing" });

      await runLoop({ prd: "prd.json" });

      expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("WAVE BROKE INTEGRATION"));
      // both landed and their work is in history — calling them undone would be a
      // lie, and re-running them would replay work that is already merged
      expect(read().A.status).toBe("done");
      expect(read().B.status).toBe("done");
    });

    it("skips the gate when only one task of the wave landed", async () => {
      // the other one blocked, so nothing new combined with anything — holding the
      // wave responsible would report the same failure a second time
      livePrd([verified("A", ["src/a/**"], "npm test"), verified("B", ["src/b/**"], "npm test")]);
      dispatchOnce();
      let n = 0;
      mRunTask.mockImplementation(async () => (++n === 1 ? { ok: true, cost: NO_COST } : { ok: false, reason: "failed", cost: NO_COST }));

      await runLoop({ prd: "prd.json" });

      expect(mVerifyCmd).not.toHaveBeenCalled();
    });

    // The gate re-reads prd.json to learn which tasks actually landed. If the
    // executor corrupted it, the cells already reported that and stopped the
    // run — the gate must not report it a second time as an integration failure.
    it("checks nothing when prd.json became unreadable after the wave", async () => {
      let content = prdWith([verified("A", ["src/a/**"], "npm test"), verified("B", ["src/b/**"], "npm test")]);
      let poisoned = false;
      mRead.mockImplementation(() => (poisoned ? "{ not json" : content));
      mWrite.mockImplementation((p, data) => {
        if (!String(p).endsWith("prd.json")) return;
        content = String(data);
        // both settled, so the NEXT read is the gate's
        if (JSON.parse(content).tasks.every((x: { status: string }) => x.status === "done")) poisoned = true;
      });
      dispatchOnce();
      trackConcurrency();

      await runLoop({ prd: "prd.json" });

      expect(mVerifyCmd).not.toHaveBeenCalled();
    });

    it("skips the gate when the wave's tasks declare no verify at all", async () => {
      livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
      dispatchOnce();
      trackConcurrency();

      await runLoop({ prd: "prd.json" });

      expect(mVerifyCmd).not.toHaveBeenCalled();
    });
  });

  it("gives each task its own worktree, and removes both", async () => {
    // the isolation is what makes the wave safe: two executors must never share
    // a checkout, and neither cell may outlive its task
    livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    dispatchOnce();
    mCreateWorktree.mockImplementation((_ws, id) => `/ws/.ralphrun/worktrees/${id}`);
    trackConcurrency();

    await runLoop({ prd: "prd.json" });

    expect(mRunTask.mock.calls.map((c) => c[3]).sort()).toEqual([
      "/ws/.ralphrun/worktrees/A",
      "/ws/.ralphrun/worktrees/B",
    ]);
    expect(mRemoveWorktree).toHaveBeenCalledTimes(2);
  });

  it("runs a task with no declared scope alone", async () => {
    // prdload skips the overlap check when either scope is empty, so a backlog
    // written before `scope` existed is unprotected — it must behave like today
    const read = livePrd([wtTask("U"), wtTask("A", ["src/a/**"])]);
    dispatchOnce();
    const conc = trackConcurrency();

    await runLoop({ prd: "prd.json" });

    expect(conc.peak()).toBe(1);
    expect(read().U.status).toBe("done");
    expect(read().A.status).toBe("todo"); // never dispatched: the wave was full at one
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("WAVE"));
  });

  it("keeps a sibling's status when a task settles through the async review gate", async () => {
    // THE prd.json write rule. The review gate awaits, so A reads the file
    // BEFORE B saves and writes AFTER it. Saving A's whole copy would roll B
    // back to `doing`; re-reading and copying only A's own fields cannot.
    mLoadConfig.mockReturnValue(
      cfg({ worktree_per_task: true, max_parallel_tasks: 2, review_blocked_policy: "accept" }),
    );
    const read = livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    dispatchOnce();
    mRunTask
      .mockResolvedValueOnce({ ok: false, reason: "review_exhausted", verificationPassed: true, cost: NO_COST })
      .mockResolvedValueOnce({ ok: true, cost: NO_COST });

    await runLoop({ prd: "prd.json" });

    expect(read().A.status).toBe("done");
    expect(read().B.status).toBe("done");
  });

  it("stops on the cost ceiling between waves, never inside one", async () => {
    // killing a task that is already paid for throws the result away and still
    // leaves the bill, so the ceiling can be overshot by up to one wave
    mLoadConfig.mockReturnValue(cfg({ worktree_per_task: true, max_parallel_tasks: 2, max_cost_usd: 1 }));
    const read = livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    mReadyTasks.mockReset();
    mReadyTasks.mockImplementation(((p: { tasks: { status: string }[] }) =>
      p.tasks.filter((x) => x.status === "todo")) as never);
    mRunTask.mockResolvedValue({ ok: true, cost: { usd: 0.6, unknown: false } });

    await runLoop({ prd: "prd.json" });

    // both of the first wave completed — neither was cut off mid-flight
    expect(read().A.status).toBe("done");
    expect(read().B.status).toBe("done");
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("stopping on cost budget"));
  });

  it("marks the whole wave skipped, not just the task that took the flag", async () => {
    // A confirmed skip aborts EVERY executor in the wave (mount.ts has no
    // per-task selection), but the flag itself is consume-once. Whoever settled
    // first used to take it and its siblings — killed by that same keypress —
    // were charged a retry and blocked as "max retries": a task the user never
    // asked to stop, blocked for a reason that never happened.
    setTTY(true);
    const handle = makeHandle();
    let flag = true;
    handle.control.takeSkip = vi.fn(() => {
      const s = flag;
      flag = false;
      return s;
    });
    mMount.mockReturnValue(handle);
    const read = livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    dispatchOnce();
    mRunTask.mockResolvedValue({ ok: false, reason: "failed", cost: NO_COST });

    await runLoop({ prd: "prd.json" });

    expect(read().A.status).toBe("blocked");
    expect(read().B.status).toBe("blocked");
    expect(read().A.retries).toBe(0);
    expect(read().B.retries).toBe(0);
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("SKIPPED B"));
  });

  it("blocks a wave task that could not get a worktree instead of sharing the checkout", async () => {
    // pickWave proves a repo EXISTS, never that `worktree add` will succeed. The
    // solo path degrades to the main workspace on purpose, but doing that inside
    // a wave puts a second executor in the checkout its siblings are picking
    // into — the configuration loadConfig refuses outright at load.
    const read = livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    dispatchOnce();
    mCreateWorktree.mockImplementation((_ws, id) => (id === "B" ? null : `/ws/.ralphrun/worktrees/${id}`));

    await runLoop({ prd: "prd.json" });

    expect(read().A.status).toBe("done");
    expect(read().B.status).toBe("blocked");
    expect(mRunTask.mock.calls.map((c) => c[3])).toEqual(["/ws/.ralphrun/worktrees/A"]);
  });

  // pickWave takes tasks in order and stops at the first unscoped one: an
  // unscoped task has nothing proving it cannot collide with the tasks already in
  // the wave, and it must not be dropped from the run either — it goes next.
  it("cuts the wave short at the first task with no declared scope", async () => {
    const read = livePrd([wtTask("A", ["src/a/**"]), wtTask("U")]);
    dispatchOnce();
    const conc = trackConcurrency();

    await runLoop({ prd: "prd.json" });

    expect(conc.peak()).toBe(1);
    expect(read().A.status).toBe("done");
    expect(read().U.status).toBe("todo");
  });

  // A wave collects settled results instead of awaiting each in turn, so a task
  // that asked the RUN to stop has to be noticed after the fact — the whole
  // point of "the workspace is the problem, every remaining task blocks too".
  it("stops the run when any task in the wave asked it to", async () => {
    const read = livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    mReadyTasks.mockImplementation(((p: { tasks: { status: string }[] }) =>
      p.tasks.filter((x) => x.status === "todo")) as never);
    mMergeBack.mockReturnValue({ status: "dirty", head: "stranded-sha" });

    await runLoop({ prd: "prd.json" });

    expect(read().A.status).toBe("blocked");
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("workspace's, not the task's"));
  });

  // allSettled, not Promise.all: bailing on the first rejection would leave the
  // siblings' rejections unhandled and their worktrees on disk. An agent crash is
  // already caught per task, so what reaches here is a bug in the loop itself —
  // it must surface, but only once every cell has been handed back to git.
  it("cleans up every cell before rethrowing a crash from one of them", async () => {
    livePrd([wtTask("A", ["src/a/**"]), wtTask("B", ["src/b/**"])]);
    dispatchOnce();
    mCreateWorktree.mockImplementation((_ws, id) => `/ws/.ralphrun/worktrees/${id}`);
    mMergeBack.mockImplementation((_ws, dir) => {
      if (String(dir).endsWith("A")) throw new Error("kaboom");
      return { status: "ok", head: "wt-head" };
    });

    await expect(runLoop({ prd: "prd.json" })).rejects.toThrow("kaboom");
    expect(mRemoveWorktree).toHaveBeenCalledTimes(2);
  });

  // `scope` is what the plan compiler refused overlapping pairs on, so a task
  // that edits outside it invalidated the proof its wave was scheduled on.
  it("FAILS a task that edited outside its declared scope, and does not land it", async () => {
    mLoadConfig.mockReturnValue(cfg());
    const read = livePrd([wtTask("A", ["src/api/**"])]);
    dispatchOnce();
    mTaskChangedPaths.mockReturnValue(["src/api/h.ts", "src/i18n.ts"]);

    await runLoop({ prd: "prd.json" });

    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("outside its declared scope"));
    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("src/i18n.ts"));
    expect(read().A.status).not.toBe("done");
    // the escaped work must not reach the trunk: in worktree mode not landing is
    // what discards the cell, which is the rollback
    expect(mMergeBack).not.toHaveBeenCalled();
  });

  // An executor told only "you failed" fails the same way until the retries run
  // out, then hits the stall detector. The next attempt has to know WHICH paths.
  it("tells the next attempt which paths escaped and what its scope was", async () => {
    mLoadConfig.mockReturnValue(cfg());
    livePrd([wtTask("A", ["src/api/**"])]);
    mReadyTasks.mockReset();
    mReadyTasks
      .mockImplementationOnce(((p: { tasks: { status: string }[] }) => p.tasks.filter((x) => x.status === "todo")) as never)
      .mockImplementationOnce(((p: { tasks: { status: string }[] }) => p.tasks.filter((x) => x.status === "todo")) as never)
      .mockReturnValue([] as never);
    mTaskChangedPaths.mockReturnValue(["src/api/h.ts", "src/i18n.ts"]);

    await runLoop({ prd: "prd.json" });

    // 7th arg of runTask is reviewRetryFeedback
    const feedback = String(mRunTask.mock.calls[1]?.[6] ?? "");
    expect(feedback).toContain("src/i18n.ts");
    expect(feedback).toContain("src/api/**");
  });

  // an empty scope declares nothing, so a backlog written before `scope` existed
  // must keep running exactly as it did
  it("cannot escape a scope that declares nothing", async () => {
    mLoadConfig.mockReturnValue(cfg());
    const read = livePrd([wtTask("A")]);
    dispatchOnce();
    mTaskChangedPaths.mockReturnValue(["anything.ts"]);

    await runLoop({ prd: "prd.json" });

    expect(read().A.status).toBe("done");
    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("outside its declared scope"));
  });

  // progress.md is all an unattended run leaves behind, so the warning names the
  // count and a sample — a task that rewrote forty files must not paste forty
  // paths into the log and bury every other line of the run.
  it("truncates the escaped-path sample instead of pasting the whole list", async () => {
    mLoadConfig.mockReturnValue(cfg());
    livePrd([wtTask("A", ["src/api/**"])]);
    dispatchOnce();
    mTaskChangedPaths.mockReturnValue(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);

    await runLoop({ prd: "prd.json" });

    const line = mLog.mock.calls.map((c) => String(c[1])).find((s) => s.includes("outside its declared scope"))!;
    expect(line).toContain("5 path(s)");
    expect(line).toContain("a.ts, b.ts, c.ts, …");
    expect(line).not.toContain("e.ts");
  });

  // taskChangedPaths answers null when there is no baseline to diff against (a
  // workspace with no commit yet). "unknown" is not "escaped": warning there
  // would fire on every task of a brand-new repository.
  it("says nothing about scope when the changed paths are unknown", async () => {
    mLoadConfig.mockReturnValue(cfg());
    const read = livePrd([wtTask("A", ["src/api/**"])]);
    dispatchOnce();
    mTaskChangedPaths.mockReturnValue(null);
    mCommitAllExcept.mockImplementation(() => {
      mHeadCommit.mockReturnValue("task-committed");
      return true;
    });

    await runLoop({ prd: "prd.json" });

    expect(mLog).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("outside its declared scope"));
    expect(read().A.status).toBe("done");
  });

  // The gate's only input is the start-of-task baseline, and that used to be
  // captured for review or commit_per_task alone — so a run with both off had
  // scopes documented as enforced and never checked at all.
  it("gates scope with no reviewer and no per-task commit", async () => {
    mLoadConfig.mockReturnValue(cfg({ commit_per_task: false, review_after: false, advisor: null }));
    const read = livePrd([wtTask("A", ["src/api/**"])]);
    dispatchOnce();
    // as git.ts really answers: no baseline, no footprint
    mTaskChangedPaths.mockImplementation(((_ws: string, base?: string | null) =>
      base ? ["src/api/h.ts", "src/i18n.ts"] : null) as never);

    await runLoop({ prd: "prd.json" });

    expect(mLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("outside its declared scope"));
    expect(read().A.status).not.toBe("done");
  });
});
