// cli.test.ts — drives the Commander program actions (root loop, init, config).
import { describe, it, expect, vi, beforeEach } from "vitest";

// partial mock: cli.ts reads the REAL package.json for --version, so only
// existsSync (the PRD-presence probe) is faked
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
}));
vi.mock("./loop.js", () => ({ runLoop: vi.fn() }));
vi.mock("./wizard.js", () => ({ initWizard: vi.fn() }));
vi.mock("./userconfig.js", () => ({ loadUserConfig: vi.fn(() => ({ version: 1 })) }));
vi.mock("./configcmd.js", () => ({
  editConfig: vi.fn(),
  showConfig: vi.fn(),
  showGlobal: vi.fn(),
  resetGlobal: vi.fn(),
}));

import { existsSync } from "node:fs";
import { getLocale, setLocale } from "./i18n.js";
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { peekLang, program } from "./cli.js";
import { runLoop } from "./loop.js";
import { initWizard } from "./wizard.js";
import { editConfig, resetGlobal, showConfig, showGlobal } from "./configcmd.js";

const run = (args: string[]) => program.parseAsync(["node", "ralphrun", ...args]);

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en"); // module-global locale — the import-time peek may have set it
  vi.spyOn(console, "clear").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
});

// `--version` was hardcoded and drifted: it said 0.1.0 while the published
// package was 0.2.1. It is the one number a user checks to answer "did I get
// the fix?", so it silently lying is worse than it being absent.
describe("--version", () => {
  // `npm run test:winpaths` aliases node:path to win32 but leaves the real fs in
  // place, so a win32-shaped path cannot be opened on a POSIX machine and
  // readVersion() falls back. That is the documented limit of the simulation,
  // not a defect — on a real Windows box path and fs agree.
  const simulatedWindows = sep === "\\" && process.platform !== "win32";
  it.skipIf(simulatedWindows)("reports the package's real version, not a hardcoded copy", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(program.version()).toBe(pkg.version);
  });

  it("falls back instead of crashing the CLI when package.json cannot be read", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(),
      readFileSync: vi.fn(() => {
        throw new Error("ENOENT");
      }),
    }));
    const { program: p } = await import("./cli.js");
    expect(p.version()).toBe("unknown");
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("falls back when package.json parses but has no version string", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn(() => "{}") }));
    const { program: p } = await import("./cli.js");
    expect(p.version()).toBe("unknown");
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});

describe("root action", () => {
  it("runs the loop when the prd exists (skips wizard)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    await run(["--no-review-after", "--task", "t1"]);
    expect(initWizard).not.toHaveBeenCalled();
    expect(runLoop).toHaveBeenCalledWith(
      expect.objectContaining({ prd: "prd.json", noReviewAfter: true, task: "t1" }),
    );
  });

  it("skips the wizard for a missing custom prd path", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    await run(["--prd", "custom.json"]);
    expect(initWizard).not.toHaveBeenCalled();
    expect(runLoop).toHaveBeenCalledWith(
      expect.objectContaining({ prd: "custom.json", noReviewAfter: false }),
    );
  });

  it("wizard run:true → runs the loop with the picked prd", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initWizard).mockResolvedValue({ prdPath: "/repo/picked.json", run: true });
    await run([]);
    expect(initWizard).toHaveBeenCalledWith(expect.objectContaining({ fromRootFallback: true }));
    expect(runLoop).toHaveBeenCalledWith(expect.objectContaining({ prd: "/repo/picked.json" }));
  });

  it("wizard run:false → prints the saved hint, no loop", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initWizard).mockResolvedValue({ prdPath: "/repo/picked.json", run: false });
    await run([]);
    expect(console.log).toHaveBeenCalledWith("saved — run with: ralphrun --prd /repo/picked.json");
    expect(runLoop).not.toHaveBeenCalled();
  });

  it("exits when the wizard is cancelled", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initWizard).mockResolvedValue(null);
    await expect(run([])).rejects.toThrow("exit");
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(runLoop).not.toHaveBeenCalled();
  });
});

describe("init command", () => {
  it("runs the wizard; quit → no loop, no hint", async () => {
    vi.mocked(initWizard).mockResolvedValue(null);
    await run(["init", "--force"]);
    expect(initWizard).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(runLoop).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("run:true (CONSTRUIR) → hands the prd to the loop", async () => {
    vi.mocked(initWizard).mockResolvedValue({ prdPath: "/repo/prd.json", run: true });
    await run(["init"]);
    expect(runLoop).toHaveBeenCalledWith({ prd: "/repo/prd.json" });
  });

  it("run:false → prints the saved hint, no loop", async () => {
    vi.mocked(initWizard).mockResolvedValue({ prdPath: "/repo/prd.json", run: false });
    await run(["init"]);
    expect(console.log).toHaveBeenCalledWith("saved — run with: ralphrun --prd /repo/prd.json");
    expect(runLoop).not.toHaveBeenCalled();
  });
});

describe("config command", () => {
  it("edits on 'edit'", async () => {
    await run(["config", "edit"]);
    expect(editConfig).toHaveBeenCalled();
    expect(showConfig).not.toHaveBeenCalled();
  });

  it("shows by default", async () => {
    await run(["config"]);
    expect(showConfig).toHaveBeenCalled();
    expect(editConfig).not.toHaveBeenCalled();
  });

  it("shows the global config with --global", async () => {
    await run(["config", "show", "--global"]);
    expect(showGlobal).toHaveBeenCalled();
    expect(showConfig).not.toHaveBeenCalled();
  });

  it("resets the global config with reset --global", async () => {
    await run(["config", "reset", "--global"]);
    expect(resetGlobal).toHaveBeenCalled();
  });

  it("reset without --global errors out", async () => {
    await expect(run(["config", "reset"])).rejects.toThrow("exit");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(resetGlobal).not.toHaveBeenCalled();
  });
});

describe("--lang", () => {
  it("peekLang finds --lang v, --lang=v, or nothing", () => {
    expect(peekLang(["node", "ralphrun", "--lang", "pt-br"])).toBe("pt-br");
    expect(peekLang(["node", "ralphrun", "init", "--lang=en"])).toBe("en");
    expect(peekLang(["node", "ralphrun", "--dry-run"])).toBeUndefined();
  });

  it("root --lang forces the locale for the run", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    await run(["--lang", "pt-br"]);
    expect(getLocale()).toBe("pt-br");
    expect(runLoop).toHaveBeenCalled();
  });

  it("init --lang forces the locale for the run", async () => {
    await run(["init", "--lang", "pt-br"]);
    expect(getLocale()).toBe("pt-br");
    expect(initWizard).toHaveBeenCalled();
  });
});
