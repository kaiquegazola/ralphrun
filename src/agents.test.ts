// agents.test.ts — registry invariants. The point of the registry is that a new
// cli is ONE entry and every consumer picks it up; these tests fail if an entry
// is added half-way (the bug that left codex/agy out of BINARIES/DEFAULT_MODELS).

import { describe, it, expect } from "vitest";
import {
  AGENTS,
  agentClis,
  agentDef,
  binOf,
  defaultModelOf,
  nativeAdvisorArgs,
  supportsNativeAdvisor,
  type AgentRole,
} from "./agents.js";
import { buildCmd } from "./adapters.js";

const ROLES: AgentRole[] = ["planner", "executor", "advisor"];

describe("registry completeness", () => {
  it.each(agentClis)("%s declares every field a consumer reads", (cli) => {
    const def = AGENTS[cli];
    expect(def.label).toBeTruthy();
    expect(def.bin).toBeTruthy();
    expect(typeof def.defaultModel).toBe("string"); // "" is valid: let the cli decide
    expect(def.models.length).toBeGreaterThan(0);
    expect(typeof def.buildCmd).toBe("function");
  });

  it.each(agentClis)("%s recommends a REAL model for every role", (cli) => {
    const def = AGENTS[cli];
    const known = new Set(def.models.map((m) => m.value));
    for (const role of ROLES) {
      const rec = def.recommended[role];
      expect(rec, `${cli}.recommended.${role} missing`).toBeTruthy();
      expect(known, `${cli}.recommended.${role}=${rec} is not in models[]`).toContain(rec);
    }
  });

  it.each(agentClis)("%s defaultModel, when set, is a real model", (cli) => {
    const def = AGENTS[cli];
    if (!def.defaultModel) return; // "" = let the cli pick its own
    expect(def.models.map((m) => m.value)).toContain(def.defaultModel);
  });

  it.each(agentClis)("%s buildCmd starts with its binary and carries the prompt", (cli) => {
    const cmd = AGENTS[cli].buildCmd({
      bin: binOf(cli),
      prompt: "P",
      model: "M",
      cwd: "/w",
      autoApprove: false,
    });
    expect(cmd[0]).toBe(AGENTS[cli].bin);
    expect(cmd).toContain("P");
  });
});

describe("model names containing spaces", () => {
  // agy ships models like "Gemini 3.1 Pro (High)". We spawn WITHOUT a shell, so
  // the name must survive as ONE argv element — never split on the space.
  const spaced = agentClis.flatMap((cli) =>
    AGENTS[cli].models.filter((m) => m.value.includes(" ")).map((m) => [cli, m.value] as const),
  );

  it("exist in the registry (guards the assertion below from silently passing)", () => {
    expect(spaced.length).toBeGreaterThan(0);
  });

  it.each(spaced)("%s passes %s to the cli as a single argument", (cli, model) => {
    const cmd = AGENTS[cli].buildCmd({ bin: binOf(cli), prompt: "P", model, cwd: "/w", autoApprove: true });
    expect(cmd).toContain(model);
    expect(cmd.filter((a) => a.includes("Gemini") || a.includes("Claude") || a.includes("GPT-OSS"))).toHaveLength(1);
  });
});

describe("lookups fall back safely on an unknown cli", () => {
  it("binOf returns the cli name itself", () => {
    expect(binOf("claude")).toBe("claude");
    expect(binOf("cursor")).toBe("cursor-agent");
    expect(binOf("nope")).toBe("nope");
  });

  it("defaultModelOf returns empty", () => {
    expect(defaultModelOf("claude")).toBe("sonnet");
    expect(defaultModelOf("nope")).toBe("");
  });

  it("agentDef returns undefined", () => {
    expect(agentDef("nope")).toBeUndefined();
  });

  it("does NOT resolve inherited Object.prototype keys as agents", () => {
    // null-prototype registry: "constructor"/"hasOwnProperty" are unknown clis,
    // not inherited members that would make buildCmd() throw the wrong error.
    for (const proto of ["constructor", "hasOwnProperty", "toString", "__proto__"]) {
      expect(agentDef(proto)).toBeUndefined();
      expect(binOf(proto)).toBe(proto);
      expect(() => buildCmd(proto, "p", "m", "/w", false)).toThrow("unknown cli");
    }
  });
});

describe("native advisor is a capability, not a hardcoded cli name", () => {
  it("is NATIVE only when both sides are the same cli AND it declares nativeAdvisor", () => {
    expect(supportsNativeAdvisor("claude", "claude")).toBe(true);
    expect(supportsNativeAdvisor("claude", "codex")).toBe(false); // different clis → CROSS
    expect(supportsNativeAdvisor("cursor", "cursor")).toBe(false); // same cli, no server-side advisor
    expect(supportsNativeAdvisor("claude", null)).toBe(false); // no advisor at all
    expect(supportsNativeAdvisor("claude", undefined)).toBe(false);
    expect(supportsNativeAdvisor("nope", "nope")).toBe(false); // unknown cli
  });

  it("yields the advisor flags for a native cli and nothing for the rest", () => {
    expect(nativeAdvisorArgs("claude", "fable")).toEqual(["--advisor", "fable"]);
    expect(nativeAdvisorArgs("cursor", "fable")).toEqual([]);
    expect(nativeAdvisorArgs("nope", "fable")).toEqual([]);
  });
});
