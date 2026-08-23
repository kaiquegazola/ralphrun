// projects.test.ts — the folder probe behind 4c ("nova pasta") and the two
// project screens. The core registry, git and the disk are mocked; registry.ts
// itself is NOT, because "is this a repo, is it empty, which package manager"
// is exactly the reporting under test here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const paths = new Set<string>();
const entries = new Map<string, string[]>();
const mkdirSync = vi.fn();

const fs = {
  existsSync: (p: string) => paths.has(String(p)),
  readdirSync: (p: string) => {
    const e = entries.get(String(p));
    if (!e) throw new Error(`ENOENT ${p}`);
    return e;
  },
  mkdirSync: (...args: unknown[]) => mkdirSync(...args),
};
// the core's registry imports node:fs as a namespace, so the mock needs a default too
vi.mock("node:fs", () => ({ ...fs, default: fs }));

const gitOut = vi.fn();
/** exit status — a git init that FAILED must not register a project */
const git = vi.fn<(dir: string, ...args: string[]) => number | null>(() => 0);
vi.mock("../../../src/git.js", () => ({
  git: (dir: string, ...a: string[]) => git(dir, ...a),
  gitOut: (...a: unknown[]) => gitOut(...a),
}));

const reg = {
  addProject: vi.fn(),
  findProject: vi.fn(),
  listProjects: vi.fn(),
  projectId: vi.fn(),
  projectsPath: vi.fn(),
  removeProject: vi.fn(),
};
vi.mock("../../../src/projectreg.js", () => reg);

const prds = { findPrdFiles: vi.fn(), toPrdView: vi.fn() };
vi.mock("./prds.ts", () => prds);
const runs = { activeRuns: vi.fn(), readHistory: vi.fn(), runForPrd: vi.fn() };
vi.mock("./runs.ts", () => runs);
const studio = { drafts: vi.fn() };
vi.mock("./studio.ts", () => studio);

const { createProject, listProjectViews, probeDir } = await import("./projects.ts");
const { run } = await import("../mainview/testing.tsx");

const HOME = "/Users/kg";
let realHome: string | undefined;

/** Register a folder and its direct entries in the fake disk. */
function folder(dir: string, ...names: string[]): void {
  paths.add(dir);
  entries.set(dir, names);
  for (const n of names) paths.add(`${dir}/${n}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  paths.clear();
  entries.clear();
  realHome = process.env.HOME;
  process.env.HOME = HOME;
  gitOut.mockImplementation((_dir: string, ...args: string[]) =>
    args[0] === "--version" ? "git version 2.43.0" : "main",
  );
  git.mockReturnValue(0); // clearAllMocks keeps implementations, not this
  reg.addProject.mockReturnValue({ id: "p9" });
  reg.listProjects.mockReturnValue([]);
  prds.findPrdFiles.mockReturnValue([]);
  runs.activeRuns.mockReturnValue([]);
  studio.drafts.mockReturnValue([]);
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

describe("probeDir", () => {
  it("expands a leading ~ so the typed path and the reported path agree", () => {
    folder(`${HOME}/dev/qc`, ".git");
    expect(probeDir("~/dev/qc").dir).toBe(`${HOME}/dev/qc`);
  });

  it("treats a folder that does not exist yet as empty and gitless", () => {
    const probe = probeDir("/dev/brand-new");
    expect(probe).toMatchObject({
      exists: false,
      empty: true,
      git: false,
      branch: null,
      packageManager: null,
      name: "brand-new",
    });
    // git still has to be probed somewhere, so the cwd stands in for the
    // folder that is not there — the version line is about the machine
    expect(gitOut).toHaveBeenCalledWith(process.cwd(), "--version");
  });

  it("reports an existing repo: branch, package manager and non-empty", () => {
    folder("/dev/qc", ".git", "pnpm-lock.yaml", "src");
    gitOut.mockImplementation((_d: string, ...a: string[]) =>
      a[0] === "--version" ? "git version 2.43.0" : "feat/theme",
    );

    expect(probeDir("/dev/qc")).toMatchObject({
      exists: true,
      empty: false,
      git: true,
      branch: "feat/theme",
      packageManager: "pnpm",
      gitVersion: "2.43.0",
      worktreesSupported: true,
    });
  });

  it("counts a folder holding only .DS_Store as empty — Finder should not block init", () => {
    folder("/dev/fresh", ".DS_Store");
    expect(probeDir("/dev/fresh")).toMatchObject({ exists: true, empty: true, git: false, branch: null });
  });

  it("says nothing about worktrees when git is not on the machine", () => {
    folder("/dev/qc");
    gitOut.mockReturnValue(null);
    expect(probeDir("/dev/qc")).toMatchObject({ gitVersion: null, worktreesSupported: false });
  });

  it("refuses worktrees on a git older than 2.x, which never had the command", () => {
    folder("/dev/qc");
    gitOut.mockImplementation((_d: string, ...a: string[]) => (a[0] === "--version" ? "git version 1.9.5" : null));
    expect(probeDir("/dev/qc")).toMatchObject({ gitVersion: "1.9.5", worktreesSupported: false });
  });
});

describe("createProject", () => {
  it("creates the folder and initialises the repo when asked", () => {
    const id = createProject("~/dev/new", "novo", true);
    expect(mkdirSync).toHaveBeenCalledWith(`${HOME}/dev/new`, { recursive: true });
    expect(git).toHaveBeenCalledWith(`${HOME}/dev/new`, "init");
    expect(reg.addProject).toHaveBeenCalledWith(`${HOME}/dev/new`, "novo");
    expect(id).toBe("p9");
  });

  it("refuses to register a folder whose git init failed", () => {
    // a project that is not a repo cannot do worktrees, cherry-picks or
    // per-task commits — listing it would promise a loop it cannot run
    git.mockReturnValue(1);
    expect(() => createProject("~/dev/new", "novo", true)).toThrow(/git init/);
    expect(reg.addProject).not.toHaveBeenCalled();
  });

  it("leaves an existing repo alone — re-initialising someone's history is not ours to do", () => {
    folder("/dev/qc", ".git");
    createProject("/dev/qc", undefined, true);
    expect(git).not.toHaveBeenCalled();
    expect(reg.addProject).toHaveBeenCalledWith("/dev/qc", undefined);
  });

  it("registers a plain folder without git when init is declined", () => {
    createProject("/dev/plain", "plain", false);
    expect(mkdirSync).toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });
});

describe("listProjectViews", () => {
  it("drops registry records whose folder no longer resolves", () => {
    reg.listProjects.mockReturnValue([{ id: "p1" }, { id: "gone" }]);
    reg.findProject.mockImplementation((id: string) =>
      id === "p1" ? { id: "p1", name: "qc-colombia", dir: "/dev/qc" } : undefined,
    );
    folder("/dev/qc", ".git");
    prds.findPrdFiles.mockReturnValue(["/dev/qc/a.json", "/dev/qc/b.json"]);

    const views = listProjectViews();
    expect(views.map((v) => v.id)).toEqual(["p1"]);
    expect(views[0]).toMatchObject({ git: true, branch: "main", prdCount: 2 });
  });

  it("counts only the runs and drafts belonging to the project", () => {
    reg.listProjects.mockReturnValue([{ id: "p1" }]);
    reg.findProject.mockReturnValue({ id: "p1", name: "qc-colombia", dir: "/dev/qc" });
    folder("/dev/qc", ".git");
    runs.activeRuns.mockReturnValue([run({ projectId: "p1" }), run({ id: "run-2", projectId: "p2" })]);
    studio.drafts.mockReturnValue([{ projectId: "p1" }, { projectId: "p2" }, { projectId: "p1" }]);

    const view = listProjectViews()[0];
    expect(view.runs.map((r) => r.id)).toEqual(["run-1"]);
    expect(view.draftCount).toBe(2);
  });
});
