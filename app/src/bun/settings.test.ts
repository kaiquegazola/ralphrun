// settings.test.ts — the GUI writes the SAME files the CLI reads, so every
// mapping here is a contract with the core: view camelCase in, snake_case out,
// and never a combination the next `ralphrun --prd …` would refuse.

import { describe, it, expect, vi, beforeEach } from "vitest";

const files = new Map<string, string>();
const gitOut = vi.fn<(dir: string, ...args: string[]) => string | null>();
/** exit status, not output — a checkout is judged by whether git accepted it */
const git = vi.fn<(dir: string, ...args: string[]) => number | null>(() => 0);
const activeRuns = vi.fn<() => { projectId: string }[]>(() => []);
const loadConfig = vi.fn();
const loadUserConfig = vi.fn();
const saveUserConfig = vi.fn();
const loadAppSettings = vi.fn();
const saveAppSettings = vi.fn();
const findPrdFiles = vi.fn<(dir: string) => string[]>();
const getProject = vi.fn();
const currentBranch = vi.fn<(dir: string) => string | null>();

const DEFAULTS = { executor: { cli: "claude", model: "sonnet" }, advisor: null, max_retries_per_task: 3 };

const fs = {
  existsSync: (p: string) => files.has(p),
  readFileSync: (p: string) => files.get(p) ?? "",
  writeFileSync: (p: string, data: string) => void files.set(p, data),
  // the config lands through a tmp + rename — the CLI reads this same file, and
  // half a JSON object would kill every run after it
  renameSync: (from: string, to: string) => {
    files.set(to, files.get(from) ?? "");
    files.delete(from);
  },
};
vi.mock("node:fs", () => ({ ...fs, default: fs }));
vi.mock("../../../src/config.js", () => ({ DEFAULTS, loadConfig }));
vi.mock("../../../src/git.js", () => ({ gitOut, git }));
vi.mock("./runs.ts", () => ({ activeRuns }));
vi.mock("../../../src/userconfig.js", () => ({
  configPath: () => "/home/u/.ralphrun/config.json",
  loadUserConfig,
  saveUserConfig,
}));
vi.mock("./appsettings.ts", () => ({ loadAppSettings, saveAppSettings }));
vi.mock("./prds.ts", () => ({ findPrdFiles }));
vi.mock("./registry.ts", () => ({ getProject, currentBranch }));

const { projectSettings, saveProjectSettings, globalSettings, saveGlobalSettings, stallMinutes } =
  await import("./settings.ts");

const CONFIG = "/repo/ralph.config.json";

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  getProject.mockReturnValue({ id: "p1", dir: "/repo", name: "repo" });
  activeRuns.mockReturnValue([]); // clearAllMocks keeps implementations, not this
  currentBranch.mockReturnValue("main");
  gitOut.mockReturnValue("main\nfeature/x\n");
  findPrdFiles.mockReturnValue(["/repo/prd.json"]);
  loadConfig.mockReturnValue({
    executor: { cli: "codex", model: "gpt-5" },
    advisor: { cli: "claude", model: "opus" },
    max_parallel_tasks: 4,
    max_retries_per_task: 2,
    review_after: true,
    worktree_per_task: true,
    commit_per_task: true,
    review_blocked_policy: "accept",
  });
  loadUserConfig.mockReturnValue({ language: "en", max_retries_per_task: 5 });
  loadAppSettings.mockReturnValue({
    version: 1,
    stallMinutes: 10,
    maxConcurrentRuns: 2,
    notifyDecision: "system",
    notifyMerge: "silent",
    notifyRunEnd: "sound",
    theme: "dark",
    runDetailMode: "calm",
  });
});

const written = (): Record<string, unknown> => JSON.parse(files.get(CONFIG) ?? "{}");

describe("projectSettings", () => {
  it("reports what the loop would resolve, plus the inherited fallbacks the badges show", () => {
    const view = projectSettings("p1");
    expect(loadConfig).toHaveBeenCalledWith("/repo/prd.json", undefined, {});
    expect(view.configPath).toBe(CONFIG);
    expect(view.maxParallel).toBe(4);
    expect(view.branches).toEqual(["main", "feature/x"]);
    // the "herda ⌂" badge reads the CORE default: the loop reads
    // ralph.config.json and nothing else, so no app preference can stand in
    expect(view.inheritedParallel).toBe(1);
    expect(view.inheritedRetries).toBe(5);
  });

  it("reports worktrees as unavailable until the repo has a commit to cut from", () => {
    // `git worktree add` needs a HEAD. A freshly `git init`-ed project has a
    // modern git and no commit, and the toggle would promise isolation the
    // task runner cannot deliver.
    gitOut.mockImplementation((_d: string, ...a: string[]) =>
      a[0] === "--version" ? "git version 2.43.0" : a[0] === "rev-parse" ? null : "main",
    );
    expect(projectSettings("p1").worktreesSupported).toBe(false);

    gitOut.mockImplementation((_d: string, ...a: string[]) =>
      a[0] === "--version" ? "git version 2.43.0" : a[0] === "rev-parse" ? "cafe1234" : "main",
    );
    expect(projectSettings("p1").worktreesSupported).toBe(true);
  });

  it("falls back to the core defaults when the project's config cannot be resolved", () => {
    // a malformed ralph.config.json makes loadConfig throw; the screen still
    // has to render something instead of blanking out.
    loadConfig.mockImplementation(() => {
      throw new Error("bad json");
    });
    findPrdFiles.mockReturnValue([]);
    const view = projectSettings("p1");
    expect(view.executor).toEqual(DEFAULTS.executor);
    expect(view.maxParallel).toBe(1);
    expect(view.reviewBlockedPolicy).toBe("block");
  });

  it("refuses an id the registry does not know", () => {
    getProject.mockReturnValue(undefined);
    expect(() => projectSettings("ghost")).toThrow(/ghost/);
  });
});

describe("saveProjectSettings", () => {
  it("maps the view fields onto the core's snake_case keys", () => {
    saveProjectSettings("p1", {
      executor: { cli: "claude", model: "opus" },
      maxParallel: 3,
      maxRetries: 4,
      reviewAfter: false,
      commitPerTask: true,
      reviewBlockedPolicy: "accept",
    });
    expect(written()).toEqual({
      executor: { cli: "claude", model: "opus" },
      max_parallel_tasks: 3,
      max_retries_per_task: 4,
      review_after: false,
      commit_per_task: true,
      review_blocked_policy: "accept",
    });
  });

  it("keeps keys it does not own — the file is shared with the CLI and with hand edits", () => {
    files.set(CONFIG, JSON.stringify({ verify_cmd: "npm test", executor: { cli: "codex", model: "gpt-5" } }));
    saveProjectSettings("p1", { maxRetries: 6 });
    expect(written()).toEqual({
      verify_cmd: "npm test",
      executor: { cli: "codex", model: "gpt-5" },
      max_retries_per_task: 6,
    });
  });

  it("clamps parallelism to 1 when worktrees are turned off", () => {
    // the core refuses two executors in one checkout, so the knob has to come
    // down with the toggle or the next run dies on a config error.
    files.set(CONFIG, JSON.stringify({ max_parallel_tasks: 5, worktree_per_task: true }));
    saveProjectSettings("p1", { worktreePerTask: false });
    expect(written()).toEqual({ max_parallel_tasks: 1, worktree_per_task: false });
  });

  it("clamps even when the same patch asks for parallelism", () => {
    // a stale screen can send both; the toggle wins, never the number.
    saveProjectSettings("p1", { maxParallel: 8, worktreePerTask: false });
    expect(written().max_parallel_tasks).toBe(1);
  });

  it("leaves parallelism alone when worktrees stay on, and pins commits on with them", () => {
    saveProjectSettings("p1", { maxParallel: 4, worktreePerTask: true });
    // the core REFUSES worktrees without commits — the commit is how a task's
    // work leaves its worktree — so settling it here beats a run that dies at load
    expect(written()).toEqual({ max_parallel_tasks: 4, worktree_per_task: true, commit_per_task: true });
  });

  it("refuses to turn commits off while worktrees are on", () => {
    saveProjectSettings("p1", { worktreePerTask: true, commitPerTask: false });
    expect(written().commit_per_task).toBe(true);
  });

  it("starts from scratch when the config file is corrupt instead of refusing to save", () => {
    // half-written JSON is what a crashed editor leaves behind; the user's
    // click still has to land somewhere the next run can read.
    files.set(CONFIG, "{ not json");
    saveProjectSettings("p1", { maxRetries: 2 });
    expect(written()).toEqual({ max_retries_per_task: 2 });
  });

  it("checks out only a branch that is not already current", () => {
    saveProjectSettings("p1", { branch: "main" });
    expect(git).not.toHaveBeenCalled();
    saveProjectSettings("p1", { branch: "feature/x" });
    expect(git).toHaveBeenCalledWith("/repo", "checkout", "feature/x");
  });

  it("refuses to switch branch under a live run — its cherry-picks would land elsewhere", () => {
    activeRuns.mockReturnValue([{ projectId: "p1" }]);
    expect(() => saveProjectSettings("p1", { branch: "feature/x" })).toThrow(/run ativa/);
    expect(git).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it("reports a checkout git refused instead of saving as if it worked", () => {
    // a deleted branch or a dirty tree: silently continuing would leave the
    // user starting a run against a branch the repo never switched to
    git.mockReturnValue(1);
    expect(() => saveProjectSettings("p1", { branch: "feature/x" })).toThrow(/branch feature\/x/);
    expect(files.size).toBe(0);
  });

  it("refuses an id the registry does not know", () => {
    getProject.mockReturnValue(undefined);
    expect(() => saveProjectSettings("ghost", { maxRetries: 1 })).toThrow(/ghost/);
    expect(files.size).toBe(0);
  });
});

describe("global settings", () => {
  it("reads language from the core user config and the rest from app.json", () => {
    const view = globalSettings();
    expect(view.language).toBe("en");
    expect(view.stallMinutes).toBe(10);
    expect(view.runDetailMode).toBe("calm");
  });

  it("defaults the language to pt-br when the user never chose one", () => {
    loadUserConfig.mockReturnValue({});
    expect(globalSettings().language).toBe("pt-br");
  });

  it("routes language to the core config and everything else to app.json", () => {
    saveGlobalSettings({ language: "en", theme: "light", stallMinutes: 0 });
    expect(saveUserConfig).toHaveBeenCalledWith({ language: "en" });
    expect(saveAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "light", stallMinutes: 0 }),
    );
    // language must never leak into the app-only file
    expect(saveAppSettings.mock.calls[0][0]).not.toHaveProperty("language");
  });

  it("does not touch the core config when the patch has no language", () => {
    saveGlobalSettings({ maxConcurrentRuns: 4 });
    expect(saveUserConfig).not.toHaveBeenCalled();
  });

  it("exposes the stall threshold on its own for the escalation check", () => {
    loadAppSettings.mockReturnValue({ stallMinutes: 0 });
    expect(stallMinutes()).toBe(0);
  });
});
