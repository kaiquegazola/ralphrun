// agents.test.ts — registry invariants. The point of the registry is that a new
// cli is ONE entry and every consumer picks it up; these tests fail if an entry
// is added half-way (the bug that left codex/agy out of BINARIES/DEFAULT_MODELS).

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  AGENTS,
  agentClis,
  agentDef,
  binOf,
  defaultModelOf,
  loadAgentManifests,
  manifestDir,
  nativeAdvisorArgs,
  supportsNativeAdvisor,
  type AgentDef,
  type AgentRole,
} from "./agents.js";
import { EXEC_ALLOWED_COMMANDS, EXEC_DENIED_COMMANDS } from "./reviewexec.js";
import { buildCmd } from "./adapters.js";
import { configDir } from "./userconfig.js";

// Only the two calls the manifest loader makes. Stubbing them also pins the
// registry under test to the BUILT-INS: a manifest sitting in the developer's
// own config dir must not decide whether this suite passes.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const ROLES: AgentRole[] = ["planner", "executor", "advisor"];

describe("registry completeness", () => {
  it.each(agentClis)("%s declares every field a consumer reads", (cli) => {
    const def = AGENTS[cli];
    expect(def.label).toBeTruthy();
    expect(typeof def.defaultModel).toBe("string"); // "" is valid: let the cli decide
    expect(def.models.length).toBeGreaterThan(0);
    if (def.sdk) {
      // an in-process backend has no binary and no argv — cursor-sdk.ts drives it
      expect(def.bin).toBeUndefined();
      expect(def.buildCmd).toBeUndefined();
    } else {
      expect(def.bin).toBeTruthy();
      expect(typeof def.buildCmd).toBe("function");
    }
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
    if (AGENTS[cli].sdk) return; // no argv to build (adapters.test.ts pins the throw instead)
    const cmd = AGENTS[cli].buildCmd!({
      bin: binOf(cli),
      prompt: "P",
      model: "M",
      cwd: "/w",
      autoApprove: false,
    });
    expect(cmd[0]).toBe(AGENTS[cli].bin);
    expect(cmd).toContain("P");
  });

  // Declaring reviewArgs and not placing them in the argv is the same half-entry
  // bug this file exists for: the field reads as "this cli reviews with tools"
  // while the spawned command still has none.
  it.each(agentClis)("%s buildCmd emits the reviewArgs it declares", (cli) => {
    const def = AGENTS[cli];
    if (!def.reviewArgs) return; // no tool grant: reviews the diff text alone
    const cmd = def.buildCmd!({
      bin: binOf(cli),
      prompt: "P",
      model: "M",
      cwd: "/w",
      autoApprove: false,
      reviewArgs: def.reviewArgs,
    });
    for (const arg of def.reviewArgs) expect(cmd).toContain(arg);
  });

  // The review deliberately runs at autoApprove:false so the advisor cannot write.
  // A grant that turns permissions off wholesale would hand back exactly what that
  // posture is there to withhold, so read-only has to mean an explicit allowlist.
  it.each(agentClis)("%s never grants review tools through a blanket approve flag", (cli) => {
    for (const arg of [...(AGENTS[cli].reviewArgs ?? []), ...(AGENTS[cli].reviewExecArgs ?? [])]) {
      expect(arg).not.toMatch(/skip-permissions|bypass|always-approve|--force|--auto\b/);
    }
  });

  // The execution grant is GENERATED from reviewexec.ts. Hand-editing it here is
  // how the policy ralphrun documents and tests stops being the policy the cli
  // enforces — which is the only enforcement there is.
  it.each(agentClis)("%s builds its exec grant from the shared allow/deny lists", (cli) => {
    const args = AGENTS[cli].reviewExecArgs;
    if (!args) return; // no execution grant: this cli reviews read-only
    const joined = args.join(" ");
    for (const cmd of EXEC_ALLOWED_COMMANDS) expect(joined).toContain(`Bash(${cmd}:*)`);
    for (const cmd of EXEC_DENIED_COMMANDS) expect(joined).toContain(`Bash(${cmd}:*)`);
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
    const cmd = AGENTS[cli].buildCmd!({ bin: binOf(cli), prompt: "P", model, cwd: "/w", autoApprove: true });
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

describe("agent manifests: a cli registered from JSON, without forking", () => {
  const VALID = {
    label: "My CLI",
    bin: "mycli",
    models: ["fast", "slow"],
    modelFlag: "--model",
    args: ["run", "-p"],
    autoApproveArgs: ["--yolo"],
  };

  // a string body is written verbatim (malformed JSON on purpose); anything
  // else is serialized like a real manifest file
  function withManifests(files: Record<string, unknown>): ReturnType<typeof loadAgentManifests> {
    vi.mocked(readdirSync).mockReturnValue(Object.keys(files) as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const body = files[basename(String(p))];
      if (body === undefined) throw new Error(`ENOENT: ${String(p)}`);
      return typeof body === "string" ? body : JSON.stringify(body);
    });
    return loadAgentManifests(join(configDir(), "agents"));
  }

  function only(files: Record<string, unknown>): AgentDef {
    const { agents, refusals } = withManifests(files);
    expect(refusals).toEqual([]);
    return agents[Object.keys(agents)[0]];
  }

  // manifests live next to config.json, not in a second invented location
  it("reads from <configDir>/agents", () => {
    expect(manifestDir()).toBe(join(configDir(), "agents"));
  });

  // the normal case: nobody has ever written a manifest
  it("is a no-op when the directory does not exist", () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadAgentManifests("/nope")).toEqual({ agents: {}, refusals: [] });
  });

  // the registry's consumers (pickers, preflight, adapters) read these fields
  // unconditionally — a compiled manifest has to satisfy the same invariants an
  // in-code entry does, or it half-registers a cli that only fails at spawn
  it("compiles into a def that satisfies every registry invariant", () => {
    const def = only({ "mycli.json": VALID });
    expect(def.label).toBe("My CLI");
    expect(def.bin).toBe("mycli");
    expect(def.defaultModel).toBe(""); // absent = let the cli choose
    expect(def.models).toEqual([
      { value: "fast", label: "fast" },
      { value: "slow", label: "slow" },
    ]);
    const known = def.models.map((m) => m.value);
    for (const role of ROLES) expect(known).toContain(def.recommended[role]);
  });

  it("takes its cli id from the file name", () => {
    const { agents } = withManifests({ "mycli.json": VALID });
    expect(Object.keys(agents)).toEqual(["mycli"]);
  });

  it("builds the argv the manifest describes", () => {
    const def = only({ "mycli.json": VALID });
    expect(def.buildCmd!({ bin: "mycli", prompt: "P", model: "fast", cwd: "/w", autoApprove: true })).toEqual([
      "mycli", "run", "-p", "P", "--model", "fast", "--yolo",
    ]);
    expect(def.buildCmd!({ bin: "mycli", prompt: "P", model: "", cwd: "/w", autoApprove: false })).toEqual([
      "mycli", "run", "-p", "P",
    ]);
  });

  // codex/opencode shape: the prompt is positional and has to come after the flags
  it("puts the prompt last when the manifest says so", () => {
    const def = only({ "mycli.json": { ...VALID, promptLast: true } });
    expect(def.buildCmd!({ bin: "mycli", prompt: "P", model: "fast", cwd: "/w", autoApprove: true })).toEqual([
      "mycli", "run", "-p", "--model", "fast", "--yolo", "P",
    ]);
  });

  // a stdin cli gets an EMPTY prompt from adapters; pushing "" would hand the
  // cli an empty positional argument instead of leaving the slot out
  it("keeps the prompt out of the argv for a stdin cli", () => {
    const def = only({ "mycli.json": { ...VALID, promptVia: "stdin" } });
    expect(def.promptVia).toBe("stdin");
    expect(def.buildCmd!({ bin: "mycli", prompt: "", model: "fast", cwd: "/w", autoApprove: false })).toEqual([
      "mycli", "run", "-p", "--model", "fast",
    ]);
  });

  it("emits reviewArgs only on the review call", () => {
    const def = only({ "mycli.json": { ...VALID, reviewArgs: ["--read-only"] } });
    const args = { bin: "mycli", prompt: "P", model: "", cwd: "/w", autoApprove: false };
    expect(def.buildCmd!({ ...args, reviewArgs: def.reviewArgs })).toContain("--read-only");
    expect(def.buildCmd!(args)).not.toContain("--read-only");
  });

  it("uses defaultModel as the recommended pick when it declares one", () => {
    const def = only({ "mycli.json": { ...VALID, defaultModel: "slow" } });
    expect(def.defaultModel).toBe("slow");
    for (const role of ROLES) expect(def.recommended[role]).toBe("slow");
  });

  // A file in ~/.config repointing `claude` at another binary would change what
  // every existing prd.json runs with nothing on screen saying so.
  it("refuses to redefine a built-in cli", () => {
    const { agents, refusals } = withManifests({ "claude.json": { ...VALID, bin: "evil" } });
    expect(agents).toEqual({});
    expect(refusals[0].cli).toBe("claude");
    expect(refusals[0].reason).toContain("built-in");
    expect(AGENTS.claude.bin).toBe("claude");
  });

  it.each([
    ["not JSON at all", "{ nope", "invalid JSON"],
    ["a JSON array", [], "JSON object"],
    ["no label", { ...VALID, label: "" }, '"label"'],
    ["no bin", { ...VALID, bin: undefined }, '"bin"'],
    ["no models", { ...VALID, models: [] }, '"models"'],
    ["a non-string model", { ...VALID, models: [1] }, '"models"'],
    ["no modelFlag", { ...VALID, modelFlag: undefined }, '"modelFlag"'],
    ["a defaultModel outside models", { ...VALID, defaultModel: "ghost" }, '"defaultModel"'],
    ["args that are not strings", { ...VALID, args: [{}] }, '"args"'],
    ["an unknown promptVia", { ...VALID, promptVia: "pipe" }, '"promptVia"'],
    ["a non-boolean promptLast", { ...VALID, promptLast: "yes" }, '"promptLast"'],
  ])("refuses a manifest with %s, naming the file and the field", (_case, body, expected) => {
    const { agents, refusals } = withManifests({ "mycli.json": body });
    expect(agents).toEqual({}); // refused means registered NOTHING, not half a cli
    expect(refusals).toHaveLength(1);
    expect(refusals[0].file).toMatch(/mycli\.json$/);
    expect(refusals[0].reason).toContain(expected);
  });

  // the review deliberately runs at autoApprove:false — the same rule the
  // built-ins are held to above, applied to input we do not control
  it("refuses reviewArgs that switch permissions off wholesale", () => {
    const { agents, refusals } = withManifests({ "mycli.json": { ...VALID, reviewArgs: ["--force"] } });
    expect(agents).toEqual({});
    expect(refusals[0].reason).toContain("--force");
  });

  // the id ends up in `--executor <cli>:<model>`; a name with a space (or the
  // ":" the spec splits on, which is not even a legal file name on Windows)
  // could never be typed back
  it("refuses a file name that cannot be typed as a cli id", () => {
    const { agents, refusals } = withManifests({ "my cli.json": VALID });
    expect(agents).toEqual({});
    expect(refusals[0].reason).toContain("cli id");
  });

  it("keeps the good manifests when a sibling is refused", () => {
    const { agents, refusals } = withManifests({ "good.json": VALID, "bad.json": "{" });
    expect(Object.keys(agents)).toEqual(["good"]);
    expect(refusals).toHaveLength(1);
  });
});

describe("native advisor is a capability, not a hardcoded cli name", () => {
  it("is NATIVE only when both sides are the same cli AND it declares nativeAdvisor", () => {
    expect(supportsNativeAdvisor("claude", "claude")).toBe(true);
    expect(supportsNativeAdvisor("claude", "codex")).toBe(false); // different clis → CROSS
    expect(supportsNativeAdvisor("cursor", "cursor")).toBe(false); // same cli, no server-side advisor
    expect(supportsNativeAdvisor("cursorsdk", "cursorsdk")).toBe(false);
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
