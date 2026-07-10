import { describe, it, expect, vi, beforeEach } from "vitest";

const CANCEL = Symbol("cancel");

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === CANCEL),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock("./userconfig.js", () => ({
  configPath: vi.fn(() => "/xdg/ralphrun/config.json"),
  loadUserConfig: vi.fn(() => ({ version: 1 })),
  resetUserConfig: vi.fn(),
  userConfigExists: vi.fn(() => false),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { t } from "./i18n.js";
import { loadUserConfig, resetUserConfig, userConfigExists } from "./userconfig.js";
import { showConfig, showGlobal, resetGlobal, editConfig } from "./configcmd.js";

const mExists = vi.mocked(existsSync);
const mRead = vi.mocked(readFileSync);
const mWrite = vi.mocked(writeFileSync);
const mText = vi.mocked(p.text);
const mConfirm = vi.mocked(p.confirm);

let textQ: any[] = [];
let confirmQ: any[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  textQ = [];
  confirmQ = [];
  // text mock also exercises numOrKeep's validate() branches when present
  mText.mockImplementation(async (o: any) => {
    if (o.validate) {
      o.validate(undefined);
      o.validate("");
      o.validate("x");
      o.validate("5");
    }
    return textQ.shift();
  });
  mConfirm.mockImplementation(async () => confirmQ.shift());
});

describe("showConfig", () => {
  it("prints merged config when a file exists", async () => {
    mExists.mockReturnValue(true);
    mRead.mockReturnValue('{"task_timeout":99}' as any);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await showConfig({ config: "ralph.config.json" });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('"task_timeout": 99');
  });

  it("prints defaults and warns to stderr when no file exists", async () => {
    mExists.mockReturnValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await showConfig({ config: "ralph.config.json" });
    expect(err).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('"task_timeout": 1800');
  });
});

describe("showGlobal", () => {
  it("prints the path + saved config when the file exists", async () => {
    vi.mocked(userConfigExists).mockReturnValue(true);
    vi.mocked(loadUserConfig).mockReturnValue({ version: 1, language: "pt-br" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await showGlobal();
    expect(err).not.toHaveBeenCalled();
    expect(log).toHaveBeenNthCalledWith(1, t("config.globalPath", { path: "/xdg/ralphrun/config.json" }));
    expect(log.mock.calls[1][0]).toContain('"language": "pt-br"');
  });

  it("warns to stderr and prints defaults when missing", async () => {
    vi.mocked(userConfigExists).mockReturnValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await showGlobal();
    expect(err).toHaveBeenCalledWith(t("config.globalMissing") + "\n");
    expect(log.mock.calls[1][0]).toContain('"version": 1');
  });
});

describe("resetGlobal", () => {
  it("deletes the file and prints a confirmation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await resetGlobal();
    expect(vi.mocked(resetUserConfig)).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(t("config.resetDone", { path: "/xdg/ralphrun/config.json" }));
  });
});

describe("editConfig", () => {
  it("happy path: writes edited config", async () => {
    mExists.mockReturnValue(true);
    mRead.mockReturnValue("{}" as any);
    textQ = ["claude:opus", "grok:grok-4.5", "120", "4", "2"];
    confirmQ = [true, false];

    await editConfig({ config: "ralph.config.json" });

    expect(mWrite).toHaveBeenCalledOnce();
    const written = JSON.parse((mWrite.mock.calls[0][1] as string).trim());
    expect(written.executor).toEqual({ cli: "claude", model: "opus" });
    expect(written.advisor).toEqual({ cli: "grok", model: "grok-4.5" });
    expect(written.task_timeout).toBe(120);
    expect(written.max_retries_per_task).toBe(4);
    expect(written.max_review_rounds).toBe(2);
    expect(written.review_after).toBe(true);
    expect(written.commit_per_task).toBe(false);
  });

  it("keep-branches: parseAgent null executor, cancelled numbers/confirms", async () => {
    mExists.mockReturnValue(true);
    mRead.mockReturnValue('{"advisor":null}' as any); // advisor initialValue -> "none"
    textQ = ["none", "none", CANCEL, "abc", "5"];
    confirmQ = [CANCEL, CANCEL];

    await editConfig({ config: "ralph.config.json" });

    const written = JSON.parse((mWrite.mock.calls[0][1] as string).trim());
    expect(written.executor).toEqual({ cli: "claude", model: "sonnet" }); // kept default
    expect(written.advisor).toBeNull();
    expect(written.task_timeout).toBe(1800); // numOrKeep isCancel -> current
    expect(written.max_retries_per_task).toBe(3); // NaN -> current
    expect(written.max_review_rounds).toBe(5);
    expect(written.review_after).toBe(true); // confirm cancelled -> kept default
    expect(written.commit_per_task).toBe(true);
  });

  it("no config file: notes defaults, then executor cancel exits", async () => {
    mExists.mockReturnValue(false);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    textQ = [CANCEL];
    await expect(editConfig({ config: "ralph.config.json" })).rejects.toThrow("exit");
    expect(p.note).toHaveBeenCalled();
    expect(p.cancel).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    expect(mWrite).not.toHaveBeenCalled();
  });

  it("advisor cancel exits", async () => {
    mExists.mockReturnValue(true);
    mRead.mockReturnValue("{}" as any);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    textQ = ["claude:opus", CANCEL];
    await expect(editConfig({ config: "ralph.config.json" })).rejects.toThrow("exit");
  });
});
