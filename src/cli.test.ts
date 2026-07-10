// cli.test.ts — drives the Commander program actions (root loop, init, config).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
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
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
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

  it("launches the wizard and runs with the picked prd", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initWizard).mockResolvedValue("picked.json");
    await run([]);
    expect(initWizard).toHaveBeenCalled();
    expect(runLoop).toHaveBeenCalledWith(expect.objectContaining({ prd: "picked.json" }));
  });

  it("exits when the wizard is cancelled", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initWizard).mockResolvedValue(undefined as never);
    await expect(run([])).rejects.toThrow("exit");
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(runLoop).not.toHaveBeenCalled();
  });
});

describe("init command", () => {
  it("clears and runs the wizard", async () => {
    await run(["init", "--force"]);
    expect(initWizard).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
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
