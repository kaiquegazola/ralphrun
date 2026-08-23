// projectreg.test.ts — the project list: id derivation, add/list/remove, and
// the two states a preferences file is allowed to be in (absent, corrupt).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

import { addProject, findProject, listProjects, projectId, projectsPath, removeProject } from "./projectreg.js";

vi.mock("node:fs", () => ({
  statSync: vi.fn(),
  realpathSync: Object.assign(vi.fn(), { native: (p: string) => p }),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

/** a registered path has to be a DIRECTORY — a file in its place is not a project */
const mStat = vi.mocked(statSync);
const dirAt = (...dirs: string[]) =>
  mStat.mockImplementation(((p: string) => {
    if (dirs.length > 0 && !dirs.includes(String(p))) throw new Error("ENOENT");
    return { isDirectory: () => true };
  }) as never);
const mRead = vi.mocked(readFileSync);
const mWrite = vi.mocked(writeFileSync);

/** What the registry file holds, as the module would read it back. */
function stored(): { projects: { id: string; name: string; dir: string }[] } {
  const [, json] = mWrite.mock.calls.at(-1)!;
  return JSON.parse(String(json));
}

function seed(content: unknown): void {
  mRead.mockReturnValue(JSON.stringify(content) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  dirAt(); // every registered folder still exists
  seed({ version: 1, projects: [] });
});

describe("projectId", () => {
  it("is derived from the absolute path, so the same folder is the same project", () => {
    expect(projectId("/a/b")).toBe(projectId("/a/b"));
    expect(projectId("/a/b")).not.toBe(projectId("/a/c"));
  });
});

describe("projectsPath", () => {
  it("sits next to the global user config", () => {
    expect(projectsPath().endsWith("projects.json")).toBe(true);
  });
});

describe("addProject", () => {
  it("registers a folder with its basename as the default display name", () => {
    const rec = addProject("/dev/monkeyhub");
    expect(rec).toMatchObject({ name: "monkeyhub", dir: "/dev/monkeyhub" });
    expect(stored().projects).toHaveLength(1);
  });

  it("takes an explicit name over the basename", () => {
    expect(addProject("/dev/qc", "QC Colômbia").name).toBe("QC Colômbia");
  });

  it("falls back to the basename when the given name is blank", () => {
    expect(addProject("/dev/qc", "   ").name).toBe("qc");
  });

  it("is idempotent — registering the same folder twice does not rewrite the registry", () => {
    seed({ version: 1, projects: [{ id: projectId("/dev/qc"), name: "qc", dir: "/dev/qc", addedAt: 1 }] });
    const rec = addProject("/dev/qc");
    expect(rec.addedAt).toBe(1);
    // the lock's own pid file is a write too — the claim is about the REGISTRY
    expect(renameSync).not.toHaveBeenCalled();
    expect(mWrite.mock.calls.every(([p]) => String(p).includes(".lock"))).toBe(true);
  });
});

describe("listProjects", () => {
  it("drops a record whose path is now a FILE — it cannot host a run", () => {
    seed({ version: 1, projects: [{ id: "a", name: "file", dir: "/dev/file", addedAt: 1 }] });
    mStat.mockReturnValue({ isDirectory: () => false } as never);
    expect(listProjects()).toEqual([]);
  });

  it("drops records whose folder no longer exists", () => {
    seed({
      version: 1,
      projects: [
        { id: "a", name: "here", dir: "/dev/here", addedAt: 1 },
        { id: "b", name: "gone", dir: "/dev/gone", addedAt: 1 },
      ],
    });
    dirAt("/dev/here");
    expect(listProjects().map((p) => p.name)).toEqual(["here"]);
  });

  it("reads an absent file as an empty list", () => {
    mRead.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(listProjects()).toEqual([]);
  });

  it("reads a corrupt file as an empty list instead of throwing", () => {
    mRead.mockReturnValue("{not json" as never);
    expect(listProjects()).toEqual([]);
  });

  it("ignores a file whose projects key is not an array", () => {
    seed({ version: 1, projects: "nope" });
    expect(listProjects()).toEqual([]);
  });

  it("ignores malformed records inside a well-formed file", () => {
    // a record missing ANY field is corruption: one with a dir but no name
    // reaches the desktop project list and crashes it on `name.slice(...)`
    seed({
      version: 1,
      projects: [
        null,
        { name: "no dir" },
        { id: "x", dir: "/dev/nameless" },
        { name: "idless", dir: "/dev/idless" },
        { id: "c", name: "ok", dir: "/dev/ok", addedAt: 1 },
      ],
    });
    expect(listProjects().map((p) => p.name)).toEqual(["ok"]);
  });
});

describe("findProject", () => {
  it("returns the record for a known id and null otherwise", () => {
    seed({ version: 1, projects: [{ id: "abc", name: "qc", dir: "/dev/qc", addedAt: 1 }] });
    expect(findProject("abc")?.name).toBe("qc");
    expect(findProject("zzz")).toBeNull();
  });
});

describe("removeProject", () => {
  it("drops the record and leaves the others, creating the config dir first", () => {
    seed({
      version: 1,
      projects: [
        { id: "a", name: "a", dir: "/dev/a", addedAt: 1 },
        { id: "b", name: "b", dir: "/dev/b", addedAt: 1 },
      ],
    });
    removeProject("a");
    expect(stored().projects.map((p) => p.id)).toEqual(["b"]);
    expect(mkdirSync).toHaveBeenCalled();
  });

  it("lands the new content through a rename — the CLI and the app share this file", () => {
    addProject("/dev/qc");
    const [tmp] = vi.mocked(writeFileSync).mock.calls.at(-1)!;
    // written to a pid-unique tmp, then renamed over the real path: a reader
    // never sees a half-file and an interrupted write leaves the old one intact
    expect(String(tmp)).toContain(".tmp");
    expect(renameSync).toHaveBeenCalledWith(tmp, projectsPath());
  });

  it("takes and releases the lock around the read-modify-write", () => {
    addProject("/dev/qc");
    // A DIRECTORY, because mkdir is atomic on every filesystem. Without it two
    // writers can both read the old registry and the second rename erases the
    // first one's project — the rename alone only makes the write atomic.
    expect(mkdirSync).toHaveBeenCalledWith(`${projectsPath()}.lock`);
    expect(rmSync).toHaveBeenCalledWith(`${projectsPath()}.lock`, { recursive: true, force: true });
  });
});
