// prompts.test.ts — cover build/advisor/inject/review/parse + read/standards
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import {
  BLOCKED_MARKER,
  hostEnvironmentBlock,
  scopeBlock,
  readStandards,
  buildPrompt,
  advisorPrompt,
  injectAdvice,
  injectHandoff,
  reviewPrompt,
  parseExecutionReport,
  parseReview,
  isSafeVerifyReplacement,
} from "./prompts.js";
import type { PRD, Task } from "./prd.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const task: Task = {
  id: "T1",
  title: "Do a thing",
  status: "todo",
  deps: [],
  retries: 0,
  description: "desc",
  acceptance: ["a1", "a2"],
};
const prd: PRD = {
  project: "Proj",
  stack: "TS",
  architecture_notes: "notes",
  tasks: [task],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readStandards", () => {
  it("returns joined blocks for files that exist, truncated to 6000", () => {
    vi.mocked(existsSync).mockImplementation((f) => String(f).endsWith("CLAUDE.md"));
    vi.mocked(readFileSync).mockReturnValue("X".repeat(7000) as unknown as string);
    const out = readStandards("/ws");
    expect(out).toContain("### CLAUDE.md");
    expect(out).not.toContain("### AGENTS.md");
    // 6000-char slice
    expect(out.length).toBeLessThan(6100);
    expect(existsSync).toHaveBeenCalledWith("/ws/CLAUDE.md");
  });

  it("returns empty string when nothing exists", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(readStandards("/ws")).toBe("");
  });

  it("joins both files", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("body" as unknown as string);
    const out = readStandards("/ws");
    expect(out).toContain("### CLAUDE.md");
    expect(out).toContain("### AGENTS.md");
    expect(out).toContain("\n\n");
  });
});

describe("buildPrompt", () => {
  it("includes the generated host environment guidance", () => {
    const out = buildPrompt(task, prd);
    expect(out).toContain("## Host environment");
    // the block renders a display name per platform, not the raw process.platform
    const osName: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
    expect(out).toContain(`Operating system: ${osName[process.platform] ?? process.platform} (${process.platform})`);
    expect(out).toContain("Before relying on an optional command-line tool");
  });

  it("includes the task host requirement when one is declared", () => {
    const hostTask: Task = { ...task, required_host: "darwin" };
    const out = buildPrompt(hostTask, { ...prd, tasks: [hostTask] });
    expect(out).toContain("This task must run on one of these host platforms: darwin");
  });

  it("includes standards block when standards present", () => {
    const out = buildPrompt(task, prd, "STD");
    expect(out).toContain("Project standards");
    expect(out).toContain("STD");
    expect(out).toContain("T1 — Do a thing");
    expect(out).toContain("- a1");
  });
  // an executor that ends its turn on "do you authorize X?" gets no answer: it
  // idles until task_timeout and burns one of the retries (observed in the wild
  // with a `prisma db push --force-reset` the model did not want to run alone)
  it("tells the executor nobody can answer it, and what to do with destructive steps", () => {
    // whitespace-normalized: the assertions are about the rules, not the wrapping
    const out = buildPrompt(task, prd).replace(/\s+/g, " ");
    expect(out).toContain("NOBODY is reading your output");
    expect(out).toContain("never ask; decide");
    expect(out).toContain("prefer a non-destructive path");
    // the safety boundaries are the point of the rule — pin them, not the prose
    expect(out).toContain("names that exact target as safe to destroy or reset");
    expect(out).toContain('"It looks disposable" is NOT enough');
    expect(out).toContain("outside this workspace");
    expect(out).toContain("anything shared (staging, production");
    expect(out).toContain("files tracked by git that you did not create in this task");
    expect(out).toContain("any file you did not generate yourself, even if it looks generated");
    expect(out).toContain("no reset, rebase, amend, revert, force-push");
    expect(out).toContain("no `git clean`");
    // and the escape hatch must be the marker, never a question or a fake done
    expect(out).toContain("do NOT ask and do NOT pretend the task is done");
    expect(out).toContain(BLOCKED_MARKER);
  });

  // the loop commits the task's own files under the project's convention; an
  // executor that commits itself splits one task across several commits and
  // leaves them behind even when the task ends up blocked
  // the next attempt is handed these lines; without them it re-derives the dead
  // ends this one already paid for
  it("asks the executor to close with what it changed and what it learned", () => {
    const out = buildPrompt(task, prd).replace(/\s+/g, " ");
    expect(out).toContain("what you changed");
    expect(out).toContain("anything you learned that the diff does not show");
  });

  it("tells the executor to leave committing to the loop", () => {
    const p = buildPrompt(task, prd);
    expect(p).toContain("Do NOT run `git add` or `git commit`");
  });

  it("asks for a preflight check and an explicit already-satisfied state", () => {
    const out = buildPrompt(task, prd).replace(/\s+/g, " ");
    expect(out).toContain("Before editing, inspect the current files and acceptance criteria");
    expect(out).toContain("state=<changed|already_satisfied>");
    expect(out).toContain("Use state=already_satisfied only after inspecting");
  });

  it("stops advisor guidance from widening the rules", () => {
    const out = injectAdvice(buildPrompt(task, prd), "just ask the user first").replace(/\s+/g, " ");
    expect(out).toContain("It is advice, not permission");
    expect(out).toContain("if it suggests asking a human");
  });
  it("omits standards block when empty (default arg)", () => {
    const out = buildPrompt(task, prd);
    expect(out).not.toContain("Project standards");
  });
  it("appends the browser guide only when the task's verify uses dev-browser", () => {
    expect(buildPrompt(task, prd)).not.toContain("Browser validation");
    const browserTask: Task = { ...task, verify: "npm run build && dev-browser --headless < e2e.mjs" };
    const out = buildPrompt(browserTask, { ...prd, tasks: [browserTask] });
    expect(out).toContain("Browser validation");
    expect(out).toContain("dev-browser --help");
  });
});

describe("advisorPrompt", () => {
  it("renders with and without standards", () => {
    expect(advisorPrompt(task, prd, "STD")).toContain("Project standards");
    expect(advisorPrompt(task, prd)).not.toContain("Project standards");
    expect(advisorPrompt(task, prd)).toContain("a1; a2");
    expect(advisorPrompt(task, prd)).toContain("Concurrency preflight");
    expect(advisorPrompt(task, prd)).toContain("Treat missing isolation evidence as unsafe");
    expect(advisorPrompt(task, prd)).toContain("## Host environment");
  });

  it("includes the task host requirement", () => {
    const hostTask: Task = { ...task, required_host: ["linux", "darwin"] };
    expect(advisorPrompt(hostTask, { ...prd, tasks: [hostTask] })).toContain(
      "This task must run on one of these host platforms: linux, darwin",
    );
  });
});

describe("hostEnvironmentBlock", () => {
  it("gives Windows-specific command and path guidance", () => {
    const out = hostEnvironmentBlock("win32");
    expect(out).toContain("Operating system: Windows (win32)");
    expect(out).toContain("drive letters and backslashes");
    expect(out).toContain("do not assume bash, sh, GNU utilities, or POSIX syntax");
  });

  it("does not prescribe Windows paths on Unix hosts", () => {
    const out = hostEnvironmentBlock("linux");
    expect(out).toContain("Operating system: Linux (linux)");
    expect(out).toContain("do not assume Windows drive-letter paths");
    expect(out).not.toContain("do not assume bash, sh, GNU utilities, or POSIX syntax");
  });
});

describe("scopeBlock", () => {
  const scoped: Task = { ...task, scope: ["packages/db/src/schema/auth.ts", "apps/api/tests/auth/**"] };
  const workspace = sep === "\\" ? "C:\\ws" : "/ws";

  it("names a missing scope directory as the task's to create", () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).replace(/\\/g, "/").endsWith("apps/api/tests"));
    const out = scopeBlock(scoped, workspace);
    expect(out).toContain("- packages/db/src/schema/auth.ts  (packages/db/src/schema/ does not exist yet — create it)");
    expect(out).toContain("- apps/api/tests/auth/**");
    expect(out).not.toContain("apps/api/tests/ does not exist yet — create it");
  });

  it("marks nothing when every scope directory is already there", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(scopeBlock(scoped, workspace)).not.toContain("— create it)");
  });

  // the executor was judged by this gate without ever being shown it
  it("reaches the executor and the advisor, not just the reviewer", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(buildPrompt(scoped, prd, "", workspace)).toContain("## Declared scope (a hard plan contract)");
    expect(advisorPrompt(scoped, prd, "", workspace)).toContain("## Declared scope (a hard plan contract)");
  });

  it("does not invent a contract for an unscoped task", () => {
    const out = scopeBlock({ ...task, scope: [] }, "/ws");
    expect(out).toContain("No scope is declared");
    expect(out).not.toContain("hard plan contract");
  });

  it("does not tell the executor to create an out-of-workspace scope", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const out = scopeBlock({ ...task, scope: ["../outside/file.ts"] }, workspace);
    expect(out).toContain("- ../outside/file.ts");
    expect(out).not.toContain("does not exist yet — create it");
  });

  it("does not reinterpret an absolute scope as workspace-relative", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const out = scopeBlock({ ...task, scope: ["/outside/file.ts"] }, workspace);
    expect(out).toContain("- /outside/file.ts");
    expect(out).not.toContain("does not exist yet — create it");
  });

  it("does not reinterpret a drive-relative scope as workspace-relative", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const out = scopeBlock({ ...task, scope: ["C:outside/file.ts"] }, workspace);
    expect(out).toContain("- C:outside/file.ts");
    expect(out).not.toContain("does not exist yet — create it");
  });

  it("keeps advisor scope guidance stable when a directory is missing", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(scopeBlock({ ...task, scope: ["src/new/file.ts"] }, workspace, false)).not.toContain(
      "src/new/ does not exist yet",
    );
  });
});

describe("injectAdvice", () => {
  it("appends advice section", () => {
    const out = injectAdvice("BASE", "ADV");
    expect(out).toContain("BASE");
    expect(out).toContain("Advisor guidance");
    expect(out).toContain("ADV");
  });
});

describe("reviewPrompt", () => {
  it("includes the generated host environment guidance", () => {
    expect(reviewPrompt(task, prd, "", "the diff")).toContain("## Host environment");
  });

  it("includes diff and acceptance", () => {
    const out = reviewPrompt(task, prd, "STD", "the diff");
    expect(out).toContain("## Diff");
    expect(out).toContain("the diff");
    expect(out).toContain("- a1");
    expect(out).toContain("Project standards");
    expect(out).not.toContain("No diff");
  });

  // the reviewer decides whether "no change" satisfies the task, so it has to be
  // told that is what it is looking at — an empty ## Diff section reads as a bug
  it("explains an empty diff instead of showing an empty section", () => {
    const out = reviewPrompt(task, prd, "STD", "   ");
    expect(out).toContain("## No diff");
    expect(out).toContain("made NO changes");
    expect(out).toContain("is NOT evidence that the work was already done");
    expect(out).toContain("- a1"); // still judged against the same acceptance
  });

  // The reviewer used to be told "do NOT use tools", so a diff cut at 12k chars
  // was the whole evidence it was allowed to have. It may read now — but reading
  // is all it may do: the review runs without auto-approve for that reason.
  it("lets the reviewer read the workspace while still forbidding any change", () => {
    const out = reviewPrompt(task, prd, "STD", "the diff").replace(/\s+/g, " ");
    expect(out).toContain("Do NOT write, edit, delete or run anything");
    expect(out).toContain("You MAY read the workspace");
    expect(out).toContain("CUT at a fixed size");
    expect(out).toContain("read the real files");
  });

  // With no diff there is nothing to read in the prompt at all, so the files are
  // the only evidence — "it already works" has to be checked, not assumed.
  it("sends the reviewer to the files when there is no diff", () => {
    const out = reviewPrompt(task, prd, "STD", "   ").replace(/\s+/g, " ");
    expect(out).toContain("Read the files this task names");
    expect(out).toContain("check it instead of assuming it");
  });

  it("says nothing about verification when the caller has no verdict to give", () => {
    expect(reviewPrompt(task, prd, "STD", "the diff")).not.toContain("## Verification");
  });

  it("gives the reviewer the hard scope contract and plan escape rule", () => {
    const scoped = { ...task, scope: ["src/modules/auth/**", "src/app.ts"] };
    const out = reviewPrompt(scoped, prd, "STD", "the diff").replace(/\s+/g, " ");
    expect(out).toContain("Declared scope:");
    expect(out).toContain("- src/modules/auth/**");
    expect(out).toContain("fix the executor can make WITHIN");
    expect(out).toContain("problem with the PLAN");
    expect(out).toContain("outside it");
  });

  // The reviewer used to judge a diff without knowing whether anything ran on it,
  // so it asked for changes the failing output already explained.
  it("shows the verify command, the verdict, and the output tail", () => {
    const t: Task = { ...task, verify: "npm test" };
    const out = reviewPrompt(t, prd, "STD", "the diff", { passed: false, output: "1 failing: expected 2 got 3" });
    expect(out).toContain("## Verification");
    expect(out).toContain("Command: npm test");
    expect(out).toContain("Result: FAILED");
    expect(out).toContain("expected 2 got 3");
    expect(out).toContain("top-level");
    expect(out).toContain("exact replacement command");
    // the loop already feeds a failing run back to the executor — the reviewer
    // restating it burns a round on feedback nobody needed
    expect(out).toContain("do not spend your verdict");
  });

  // A gate that passes silently is the common case (`tsc --noEmit` prints
  // nothing), and an empty "Output (tail):" heading reads as output that was
  // lost rather than output that never existed.
  it("leaves the output heading out when the command printed nothing", () => {
    const t: Task = { ...task, verify: "tsc --noEmit" };
    const out = reviewPrompt(t, prd, "STD", "the diff", { passed: true, output: "  \n" });
    expect(out).toContain("Result: PASSED");
    expect(out).not.toContain("Output (tail)");
  });

  it("carries review state and prior findings to the reviewer", () => {
    const out = reviewPrompt(task, prd, "STD", "the diff", undefined, false, {
      cycle: 2,
      maxCycles: 20,
      previousFindings: [
        { id: "R1", severity: "major", criterion: "AC-1", problem: "missing guard", fix: "add guard" },
      ],
      previousHandoff: "EXECUTION_REPORT: addressed=R1",
    }).replace(/\s+/g, " ");
    expect(out).toContain("Cycle 2 of the absolute 20 cycle ceiling");
    expect(out).toContain("R1");
    expect(out).toContain("EXECUTION_REPORT: addressed=R1");
  });

  // THE point of the section. run.ts gates on the same flag independently, so a
  // reviewer handed a green run and no instruction reads it as a verdict and
  // rubber-stamps — which quietly turns two gates back into one.
  it("tells the reviewer that a green run is necessary but never sufficient", () => {
    const t: Task = { ...task, verify: "npm test" };
    const out = reviewPrompt(t, prd, "STD", "the diff", { passed: true, output: "42 passed" }).replace(/\s+/g, " ");
    expect(out).toContain("Result: PASSED");
    expect(out).toContain("NECESSARY but NOT SUFFICIENT");
    expect(out).toContain("NOT an approval");
    expect(out).toContain("Judge what the tests do not catch");
  });

  // Gate 2 already ran task.verify and its result is in the prompt. A reviewer
  // that spends its (much larger) budget re-running it has bought a slower copy
  // of an answer it was handed — the whole value of this mode is what it runs
  // INSTEAD.
  it("tells a running reviewer not to re-run the verify command", () => {
    const t: Task = { ...task, verify: "npm test" };
    const out = reviewPrompt(t, prd, "STD", "the diff", { passed: true, output: "ok" }, true).replace(/\s+/g, " ");
    expect(out).toContain("Do NOT re-run `npm test`");
    expect(out).toContain("Run what the verify command does NOT cover");
    expect(out).toContain("acceptance scenario end to end");
  });

  // A task with no verify command has nothing already-run to avoid, and naming a
  // command that does not exist would just be noise.
  it("omits the do-not-re-run line when the task declares no verify", () => {
    const out = reviewPrompt(task, prd, "STD", "the diff", undefined, true);
    expect(out).not.toContain("Do NOT re-run");
    expect(out).toContain("Run what the verify command does NOT cover");
  });

  // Running is not writing: whatever it runs, its reply is still the only thing
  // that leaves, and the commit belongs to the executor's task.
  it("still forbids a running reviewer from changing the workspace", () => {
    const out = reviewPrompt(task, prd, "STD", "the diff", undefined, true).replace(/\s+/g, " ");
    expect(out).toContain("Do NOT write, edit or delete anything");
    expect(out).toContain("your reply IS your whole output");
    expect(out).toContain("refused by the allowlist");
  });

  // The default is the read-only posture, and it has to keep saying "do not run
  // anything": telling a reviewer with no execution grant that it may run things
  // costs a round of refused tool calls.
  it("keeps the read-only posture unless the caller asks for the running one", () => {
    const out = reviewPrompt(task, prd, "STD", "the diff");
    expect(out).toContain("Do NOT write, edit, delete or run anything");
    expect(out).not.toContain("you can RUN things");
  });

  it("truncates a huge verify output to a tail", () => {
    const t: Task = { ...task, verify: "npm test" };
    const out = reviewPrompt(t, prd, "STD", "d", { passed: false, output: "HEAD" + "z".repeat(5000) + "TAIL" });
    expect(out).toContain("TAIL");
    expect(out).not.toContain("HEAD");
  });

  // A task with no verify command has the reviewer as its ONLY gate; saying so is
  // the difference between a careful read and a glance.
  it("tells the reviewer it is the only gate when the task declares no verify", () => {
    const out = reviewPrompt(task, prd, "STD", "the diff", { passed: true, output: "" });
    expect(out).toContain("declares NO verify command");
    expect(out).toContain("only");
    expect(out).not.toContain("Result: PASSED"); // nothing ran, so there is no verdict to report
  });

  it("passes an already-satisfied executor claim as untrusted reviewer context", () => {
    const out = reviewPrompt(task, prd, "STD", "", undefined, false, {
      cycle: 1,
      maxCycles: 20,
      executionReport: {
        state: "already_satisfied",
        changed: "none",
        tests: "npm test passed",
        evidence: "all acceptance criteria are present",
        raw: "EXECUTION_REPORT: state=already_satisfied; changed=none; tests=npm test passed; evidence=all acceptance criteria are present",
      },
    }).replace(/\s+/g, " ");
    expect(out).toContain("state=already_satisfied");
    expect(out).toContain("context only, not evidence or approval");
    expect(out).toContain("return CHANGES with a concrete fix");
    expect(out).toContain("NO new changes in this attempt");
    expect(out).toContain("APPROVE only if all criteria already hold");
    expect(out).not.toContain("An unchanged workspace is NOT evidence");
  });
});

describe("parseExecutionReport", () => {
  it("parses the structured already-satisfied state", () => {
    expect(parseExecutionReport(
      "EXECUTION_REPORT: state=already_satisfied; changed=none; tests=typecheck passed; evidence=acceptance already holds; remaining=none; dead_end=none",
    )).toMatchObject({
      state: "already_satisfied",
      changed: "none",
      tests: "typecheck passed",
      evidence: "acceptance already holds",
      remaining: "none",
      deadEnd: "none",
    });
  });

  it("ignores legacy reports without an explicit state", () => {
    expect(parseExecutionReport("EXECUTION_REPORT: changed=none; tests=passed; remaining=none")).toBeUndefined();
    expect(parseExecutionReport("final prose without a report")).toBeUndefined();
  });
});

describe("parseReview", () => {
  // a gate that could not read a verdict has judged nothing — only the two
  // documented shapes approve, everything else falls through to NOT approved
  it("empty verdict -> NOT approved", () => {
    expect(parseReview("")).toEqual({ approved: false, changes: "" });
  });
  it("APPROVE -> approved", () => {
    expect(parseReview("  approve  ")).toEqual({ approved: true, changes: "" });
  });
  it("accepts the textual VERDICT form from the structured protocol", () => {
    expect(parseReview("VERDICT: APPROVE")).toEqual({ approved: true, changes: "", note: undefined });
    expect(parseReview("VERDICT: CHANGES\n- add the missing guard").changes).toContain("add the missing guard");
  });
  it("CHANGES with colon -> not approved with trimmed changes", () => {
    const r = parseReview("CHANGES: fix x\nfix y");
    expect(r.approved).toBe(false);
    expect(r.changes).toBe("fix x\nfix y");
  });
  it("colon-in-changes keeps only first colon boundary", () => {
    const r = parseReview("CHANGES: do a:b thing");
    expect(r.approved).toBe(false);
    expect(r.changes).toBe("do a:b thing");
  });
  it("CHANGES without colon -> empty changes", () => {
    const r = parseReview("CHANGES no colon here");
    expect(r.approved).toBe(false);
    expect(r.changes).toBe("");
  });
  it("truncates changes to 4000", () => {
    const r = parseReview("CHANGES: " + "z".repeat(5000));
    expect(r.changes.length).toBe(4000);
  });
  it("no APPROVE / no CHANGES -> NOT approved, with nothing to hand the executor", () => {
    expect(parseReview("looks fine to me")).toEqual({ approved: false, changes: "" });
  });
  it("parses a structured review finding with evidence", () => {
    const r = parseReview(
      'VERDICT: CHANGES\n{"verdict":"CHANGES","findings":[{"id":"R1","severity":"major","criterion":"AC-2","location":"src/foo.ts:42","problem":"missing guard","fix":"reject empty input","evidence":"test reproduces it"}]}',
    );
    expect(r.approved).toBe(false);
    expect(r.findings).toEqual([
      {
        id: "R1",
        severity: "major",
        criterion: "AC-2",
        location: "src/foo.ts:42",
        problem: "missing guard",
        fix: "reject empty input",
        evidence: "test reproduces it",
      },
    ]);
    expect(r.changes).toContain("R1");
  });
  it("parses a verify replacement only on CHANGES", () => {
    expect(
      parseReview(
        '{"verdict":"CHANGES","verify":"bun --env-file=.env.local test ./apps/api/src/modules/auth","findings":[]}',
      ),
    ).toMatchObject({ approved: false, verify: "bun --env-file=.env.local test ./apps/api/src/modules/auth" });
    expect(parseReview('{"verdict":"APPROVE","verify":"rm -rf /","findings":[]}')).not.toHaveProperty("verify");
  });
  it("rejects unsafe or oversized verify replacements", () => {
    expect(parseReview('{"verdict":"CHANGES","verify":"bun test\\nrm -rf /","findings":[]}')).not.toHaveProperty("verify");
    for (const verify of ["bun test && rm -rf /", "bun test; rm -rf /", "bun test | tee out", "bun test > out", "bun test $(touch pwned)"]) {
      expect(parseReview(JSON.stringify({ verdict: "CHANGES", verify, findings: [] }))).not.toHaveProperty("verify");
    }
    expect(parseReview(JSON.stringify({ verdict: "CHANGES", verify: "x".repeat(2001), findings: [] }))).not.toHaveProperty("verify");
  });
  it("keeps an automatic verify repair in the original command family", () => {
    expect(isSafeVerifyReplacement("bun test ./apps/api", "bun --env-file=.env.local test ./apps/api")).toBe(true);
    expect(isSafeVerifyReplacement("bun test ./apps/api", "true")).toBe(false);
    expect(isSafeVerifyReplacement("bun test ./apps/api", "rm -rf .")).toBe(false);
    expect(isSafeVerifyReplacement("bun test ./apps/api", "bun -e 'rm -rf .'" )).toBe(false);
    expect(isSafeVerifyReplacement("node test.js", "node --eval=process.exitCode=1 test.js")).toBe(false);
    expect(isSafeVerifyReplacement("node test.js", "node --require=/tmp/pwn.js test.js")).toBe(false);
    expect(isSafeVerifyReplacement("npm test", "PATH=/tmp npm test")).toBe(false);
    expect(isSafeVerifyReplacement("npm test", "/tmp/npm test")).toBe(false);
    expect(isSafeVerifyReplacement("npm test", "npm --prefix /tmp test")).toBe(false);
    expect(isSafeVerifyReplacement("bun test", "bun --env-file=.env.local test")).toBe(true);
    expect(isSafeVerifyReplacement("bun test", "bun --env-file .env.local test")).toBe(true);
    expect(isSafeVerifyReplacement("bun test", "bun --env-file=/tmp/pwn test")).toBe(false);
    expect(isSafeVerifyReplacement("bun --env-file=.env test", "bun test")).toBe(false);
    expect(isSafeVerifyReplacement("bun --env-file=/tmp/.env test", "bun --env-file=.env test")).toBe(true);
    expect(isSafeVerifyReplacement("bun test", "bun --env-file=%TEMP%\\secret.env test")).toBe(false);
    expect(isSafeVerifyReplacement("bun test", 'bun --env-file="/tmp/pwn" test')).toBe(false);
    expect(isSafeVerifyReplacement("bun test", "bun --env-file=C:secret.env test")).toBe(false);
    expect(isSafeVerifyReplacement('bun test "#"', "bun --env-file=.env test #")).toBe(false);
    expect(isSafeVerifyReplacement("npm test", "npm install test")).toBe(false);
    expect(isSafeVerifyReplacement("npm test", "npm uninstall test")).toBe(false);
    expect(isSafeVerifyReplacement("bun test ./apps/api", "bun test ./apps/other")).toBe(false);
    expect(isSafeVerifyReplacement("git status", "git clean -fd")).toBe(false);
    expect(isSafeVerifyReplacement("bun test ./apps/api", "npm test ./apps/api")).toBe(false);
  });
  it("parses structured approval and does not carry findings", () => {
    expect(parseReview('{"verdict":"APPROVE","findings":[]}')).toEqual({ approved: true, changes: "", findings: [] });
  });
  it("parses a valid Conventional Commit proposal only on approval", () => {
    expect(
      parseReview(
        '{"verdict":"APPROVE","findings":[],"commit":{"type":"feat","scope":"review-loop","subject":"make review handoff adaptive"}}',
      ),
    ).toEqual({
      approved: true,
      changes: "",
      findings: [],
      commit: { type: "feat", scope: "review-loop", subject: "make review handoff adaptive" },
    });
  });
  it("drops malformed commit metadata and keeps the approval", () => {
    const r = parseReview('{"verdict":"APPROVE","findings":[],"commit":{"type":"wat","subject":"bad"}}');
    expect(r).toEqual({ approved: true, changes: "", findings: [] });
  });
  it("drops commit metadata containing control characters", () => {
    const r = parseReview(
      '{"verdict":"APPROVE","findings":[],"commit":{"type":"fix","scope":"review\\u0000","subject":"safe"}}',
    );
    expect(r).toEqual({ approved: true, changes: "", findings: [] });
  });
  it("does not accept commit metadata on CHANGES", () => {
    const r = parseReview('{"verdict":"CHANGES","findings":[],"commit":{"type":"fix","subject":"fix it"}}');
    expect(r).toEqual({ approved: false, changes: "", findings: [] });
  });
});

// A retry starts a brand-new session in a workspace whose previous attempt may
// have been rolled back, so without this it re-derives the dead ends the last
// one already paid for.
// The gates are the whole feature. A reviewer asked to "note what it learned"
// notes everything, and every line lands in EVERY later prompt of the run.
describe("the architecture-note contract", () => {
  it("offers the note only after APPROVE, and says no note is the usual answer", () => {
    const out = reviewPrompt(task, prd, "", "diff").replace(/\s+/g, " ");
    expect(out).toContain("After APPROVE only");
    expect(out).toContain("writing none is the correct and usual answer");
    expect(out).toContain("If you are unsure, write no note");
  });

  // the negative gates matter more than the positive ones: they are what stop
  // the notes becoming the accumulated summary the fresh-context rule forbids
  it("names what is NOT a note", () => {
    const out = reviewPrompt(task, prd, "", "diff").replace(/\s+/g, " ");
    expect(out).toContain("CANNOT be learned by reading the code");
    expect(out).toContain("what this task did (that is the diff)");
    expect(out).toContain("where code lives");
    expect(out).toContain("stays true after this task");
  });
});

describe("parseReview note", () => {
  it("reads a note off an approval", () => {
    const r = parseReview("APPROVE\nNOTE: the webhook endpoint is unreachable from CI");
    expect(r.approved).toBe(true);
    expect(r.note).toBe("the webhook endpoint is unreachable from CI");
  });

  it("has none when the reviewer wrote none", () => {
    expect(parseReview("APPROVE").note).toBeUndefined();
    expect(parseReview("APPROVE\nNOTE:   ").note).toBeUndefined();
  });

  // a note on a rejection describes an attempt about to be redone, and taking it
  // would let a task write to the notes without passing a single gate
  it("ignores a note attached to a rejection", () => {
    const r = parseReview("CHANGES: fix it\nNOTE: something durable");
    expect(r.approved).toBe(false);
    expect(r.note).toBeUndefined();
  });

  // this text is prepended to every later prompt, so a reviewer that ignores
  // "one line" must not buy itself unbounded space in everyone else's context
  it("keeps one line and caps it", () => {
    const r = parseReview("APPROVE\nNOTE: first line\nsecond line");
    expect(r.note).toBe("first line");
    expect(parseReview("APPROVE\nNOTE: " + "z".repeat(500)).note).toHaveLength(300);
  });
});

describe("injectHandoff", () => {
  it("appends the previous attempt's account", () => {
    const out = injectHandoff("BASE", "tried the webhook, unreachable from CI");
    expect(out).toContain("BASE");
    expect(out).toContain("## What the previous attempt reported");
    expect(out).toContain("unreachable from CI");
  });

  // it describes a run that did NOT succeed, so a retry that treats it as fact
  // inherits the mistake that caused the failure
  it("frames it as a lead, never as fact", () => {
    const out = injectHandoff("BASE", "x").replace(/\s+/g, " ");
    expect(out).toContain("Treat it as a lead, not as fact");
    expect(out).toContain("may be exactly what went wrong");
  });

  it("changes nothing when there was no previous attempt", () => {
    expect(injectHandoff("BASE", undefined)).toBe("BASE");
    expect(injectHandoff("BASE", "   ")).toBe("BASE");
  });
});
