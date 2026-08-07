// prompts.test.ts — cover build/advisor/inject/review/parse + read/standards
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  BLOCKED_MARKER,
  readStandards,
  buildPrompt,
  advisorPrompt,
  injectAdvice,
  reviewPrompt,
  parseReview,
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
  it("tells the executor to leave committing to the loop", () => {
    const p = buildPrompt(task, prd);
    expect(p).toContain("Do NOT run `git add` or `git commit`");
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

  // The reviewer used to judge a diff without knowing whether anything ran on it,
  // so it asked for changes the failing output already explained.
  it("shows the verify command, the verdict, and the output tail", () => {
    const t: Task = { ...task, verify: "npm test" };
    const out = reviewPrompt(t, prd, "STD", "the diff", { passed: false, output: "1 failing: expected 2 got 3" });
    expect(out).toContain("## Verification");
    expect(out).toContain("Command: npm test");
    expect(out).toContain("Result: FAILED");
    expect(out).toContain("expected 2 got 3");
    // the loop already feeds a failing run back to the executor — the reviewer
    // restating it burns a round on feedback nobody needed
    expect(out).toContain("do not spend your verdict");
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
});
