// i18n.test.ts — t()/setLocale/getLocale, interpolation, dict parity,
// resolveLocale precedence (explicit > saved config > Intl > "en").
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DICTS, getLocale, resolveLocale, setLocale, t } from "./i18n.js";
import { loadUserConfig } from "./userconfig.js";

vi.mock("./userconfig.js", () => ({
  loadUserConfig: vi.fn(),
}));

const mockedLoad = vi.mocked(loadUserConfig);

function stubIntl(locale: string): void {
  vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
    resolvedOptions: () => ({ locale }),
  } as unknown as Intl.DateTimeFormat);
}

beforeEach(() => {
  mockedLoad.mockReturnValue({ version: 1 });
});

afterEach(() => {
  setLocale("en"); // locale is module-global — reset to avoid order-dependent tests
  vi.restoreAllMocks();
});

describe("t / setLocale / getLocale", () => {
  it("renders English by default", () => {
    expect(getLocale()).toBe("en");
    expect(t("studio.thinking")).toBe("thinking…");
    expect(t("run.footerHint")).toBe("[p]ause [s]kip [q]uit");
  });

  it("renders pt-BR after setLocale", () => {
    setLocale("pt-br");
    expect(getLocale()).toBe("pt-br");
    expect(t("studio.thinking")).toBe("pensando…");
    expect(t("common.noMatch")).toBe("nada encontrado");
  });

  it("interpolates {name} params (strings and numbers, multiple)", () => {
    expect(t("wizard.usingPrd", { path: "/tmp/prd.json" })).toBe("Using PRD: /tmp/prd.json");
    expect(t("studio.moreTasks", { n: 3 })).toBe("…+3 more");
    expect(t("loop.err.notLoggedIn", { cli: "claude", cmd: "claude login" })).toBe(
      "❌ CLI 'claude' is installed but NOT logged in. Please run 'claude login' first.",
    );
  });

  it("interpolates in the active locale", () => {
    setLocale("pt-br");
    expect(t("wizard.title.plannerModel", { cli: "claude" })).toBe("Modelo para o Planner (claude):");
  });

  it("leaves the placeholder when a param is missing", () => {
    expect(t("wizard.usingPrd")).toBe("Using PRD: {path}");
    expect(t("loop.err.notInstalled", { other: "x" })).toBe("❌ CLI '{cli}' is not installed on your PATH.");
  });
});

describe("dicts", () => {
  it("en and pt-br have the same keys, all non-empty", () => {
    const enKeys = Object.keys(DICTS.en).sort();
    const ptKeys = Object.keys(DICTS["pt-br"]).sort();
    expect(ptKeys).toEqual(enKeys);
    for (const d of [DICTS.en, DICTS["pt-br"]]) {
      for (const v of Object.values(d)) expect(v.length).toBeGreaterThan(0);
    }
  });

  it("language screen title is the same bilingual literal in both dicts", () => {
    expect(DICTS.en["wizard.title.language"]).toBe(DICTS["pt-br"]["wizard.title.language"]);
  });
});

describe("resolveLocale", () => {
  it("explicit flag wins over saved config and Intl", () => {
    mockedLoad.mockReturnValue({ version: 1, language: "en" });
    stubIntl("en-US");
    expect(resolveLocale("pt-br")).toBe("pt-br");
  });

  it("explicit 'en' wins over saved pt-br", () => {
    mockedLoad.mockReturnValue({ version: 1, language: "pt-br" });
    stubIntl("pt-BR");
    expect(resolveLocale("en")).toBe("en");
  });

  it("invalid explicit falls through to saved config", () => {
    mockedLoad.mockReturnValue({ version: 1, language: "pt-br" });
    stubIntl("en-US");
    expect(resolveLocale("fr")).toBe("pt-br");
  });

  it("no explicit/saved: Intl pt* → pt-br", () => {
    stubIntl("pt-BR");
    expect(resolveLocale()).toBe("pt-br");
  });

  it("no explicit/saved: Intl non-pt → en", () => {
    stubIntl("en-US");
    expect(resolveLocale(undefined)).toBe("en");
  });

  it("invalid saved language falls through to Intl", () => {
    mockedLoad.mockReturnValue({ version: 1, language: "de" as never });
    stubIntl("pt-PT");
    expect(resolveLocale()).toBe("pt-br");
  });

  it("Intl throwing (small-ICU builds) falls back to en", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("no ICU");
    });
    expect(resolveLocale()).toBe("en");
  });
});
