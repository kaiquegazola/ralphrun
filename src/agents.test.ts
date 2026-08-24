// agents.test.ts — registry invariants. The point of the registry is that a new
// cli is ONE entry and every consumer picks it up; these tests fail if an entry
// is added half-way (the bug that left codex/agy out of BINARIES/DEFAULT_MODELS).

import { basename, dirname, join } from "node:path";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  AGENTS,
  agentClis,
  agentDef,
  binOf,
  defaultModelOf,
  inlineFits,
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

// Only the three calls the manifest loader and the opencode grant make. The
// spies wrap the actuals, so the grant's real file I/O still works and a test
// can override one call (a failing config write) without touching the rest.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => actual.writeFileSync(...args)),
  };
});

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
      expect(arg).not.toMatch(/skip-permissions|bypass|always-approve|dangerous|yolo|full-auto|--force|--auto\b/);
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
    // These lists are crossed products, so a verb added to one of them multiplies
    // by every runner. cross-spawn wraps the cli in cmd.exe on Windows, where the
    // whole command line dies past 8191 characters — and the failure there is the
    // reviewer never running at all.
    expect(joined.length).toBeLessThan(6000);
  });

  // opencode's grant is config-borne, but it is held to the SAME invariants as
  // claude's argv grant: generated from the shared lists, never a blanket
  // approve, and the denies must OUTRANK the allow prefixes (opencode resolves
  // rules last-match-wins, so order is the enforcement). A READ grant is small
  // enough to ride inline as the LAST config layer — nothing in the workspace
  // can loosen it. The exec bash rules are tens of KB (past Windows' 32KB env
  // block), so they ride in a temp FILE that cleanup() removes with its dir.
  it("opencode carries its review grant in config, generated from the shared lists", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const def = AGENTS.opencode;
    expect(def.reviewArgs).toBeUndefined(); // the argv stays clean; the grant is config-borne

    const readGrant = def.reviewEnv!("read", "/ws");
    const read = JSON.parse(readGrant.env.OPENCODE_CONFIG_CONTENT);
    expect(read.permission.bash).toBe("deny");
    expect(read.permission.edit).toBe("deny");
    expect(read.permission.webfetch).toBe("deny");
    expect(read.permission.read).toBe("allow");
    expect(read.permission["*"]).toBe("deny");
    // per-agent permissions outrank top-level ones in opencode's merge, so the
    // default agent is locked to the same rules — either layer wins
    expect(read.agent.build.permission.bash).toBe("deny");
    readGrant.cleanup(); // inline grant: nothing to remove

    const execGrant = def.reviewEnv!("exec", "/ws");
    // the inline layer is final for every key BUT bash, which is too big for
    // the env and rides in the file
    const inline = JSON.parse(execGrant.env.OPENCODE_CONFIG_CONTENT);
    expect(inline.permission.bash).toBeUndefined();
    expect(inline.permission.edit).toBe("deny");
    expect(inline.permission["*"]).toBe("deny");
    const exec = JSON.parse(fs.readFileSync(execGrant.env.OPENCODE_CONFIG, "utf8"));
    const bash = exec.permission.bash as Record<string, string>;
    expect(bash["*"]).toBe("deny"); // fallback first...
    const keys = Object.keys(bash);
    // the agent lock (with the bash rules) rides the file too — the env could
    // not carry it
    expect(exec.agent.build.permission.bash).toBeTypeOf("object");
    // ...allows next, denies LAST: last matching rule wins, so `npm publish`
    // must lose to the `npm *` shape exactly like --disallowedTools beats
    // --allowedTools on claude
    expect(keys.indexOf("npm *")).toBeLessThan(keys.indexOf("npm publish"));
    // EXACT-TOKEN shapes: a prefix like `node*` would also admit `nodejs -e`
    // and `node_modules/.bin/x` — binaries the decision refuses by name
    for (const cmd of EXEC_ALLOWED_COMMANDS) {
      if (["npx", "bunx", "uvx"].includes(cmd)) {
        // an indirect runner is expanded into per-program shapes, never a bare
        // `npx *`: the decision looks THROUGH npx to the real program
        expect(bash[`${cmd} *`]).toBeUndefined();
        expect(bash[`${cmd} vitest`]).toBe("allow");
      } else {
        expect(bash[cmd]).toBe("allow");
        expect(bash[`${cmd} *`]).toBe("allow");
      }
    }
    expect(bash["nodejs -e"]).toBeUndefined();
    expect(bash["node -e"]).toBe("deny"); // inline code stays refused
    for (const cmd of EXEC_DENIED_COMMANDS) {
      expect(bash[cmd]).toBe("deny");
      expect(bash[`${cmd} *`]).toBe("deny");
      // the denies reach one level under an indirect runner too: `npx npm
      // publish` must lose to `npx npm *` the same way `npm publish` loses
      expect(bash[`npx ${cmd}`]).toBe("deny");
      expect(bash[`npx -y ${cmd} *`]).toBe("deny");
      expect(keys.indexOf("npx vitest *")).toBeLessThan(keys.indexOf(`npx ${cmd}`));
    }
    // the decision skips leading flags (firstVerb), so `npx -y tsc` is allowed
    // by the policy and the grant must not over-block it
    expect(bash["npx -y tsc *"]).toBe("allow");
    // ...but a flag cluster before a VERB is still the verb: the decision
    // scans every non-flag word, so `npm --access public publish` must lose
    expect(bash["npm -* publish*"]).toBe("deny");
    expect(bash["npx npm -* publish*"]).toBe("deny");
    expect(bash["npx -y npm -* publish*"]).toBe("deny");
    expect(bash["pnpm exec npm -* publish*"]).toBe("deny");
    expect(keys.indexOf("npm *")).toBeLessThan(keys.indexOf("npm -* publish*"));
    // ...and the shell-metacharacter refusals sit over every allow, so a chain
    // cannot ride in on a leading prefix (`cat x; git push` matches `cat *`)
    for (const meta of [";", "&", "|", "<", ">", "`", "$"]) {
      expect(bash[`*${meta}*`]).toBe("deny");
      expect(keys.indexOf("npm *")).toBeLessThan(keys.indexOf(`*${meta}*`));
    }
    // hand-off denies: a runner may not reach another indirect form — directly
    // (`uv run curl`) or through an indirect program (`npx uv run curl`) — and
    // the re-open covers an ALLOWED program only, with the denied command
    // shapes riding over it (`pnpm exec npm publish`)
    expect(bash["uv run*"]).toBe("deny");
    expect(bash["uv run prettier"]).toBe("allow");
    expect(bash["npx uv run*"]).toBe("deny");
    expect(bash["npx -y uv run*"]).toBe("deny");
    expect(bash["pnpm exec npm *"]).toBe("allow");
    expect(bash["pnpm exec npm publish*"]).toBe("deny");
    expect(keys.indexOf("pnpm exec npm *")).toBeLessThan(keys.indexOf("pnpm exec npm publish*"));
    // entry checks are NOT enough: opencode resolves LAST-MATCH, so the tests
    // must evaluate the rule set the way opencode would — the last pattern
    // matching the command wins, and a `*` crosses spaces. This is what catches
    // a broad deny silently shadowing the allows above it.
    const globToRegex = (pattern: string): RegExp =>
      new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[\\s\\S]*")}$`,
      );
    const effective = (command: string): string | undefined => {
      let verdict: string | undefined;
      for (const [pattern, action] of Object.entries(bash)) {
        if (globToRegex(pattern).test(command)) verdict = action;
      }
      return verdict;
    };
    expect(effective("npx vitest run src/foo.test.ts")).toBe("allow");
    expect(effective("npx -y tsc --noEmit")).toBe("allow");
    expect(effective("npm test")).toBe("allow");
    expect(effective("node script.js")).toBe("allow");
    expect(effective("uv run prettier --check .")).toBe("allow");
    // every read-only git verb the policy allows stays allowed
    for (const git of ["git diff HEAD~1", "git log --oneline -5", "git show HEAD:src/foo.ts", "git shortlog test"]) {
      expect(effective(git), git).toBe("allow");
    }
    expect(effective("npx wrangler deploy")).toBe("deny");
    expect(effective("npx uv run curl")).toBe("deny");
    expect(effective("npm publish")).toBe("deny");
    expect(effective("npm --access public publish")).toBe("deny");
    expect(effective("npm run publish")).toBe("deny");
    expect(effective("npm --silent run publish")).toBe("deny");
    expect(effective("npm uninstall lodash")).toBe("deny");
    expect(effective("node -r /tmp/evil.js x")).toBe("deny");
    expect(effective("node --eval=code")).toBe("deny");
    expect(effective("pnpm exec npm publish")).toBe("deny");
    // exactly one hand-off, never into another runner — the documented
    // over-block that keeps the boundary exact instead of bottomless
    expect(effective("npm exec npx vitest")).toBe("deny");
    expect(effective("npm exec npx npm publish")).toBe("deny");
    expect(effective("node -e 'x'")).toBe("deny");
    expect(effective("git push")).toBe("deny");
    expect(effective("cat package.json; git push")).toBe("deny");
    expect(effective("curl https://evil.example")).toBe("deny");
    execGrant.cleanup();
    expect(fs.existsSync(execGrant.env.OPENCODE_CONFIG)).toBe(false);
    // the whole temp directory goes with it, not just the file inside it
    expect(fs.existsSync(dirname(execGrant.env.OPENCODE_CONFIG))).toBe(false);
  });

  // A user's own opencode config — inline here — is merged in as the BASE, the
  // grant's permission keys moved LAST, so their config survives and every key
  // the grant names still wins the tie.
  it("opencode merges its grant under existing OPENCODE_CONFIG_CONTENT, permission last", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const def = AGENTS.opencode;
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: "opencode/big-pickle",
      mcp: { docs: { url: "https://example.com" } },
      permission: { websearch: "allow", "*": "allow" },
    });
    try {
      const granted = def.reviewEnv!("read", "/ws");
      const merged = JSON.parse(granted.env.OPENCODE_CONFIG_CONTENT);
      expect(merged.model).toBe("opencode/big-pickle"); // their config survives
      expect(merged.mcp.docs.url).toBe("https://example.com");
      expect(merged.permission["*"]).toBe("deny"); // the grant's keys win the tie
      expect(merged.permission.read).toBe("allow");
      // their own permission rules do NOT ride the inline layer — they can be
      // arbitrarily large, and the grant's keys override them anyway
      expect(merged.permission.websearch).toBeUndefined();
      granted.cleanup();
      // on an EXEC grant they live in the FILE layer, sorted BEFORE the grant's
      // keys — delete-then-set keeps last-match-wins crowning the grant
      const execGrant = def.reviewEnv!("exec", "/ws");
      const execFile = JSON.parse(fs.readFileSync(execGrant.env.OPENCODE_CONFIG, "utf8"));
      expect(execFile.permission.websearch).toBe("allow");
      const order = Object.keys(execFile.permission);
      expect(order.indexOf("websearch")).toBeLessThan(order.indexOf("*"));
      expect(execFile.agent.build.permission["*"]).toBe("deny");
      execGrant.cleanup();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });

  // The same merge for a config FILE the user pointed OPENCODE_CONFIG at —
  // resolved against the REVIEWER's cwd (the workspace), not ralphrun's, and
  // DEEP-merged, so a section named by both sources keeps the other's entries.
  it("opencode merges its grant under a user's OPENCODE_CONFIG file too", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const def = AGENTS.opencode;
    const previousPath = process.env.OPENCODE_CONFIG;
    const previousContent = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG = "opencode.json"; // relative: the reviewer's cwd, not ralphrun's
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { issues: { url: "https://issues.example.com" } } });
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({ model: "from-file", mcp: { docs: { url: "https://docs.example.com" } } }),
    );
    try {
      const granted = def.reviewEnv!("read", "/ws");
      expect(readFileSync).toHaveBeenLastCalledWith(join("/ws", "opencode.json"), "utf8");
      const merged = JSON.parse(granted.env.OPENCODE_CONFIG_CONTENT);
      expect(merged.model).toBe("from-file");
      expect(merged.mcp.docs.url).toBe("https://docs.example.com"); // the file's nested entries survive
      expect(merged.mcp.issues.url).toBe("https://issues.example.com"); // ...alongside the inline ones
      expect(merged.permission.read).toBe("allow");
      granted.cleanup();
    } finally {
      if (previousPath === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previousPath;
      if (previousContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previousContent;
    }
  });

  // A file that cannot be read is skipped, not inherited — same as content
  // that does not parse or carries no object.
  it("opencode skips an unreadable OPENCODE_CONFIG file", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const def = AGENTS.opencode;
    const previousPath = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = "/gone/opencode.json";
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    try {
      const granted = def.reviewEnv!("read", "/ws");
      const merged = JSON.parse(granted.env.OPENCODE_CONFIG_CONTENT);
      expect(merged.model).toBeUndefined();
      expect(merged.permission.read).toBe("allow");
      granted.cleanup();
    } finally {
      if (previousPath === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previousPath;
    }
  });

  // opencode configs are commonly JSONC — comments and trailing commas — and
  // a strict JSON.parse would silently drop the user's providers and models.
  it("opencode merges a JSONC config, comments and trailing commas included", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const def = AGENTS.opencode;
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = [
      "{",
      '  /* the free tier model — pinned',
      '     across every task */',
      '  "model": "opencode/big-pickle", // chosen at /connect',
      '  "note": "a \\"quoted\\" value", // escapes survive too',
      '  "url": "https://example.com", // a URL its // must survive',
      '  "mcp": {"docs": {"url": "https://docs.example.com"}}, // comma before a comment, before the brace',
      '  "extra": 1, /* a block comment after the comma too */',
      "}",
    ].join("\n");
    try {
      const granted = def.reviewEnv!("read", "/ws");
      const merged = JSON.parse(granted.env.OPENCODE_CONFIG_CONTENT);
      expect(merged.model).toBe("opencode/big-pickle");
      expect(merged.url).toBe("https://example.com");
      expect(merged.note).toBe('a "quoted" value');
      expect(merged.mcp.docs.url).toBe("https://docs.example.com");
      expect(merged.permission.read).toBe("allow");
      granted.cleanup();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });

  // A user config big enough to blow the env block rides in a file; CONTENT
  // keeps only the permission — small, and still the final layer.
  it("opencode moves a huge user config to the file and keeps CONTENT to the permission", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const def = AGENTS.opencode;
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ models: "x".repeat(25_000) });
    try {
      const granted = def.reviewEnv!("read", "/ws");
      expect(granted.env.OPENCODE_CONFIG.length).toBeGreaterThan(0); // the file exists
      const file = JSON.parse(fs.readFileSync(granted.env.OPENCODE_CONFIG, "utf8"));
      expect(file.models).toHaveLength(25_000); // the user's config survives, in the file
      const inline = JSON.parse(granted.env.OPENCODE_CONFIG_CONTENT);
      expect(inline.models).toBeUndefined(); // and stays out of the env
      expect(inline.permission.read).toBe("allow");
      expect(inline.agent.build.permission.read).toBe("allow");
      granted.cleanup();
      expect(fs.existsSync(granted.env.OPENCODE_CONFIG)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });

  // The agent lock must not erase the user's own agent config — their fields
  // survive and only the permission is replaced.
  it("opencode's agent lock keeps the user's own agent fields", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const def = AGENTS.opencode;
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      agent: { build: { description: "mine" }, reviewer: { description: "theirs" } },
    });
    try {
      const granted = def.reviewEnv!("read", "/ws");
      const merged = JSON.parse(granted.env.OPENCODE_CONFIG_CONTENT);
      expect(merged.agent.build.description).toBe("mine");
      expect(merged.agent.build.permission.bash).toBe("deny");
      expect(merged.agent.reviewer.description).toBe("theirs"); // other agents untouched
      granted.cleanup();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });

  // The inline budget counts the WHOLE environment the child gets — a big
  // inherited CI env pushes even a modest grant into the file.
  it("opencode falls back to the file when the inherited environment eats the budget", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const def = AGENTS.opencode;
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    const previousBig = process.env.RALPHRUN_TEST_BIG_ENV;
    process.env.RALPHRUN_TEST_BIG_ENV = "x".repeat(19_500);
    delete process.env.OPENCODE_CONFIG_CONTENT;
    try {
      const granted = def.reviewEnv!("read", "/ws");
      expect(granted.env.OPENCODE_CONFIG.length).toBeGreaterThan(0); // file path, not inline
      expect(granted.env.OPENCODE_CONFIG_CONTENT.length).toBeLessThan(1000); // permission only
      const inline = JSON.parse(granted.env.OPENCODE_CONFIG_CONTENT);
      expect(inline.permission.read).toBe("allow");
      granted.cleanup();
      expect(fs.existsSync(granted.env.OPENCODE_CONFIG)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
      if (previousBig === undefined) delete process.env.RALPHRUN_TEST_BIG_ENV;
      else process.env.RALPHRUN_TEST_BIG_ENV = previousBig;
    }
  });

  // the budget counts values it cannot measure as zero rather than crashing —
  // an env entry without a string value is one variable, not a TypeError
  it("the inline budget tolerates an env entry with no value", () => {
    expect(inlineFits("x", { A: undefined, B: "y" })).toBe(true);
    expect(inlineFits("x".repeat(20_000), { B: "y" })).toBe(false);
  });

  // Content that does not parse cannot be merged, so it is replaced rather
  // than inherited — and a non-object (array, string, null) likewise.
  it("opencode replaces unparseable or non-object OPENCODE_CONFIG_CONTENT", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const def = AGENTS.opencode;
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    for (const junk of ["{ nope", JSON.stringify(["a"]), JSON.stringify("s"), "null", "  ", '{ "a": "x\\']) {
      process.env.OPENCODE_CONFIG_CONTENT = junk;
      try {
        const granted = def.reviewEnv!("read", "/ws");
        const merged = JSON.parse(granted.env.OPENCODE_CONFIG_CONTENT);
        expect(merged.permission.read).toBe("allow");
        expect(merged.model).toBeUndefined();
        granted.cleanup();
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
        else process.env.OPENCODE_CONFIG_CONTENT = previous;
      }
    }
  });

  // A grant whose config cannot be WRITTEN must throw — the caller fails the
  // review on it, and must never hand a reviewer the cli's unscoped defaults —
  // and the directory it may have created goes with the failure. (A read
  // grant writes nothing: it rides inline.)
  it("opencode removes the temp directory when the config write fails", () => {
    const def = AGENTS.opencode;
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    expect(() => def.reviewEnv!("exec", "/ws")).toThrow("ENOSPC");
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

  // args/autoApproveArgs are the fields a first manifest leaves out: the cli
  // takes its prompt positionally and has no permission flag to give. Absent must
  // mean "add nothing", not an argv with an undefined spread into it.
  it("builds an argv from a manifest that declares only the required fields", () => {
    const def = only({ "mycli.json": { label: "My CLI", bin: "mycli", models: ["fast"], modelFlag: "-m" } });
    expect(def.buildCmd!({ bin: "mycli", prompt: "P", model: "fast", cwd: "/w", autoApprove: true })).toEqual([
      "mycli", "P", "-m", "fast",
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
    ["a non-string defaultModel", { ...VALID, defaultModel: 3 }, '"defaultModel"'],
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
  it.each(["--force", "--yolo", "--dangerously-skip-permissions", "--full-auto", "--yes"])(
    "refuses reviewArgs that switch permissions off wholesale (%s)",
    (flag) => {
      // --yolo is the one a user actually reaches for: it is what the README's
      // own manifest example puts in autoApproveArgs, one copy-paste away from
      // reviewArgs, and it used to sail straight through this check.
      const { agents, refusals } = withManifests({ "mycli.json": { ...VALID, reviewArgs: [flag] } });
      expect(agents).toEqual({});
      expect(refusals[0].reason).toContain(flag);
    },
  );

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

  // A refusal that only lands in an exported array is a manifest that quietly
  // does nothing, and the preflight then blames the user's PATH for a cli that
  // was never registered. Re-imports the module so the load-time pass runs again.
  it("names a refused manifest on stderr at import time", async () => {
    vi.mocked(readdirSync).mockReturnValue(["bad.json"] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue("{ nope" as unknown as ReturnType<typeof readFileSync>);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const fresh = await import("./agents.js");
      expect(fresh.manifestRefusals).toHaveLength(1);
      expect(err).toHaveBeenCalledWith(expect.stringContaining("ignoring agent manifest"));
    } finally {
      err.mockRestore();
      vi.resetModules();
    }
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
