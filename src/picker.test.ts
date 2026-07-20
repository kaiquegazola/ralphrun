// picker.test.ts — fzf scoring + glob walk + Clack pickFile
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as p from "@clack/prompts";
import { fzfMatch, pickFile, readAttachment, searchFiles } from "./picker.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  realpathSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock("@clack/prompts", () => ({
  autocomplete: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  log: { warn: vi.fn() },
}));

const D = (name: string) => ({ name, isDirectory: () => true, isFile: () => false });
const F = (name: string) => ({ name, isDirectory: () => false, isFile: () => true });

const mockReaddir = vi.mocked(readdirSync);
const mockRealpath = vi.mocked(realpathSync);
const mockReadFile = vi.mocked(readFileSync);
const mockStat = vi.mocked(statSync);
const mockAuto = vi.mocked(p.autocomplete);
const mockCancel = vi.mocked(p.isCancel);
const mockWarn = vi.mocked(p.log.warn);

// ABSOLUTE paths here are built with the platform's own separator, because the
// product walks the tree with join()/resolve() and would never hand this fake
// fs a "/root/sub" on Windows. DISPLAY labels below stay "/"-separated on
// purpose — picker.ts normalizes those with .split(sep).join("/") so a typed
// "sub/c" matches on every OS.
const P = (...parts: string[]): string => resolve(join(...parts));

// fs tree exercising every walk branch
function installTree() {
  const tree: Record<string, ReturnType<typeof F>[]> = {
    [P("/root")]: [F("a.json"), F("b.txt"), D("sub"), D("node_modules"), D(".git"), D("throwdir")],
    [P("/root/sub")]: [F("c.json"), D("link"), D("weird")],
    [P("/root/sub/weird")]: [F("d.json")],
  };
  mockReaddir.mockImplementation(((dir: string) => {
    if (dir === P("/root/throwdir")) throw new Error("EACCES");
    return tree[dir] ?? [];
  }) as never);
  mockRealpath.mockImplementation(((pth: string) => {
    if (pth === P("/root/sub/link")) return P("/root/sub"); // dedup collision
    if (pth === P("/root/sub/weird")) throw new Error("noent"); // realpathSafe catch
    return pth;
  }) as never);
}

describe("fzfMatch", () => {
  it("empty needle scores 0", () => {
    expect(fzfMatch("", "abc")).toEqual({ score: 0 });
  });
  it("returns null on no match", () => {
    expect(fzfMatch("xyz", "abc")).toBeNull();
  });
  it("returns null when subsequence incomplete", () => {
    expect(fzfMatch("abz", "ab")).toBeNull();
  });
  it("prefix start match", () => {
    expect(fzfMatch("a", "abc")!.score).toBeGreaterThan(0);
  });
  it("boundary bonus after separator", () => {
    const sep = fzfMatch("b", "a/b")!.score;
    const nosep = fzfMatch("b", "ab")!.score;
    expect(sep).toBeGreaterThan(nosep);
  });
  it("consecutive beats scattered", () => {
    expect(fzfMatch("ab", "ab")!.score).toBeGreaterThan(fzfMatch("ab", "axb")!.score);
  });
  it("resets consec on gap (else branches)", () => {
    expect(fzfMatch("ac", "abc")).not.toBeNull();
  });
  it("clamps trailing bonus to 0 for far matches", () => {
    const hay = "a".repeat(70) + "z";
    expect(fzfMatch("z", hay)!.score).toBe(1);
  });
});

describe("pickFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCancel.mockReturnValue(false);
  });

  it("warns and returns null when no files", async () => {
    mockReaddir.mockReturnValue([] as never);
    const r = await pickFile({ cwd: P("/root"), message: "pick" });
    expect(r).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("No"));
    expect(mockAuto).not.toHaveBeenCalled();
  });

  it("walks tree, filters ext, dedups, and resolves choice", async () => {
    installTree();
    mockAuto.mockResolvedValue(P("/root/a.json") as never);
    const r = await pickFile({ cwd: P("/root"), message: "pick" });
    expect(r).toBe(P("/root/a.json"));
    const cfg = mockAuto.mock.calls[0][0] as { options: Array<{ value: string; label: string }>; filter: (s: string, o: { label?: string; value: string }) => boolean };
    const labels = cfg.options.map((o) => o.label);
    expect(labels).toEqual(["a.json", "sub/c.json", "sub/weird/d.json"]);
    // b.txt filtered by ext, node_modules/.git/throwdir/link excluded
    expect(labels).not.toContain("b.txt");
    // exercise filter callback branches
    expect(cfg.filter("  ", { label: "a.json", value: "x" })).toBe(true); // empty search
    expect(cfg.filter("aj", { label: "a.json", value: "x" })).toBe(true); // match
    expect(cfg.filter("zzz", { label: "a.json", value: "x" })).toBe(false); // no match
    expect(cfg.filter("x", { value: "x" } as never)).toBe(true); // label fallback to value
  });

  it("prepends extraOptions", async () => {
    installTree();
    mockAuto.mockResolvedValue("__new__" as never);
    await pickFile({
      cwd: P("/root"),
      message: "pick",
      extraOptions: [{ value: "__new__", label: "create new" }],
    });
    const cfg = mockAuto.mock.calls[0][0] as { options: Array<{ label: string }> };
    expect(cfg.options[0].label).toBe("create new");
  });

  it("returns null on cancel", async () => {
    installTree();
    mockAuto.mockResolvedValue(Symbol("cancel") as never);
    mockCancel.mockReturnValue(true);
    const r = await pickFile({ cwd: P("/root"), message: "pick" });
    expect(r).toBeNull();
    expect(mockCancel).toHaveBeenCalled();
  });

  it("null-ext pattern keeps all files", async () => {
    mockReaddir.mockReturnValue([F("a.json"), F("b.txt")] as never);
    mockRealpath.mockImplementation(((x: string) => x) as never);
    mockAuto.mockResolvedValue(P("/root/a.json") as never);
    await pickFile({ cwd: P("/root"), message: "pick", pattern: "json" });
    const cfg = mockAuto.mock.calls[0][0] as { options: Array<{ label: string }> };
    expect(cfg.options.map((o) => o.label).sort()).toEqual(["a.json", "b.txt"]);
  });

  it("respects maxItems cap mid-scan", async () => {
    mockReaddir.mockReturnValue([F("a.json"), F("b.json"), F("c.json")] as never);
    mockRealpath.mockImplementation(((x: string) => x) as never);
    mockAuto.mockResolvedValue(P("/root/a.json") as never);
    await pickFile({ cwd: P("/root"), message: "pick", maxItems: 1 });
    const cfg = mockAuto.mock.calls[0][0] as { options: unknown[] };
    expect(cfg.options.length).toBe(1);
  });

  it("maxItems 0 short-circuits walk (top guard)", async () => {
    mockReaddir.mockReturnValue([F("a.json")] as never);
    const r = await pickFile({ cwd: P("/root"), message: "pick", maxItems: 0 });
    expect(r).toBeNull();
    expect(mockWarn).toHaveBeenCalled();
  });
});

describe("searchFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installTree();
  });

  it("fuzzy over cwd, ranks all-extension matches, drops non-matches", () => {
    const r = searchFiles("c", P("/root"));
    // ext=null so b.txt is walked too, but only sub/c.json contains 'c'
    expect(r.map((f) => f.relative)).toEqual(["sub/c.json"]);
  });

  it("roots at dir when fragment contains '/'", () => {
    const r = searchFiles("sub/c", P("/root"));
    // rooted at /root/sub, needle 'c', relative to that root
    expect(r.map((f) => f.relative)).toEqual(["c.json"]);
    expect(r[0].absolute).toBe(P("/root/sub/c.json"));
  });

  it("roots at absolute dir", () => {
    const r = searchFiles(P("/root") + "/a", "/ignored");
    expect(r.map((f) => f.relative)).toContain("a.json");
    expect(r.every((f) => f.absolute.startsWith(P("/root")))).toBe(true);
  });

  it("honors max slice", () => {
    const r = searchFiles("", P("/root"), 2); // empty needle matches all (fzf score 0)
    expect(r.length).toBe(2);
  });

  it("expands a leading ~ to the home dir", () => {
    const home = homedir();
    mockReaddir.mockImplementation(((dir: string) => (dir === join(home, "Desktop") ? [F("req.md")] : [])) as never);
    mockRealpath.mockImplementation(((pth: string) => pth) as never);
    const r = searchFiles("~/Desktop/req", "/ignored");
    expect(r.map((f) => f.relative)).toContain("req.md");
    expect(r[0].absolute).toBe(join(home, "Desktop", "req.md"));
  });

  it("a fragment that IS a directory lists inside it (not the parent)", () => {
    const home = homedir();
    mockStat.mockImplementation(((pth: string) =>
      pth === join(home, "Desktop") ? { isDirectory: () => true } : undefined) as never);
    mockReaddir.mockImplementation(((dir: string) =>
      dir === join(home, "Desktop") ? [F("req.md"), F("notes.txt")] : []) as never);
    mockRealpath.mockImplementation(((pth: string) => pth) as never);
    const r = searchFiles("~/Desktop", "/ignored");
    expect(r.map((f) => f.relative).sort()).toEqual(["notes.txt", "req.md"]);
    expect(r[0].absolute.startsWith(join(home, "Desktop"))).toBe(true);
  });

  it("a trailing slash roots inside the dir without needing stat", () => {
    mockReaddir.mockImplementation(((dir: string) => (dir === P("/root/sub") ? [F("c.json")] : [])) as never);
    mockRealpath.mockImplementation(((pth: string) => pth) as never);
    const r = searchFiles(P("/root/sub") + "/", "/ignored");
    expect(r.map((f) => f.relative)).toEqual(["c.json"]);
    expect(mockStat).not.toHaveBeenCalled(); // endsWith("/") short-circuits isDir
  });

  it("dir listing shows folders first (with trailing /), then files, alphabetical; IGNORE dirs hidden", () => {
    const r = searchFiles(P("/root") + "/", "/ignored");
    expect(r.map((f) => f.relative)).toEqual(["sub/", "throwdir/", "a.json", "b.txt"]);
    expect(r[0].dir).toBe(true);
    expect(r.map((f) => f.relative)).not.toContain("node_modules/");
  });

  it("dir listing returns [] when the dir is unreadable", () => {
    const r = searchFiles(P("/root/throwdir") + "/", "/ignored"); // readdir throws EACCES
    expect(r).toEqual([]);
  });
});

describe("readAttachment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads full content when under cap", () => {
    mockReadFile.mockReturnValue("hello" as never);
    expect(readAttachment("/f.txt")).toEqual({ path: "/f.txt", content: "hello", truncated: false, ok: true });
  });

  it("truncates over 12000 chars", () => {
    mockReadFile.mockReturnValue(("x".repeat(13000)) as never);
    const r = readAttachment("/big.txt");
    expect(r.truncated).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.content.length).toBe(12000);
  });

  it("returns empty + ok:false on read error, never throws", () => {
    mockReadFile.mockImplementation((() => {
      throw new Error("ENOENT");
    }) as never);
    expect(readAttachment("/missing")).toEqual({ path: "/missing", content: "", truncated: false, ok: false });
  });
});
