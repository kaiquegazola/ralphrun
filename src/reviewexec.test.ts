// reviewexec.test.ts — the reviewer's allow/deny decision
//
// This function is the only part of the execution policy ralphrun actually owns
// (the enforcement is the target cli's), so it is tested from both sides: every
// refusal that matters, and — just as load-bearing — every command a reviewer
// legitimately needs. A reviewer that cannot run the test suite is pointless,
// so an over-blocking decision is a failure here, not a safe default.
import { describe, it, expect } from "vitest";
import { EXEC_ALLOWED_COMMANDS, EXEC_DENIED_COMMANDS, reviewExecDecision } from "./reviewexec.js";

const allows = (program: string, ...args: string[]): boolean => reviewExecDecision(program, args).allowed;

describe("reviewExecDecision — what a reviewer needs", () => {
  it.each([
    ["npm", ["test"]],
    ["npm", ["run", "test:unit"]],
    ["pnpm", ["vitest", "run"]],
    ["npx", ["vitest", "run", "src/foo.test.ts"]],
    ["npx", ["-y", "tsc", "--noEmit"]],
    ["yarn", ["jest"]],
    ["node", ["scripts/repro.mjs"]],
    ["pytest", ["-k", "auth"]],
    ["uv", ["run", "pytest"]],
    ["go", ["test", "./..."]],
    ["cargo", ["test"]],
    ["make", ["check"]],
    ["tsc", ["--noEmit"]],
    ["rg", ["TODO", "src"]],
    ["cat", ["package.json"]],
    ["ls", ["-la", "src"]],
    ["git", ["diff", "HEAD~1"]],
    ["git", ["log", "--oneline", "-5"]],
    ["git", ["show", "HEAD:src/foo.ts"]],
  ])("allows %s %j", (program, args) => {
    expect(reviewExecDecision(program, args)).toEqual({ allowed: true, reason: "" });
  });

  // A reviewer reproducing the acceptance scenario runs a local server or a
  // browser check, and both of those are just `node`/`npx <runner>`.
  it("allows a reproduction script with no arguments at all", () => {
    expect(allows("node")).toBe(true);
  });
});

describe("reviewExecDecision — external mutation", () => {
  it.each([
    ["git", ["push"]],
    ["git", ["push", "--force", "origin", "main"]],
    ["git", ["commit", "-m", "x"]],
    ["git", ["reset", "--hard"]],
    ["git", ["clean", "-fd"]],
    ["git", ["rebase", "-i", "main"]],
    ["git", ["tag", "v1"]],
    ["git", []],
    ["npm", ["publish"]],
    ["npm", ["--access", "public", "publish"]],
    ["npm", ["version", "patch"]],
    ["npm", ["login"]],
    ["yarn", ["publish"]],
    ["cargo", ["publish"]],
    ["poetry", ["publish"]],
    ["npm", ["run", "deploy:prod"]],
    ["npm", ["run", "release"]],
    ["npm", ["install", "-g", "wrangler"]],
    ["go", ["install", "./cmd/foo"]],
    // An install is not a workspace-local write: every worktree in a wave shares
    // ONE physical node_modules, so this rewrites the user's own dependency tree
    // and every sibling task's, and no worktree discard can roll that back.
    ["npm", ["ci"]],
    ["npm", ["install"]],
    ["npm", ["i", "lodash"]],
    ["pnpm", ["add", "-D", "vitest"]],
    ["uv", ["sync"]],
    // An interpreter handed code inline is a shell with a different name, and it
    // carries no character SHELL_META would ever catch.
    ["node", ["-e", "require('fs').rmSync(process.env.HOME + '/.aws', {recursive: true})"]],
    ["node", ["--eval", "fetch('https://x.example', {method: 'POST'})"]],
    ["python3", ["-c", "import shutil; shutil.rmtree('/tmp/x')"]],
    ["ruby", ["-e", "puts 1"]],
    ["deno", ["eval", "Deno.exit(0)"]],
    ["python", ["-"]],
  ])("refuses %s %j", (program, args) => {
    expect(reviewExecDecision(program, args).allowed).toBe(false);
  });

  // The point of refusing `-e` is not to refuse the interpreter: running a FILE
  // is exactly what a reproduction script is, and it is no wider than the test
  // suite, which runs the repository's code anyway.
  it("still allows an interpreter running a file from the workspace", () => {
    expect(allows("node", "scripts/repro.mjs", "--verbose")).toBe(true);
    expect(allows("python3", "-m", "pytest")).toBe(true);
  });
});

describe("reviewExecDecision — programs off the list", () => {
  // Default-deny is what makes the allowlist a policy instead of a suggestion:
  // every deploy tool below is refused by NOT being on it, so a new one shipped
  // tomorrow is refused too without anyone updating a denylist.
  it.each(["kubectl", "docker", "terraform", "aws", "gcloud", "wrangler", "vercel", "netlify", "fly", "heroku", "ssh", "scp", "rsync", "curl", "wget", "gh", "rm", "mv", "cp", "chmod", "sudo", "sh", "bash", "zsh"])(
    "refuses %s",
    (program) => {
      expect(allows(program, "anything")).toBe(false);
    },
  );

  it("refuses an empty program instead of falling through to the allowlist", () => {
    expect(allows("")).toBe(false);
    expect(allows("   ")).toBe(false);
  });
});

describe("reviewExecDecision — the ways around it", () => {
  // We decide over (program, args). If the cli re-joins them into a shell
  // string, "npm test; git push" would have been decided as "npm test" — so the
  // metacharacter is refused before the program is even looked up.
  it.each([";", "&&", "|", ">", "<", "$(id)", "`id`"])("refuses an argument containing %s", (meta) => {
    expect(allows("npm", "test", `x${meta}git push`)).toBe(false);
  });

  it("refuses a metacharacter in the program itself", () => {
    expect(allows("npm;git push", "test")).toBe(false);
  });

  // The allowlist names programs, not files. `./node` in the workspace under
  // review is a file the executor could have just written.
  it.each(["./node", "/usr/bin/node", "node_modules/.bin/vitest", ".\\node.exe"])("refuses the path %s", (program) => {
    expect(allows(program)).toBe(false);
  });

  // A runner whose real program is an argument has to be decided on THAT
  // program: `npx wrangler deploy` is a deploy, not an npx.
  it.each([
    ["npx", ["wrangler", "deploy"]],
    ["npx", ["-y", "vercel", "--prod"]],
    ["bunx", ["netlify", "deploy"]],
    ["pnpm", ["dlx", "gh", "release", "create"]],
    ["uv", ["run", "twine"]],
    ["bundle", ["exec", "rm", "-rf", "/"]],
    ["npm", ["exec", "kubectl"]],
  ])("looks through %s %j to the real program", (program, args) => {
    expect(allows(program, ...(args as string[]))).toBe(false);
  });

  it("still allows a legitimate program reached through a runner", () => {
    expect(allows("pnpm", "dlx", "prettier", "--check", ".")).toBe(true);
    expect(allows("bundle", "exec", "rspec")).toBe(true);
  });

  // Case and a Windows extension are spelling, not policy.
  it("normalizes the program name before deciding", () => {
    expect(allows("NPM", "test")).toBe(true);
    expect(allows("node.exe")).toBe(true);
    expect(allows("KUBECTL", "get", "pods")).toBe(false);
  });

  it("names what it refused, so a log line says more than 'denied'", () => {
    expect(reviewExecDecision("kubectl", ["apply"]).reason).toContain("kubectl");
    expect(reviewExecDecision("git", ["push"]).reason).toContain("git push");
  });
});

// The per-cli flags (agents.ts) are GENERATED from these two lists. If a command
// the function allows is missing from the allow list, the cli refuses something
// the policy permits; if a command it refuses is missing from the deny list, a
// prefix match like `Bash(npm:*)` hands back exactly what this module withheld.
describe("the lists the cli flags are built from", () => {
  it("allows every command it publishes as allowed", () => {
    for (const cmd of EXEC_ALLOWED_COMMANDS) {
      const [program, ...args] = cmd.split(" ");
      expect(reviewExecDecision(program, args), cmd).toEqual({ allowed: true, reason: "" });
    }
  });

  it("refuses every command it publishes as denied", () => {
    for (const cmd of EXEC_DENIED_COMMANDS) {
      const [program, ...args] = cmd.split(" ");
      expect(reviewExecDecision(program, args).allowed, cmd).toBe(false);
    }
  });

  // A prefix-matching allowlist covers the mutating verbs of anything it names,
  // so every allowed program that HAS a publish verb needs a matching refusal.
  it("denies a release verb on every runner it allows outright", () => {
    for (const cmd of EXEC_DENIED_COMMANDS) expect(cmd).not.toMatch(/^git /); // git is allowed per-subcommand
    expect(EXEC_DENIED_COMMANDS).toContain("npm publish");
    expect(EXEC_DENIED_COMMANDS).toContain("pnpm publish");
    expect(EXEC_DENIED_COMMANDS).toContain("yarn publish");
    expect(EXEC_DENIED_COMMANDS).toContain("cargo publish");
  });

  it("never allows git as a bare program", () => {
    expect(EXEC_ALLOWED_COMMANDS).not.toContain("git");
    expect(EXEC_ALLOWED_COMMANDS.filter((c) => c.startsWith("git ")).length).toBeGreaterThan(0);
  });
});
