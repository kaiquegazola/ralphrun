// identity.test.ts — the same agent must look the same on a task card, a
// worktree row and the roster, so the mapping is pinned here.

import { describe, it, expect } from "vitest";

import { agentColor, agentInitials } from "./identity.ts";

const FALLBACK = ["#5aa7f0", "#f0b04e", "#ee6a5f", "#53d08a", "#c58af9"];

describe("agentColor", () => {
  it("keeps the mockup colour for every designed cli", () => {
    expect(agentColor("claude")).toBe("#f08a63");
    expect(agentColor("codex")).toBe("#4cc8c0");
    expect(agentColor("cursor")).toBe("#a98cf5");
    expect(agentColor("cursorsdk")).toBe("#a98cf5"); // the sdk is the same product
    expect(agentColor("opencode")).toBe("#a3d05a");
    expect(agentColor("grok")).toBe("#8b94a7");
    expect(agentColor("agy")).toBe("#5aa7f0");
  });

  it("gives an unknown cli a colour from the fallback palette", () => {
    expect(FALLBACK).toContain(agentColor("gemini"));
  });

  it("gives the same unknown cli the same colour every time — a card must not flicker between renders", () => {
    const runs = Array.from({ length: 5 }, () => agentColor("gemini"));
    expect(new Set(runs).size).toBe(1);
  });

  it("spreads unknown clis across the palette rather than parking them all on one entry", () => {
    const names = ["gemini", "aider", "goose", "devin", "cline", "continue", "windsurf", "amp"];
    expect(new Set(names.map(agentColor)).size).toBeGreaterThan(1);
  });

  // a five-slot palette collides freely, so only assert where it must not:
  // the registry keys are lowercase, and a mis-cased cli is a different agent
  it("treats a mis-cased cli as its own name rather than the designed one", () => {
    expect(agentColor("Claude")).not.toBe(agentColor("claude"));
    expect(agentInitials("Claude")).toBe("Cl");
  });

  it("still returns a palette colour for an empty cli", () => {
    expect(FALLBACK).toContain(agentColor(""));
  });
});

describe("agentInitials", () => {
  it("keeps the designed initials, including the pair that share a colour", () => {
    expect(agentInitials("claude")).toBe("cl");
    expect(agentInitials("codex")).toBe("cx");
    expect(agentInitials("cursor")).toBe("cu");
    expect(agentInitials("cursorsdk")).toBe("cs");
    expect(agentInitials("opencode")).toBe("oc");
    expect(agentInitials("grok")).toBe("gk");
    expect(agentInitials("agy")).toBe("ag");
  });

  it("falls back to the first two characters of an unknown cli", () => {
    expect(agentInitials("gemini")).toBe("ge");
    expect(agentInitials("aider")).toBe("ai");
  });

  it("does not pad a one-character or empty cli", () => {
    expect(agentInitials("q")).toBe("q");
    expect(agentInitials("")).toBe("");
  });
});
