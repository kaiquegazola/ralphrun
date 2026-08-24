// reviewexec.ts — may a REVIEWER run this command?
//
// A reviewer that only reads a diff never catches an integration bug, so the
// review call can be given the right to RUN things (config: review_runs_commands).
// This module is the decision: one pure function over (program, args) that allows
// reads, builds and tests and refuses external mutation — push, publish, deploy,
// anything that touches the world outside the workspace.
//
// WHAT THIS IS AND IS NOT. ralphrun spawns a cli and the agent's tool calls never
// pass through us, so this function does not intercept anything (see README,
// "Permissions"). It is the SOURCE the per-cli allowlist flags are generated
// from — EXEC_ALLOWED_COMMANDS / EXEC_DENIED_COMMANDS below feed agents.ts, so
// the flags handed to the cli and the policy stated here cannot drift apart.
// The enforcement is the target cli's; this is the decision it is given.
//
// Default-deny is the whole design: the allowlist contains no program that
// writes outside a workspace (no rm/mv/cp/tee/chmod/ln), none that talks to a
// remote (no curl/ssh/scp/rsync/gh/docker/kubectl/aws/terraform), and no shell.
// That is how "no writes outside the workspace" is refused — by there being
// nothing on the list that could do it, not by inspecting paths.
//
// The honest limit of that claim: a test suite runs the repository's own code,
// so `npm test` is already arbitrary execution and no list can take that back.
// What the list CAN keep out is the arbitrary command the reviewer writes
// ITSELF, which is why `node -e` / `python3 -c` are refused while `node
// build/x.js` is not, and why `find` (whose own flags run and delete) is absent.

/** stdlib-only, imported by agents.ts (which must stay cycle-free) */
export interface ExecDecision {
  allowed: boolean;
  /** one line naming what was refused; "" when allowed */
  reason: string;
}

const ALLOW: ExecDecision = { allowed: true, reason: "" };
const deny = (reason: string): ExecDecision => ({ allowed: false, reason });

/**
 * inspection: none of these writes anything. `find` is deliberately NOT here —
 * `-delete` and `-exec` make it a writer and a runner, and the per-cli flags are
 * PREFIX matchers that cannot express "find, but not those flags". fd/rg/ls
 * cover what a reviewer actually needs it for.
 */
const READ_TOOLS = [
  "basename", "cat", "diff", "dirname", "du", "echo", "fd", "file", "grep",
  "head", "jq", "ls", "pwd", "rg", "sort", "stat", "tail", "tree", "uniq", "wc", "which",
];

/** build/test runtimes: they write build artifacts and caches, into the workspace */
const RUNTIMES = [
  "biome", "cargo", "clang", "cmake", "ctest", "cypress", "deno", "dotnet", "eslint",
  "gcc", "go", "gradle", "java", "javac", "jest", "just", "make", "mocha", "mvn", "mypy",
  "node", "php", "phpunit", "playwright", "prettier", "pytest", "python", "python3",
  "rake", "rspec", "ruby", "ruff", "rustc", "swift", "tox", "tsc", "vitest",
];

/** package managers: allowed, but their publishing/auth subcommands are not (below) */
export const RUNNERS = ["bun", "bunx", "bundle", "composer", "npm", "npx", "pipenv", "pnpm", "poetry", "uv", "uvx", "yarn"];

/** git subcommands that only READ the repository — a positive list, since git's mutating surface is most of it */
const GIT_READ_ONLY = ["blame", "describe", "diff", "grep", "log", "ls-files", "rev-parse", "shortlog", "show", "status"];

/**
 * Subcommands that publish, deploy or authenticate, on whichever runner offers
 * them. Checked against the first non-flag argument, which is where every
 * package manager puts its verb. Exported for the config-borne grants that
 * must mirror the run-script check.
 */
export const RELEASE_VERBS = ["publish", "unpublish", "deploy", "release", "login", "logout", "adduser", "token", "version"];

/**
 * Installs, on any runner. Not a workspace-local write like a build artifact.
 * worktree_per_task is OFF by default, so the reviewer usually runs in the
 * user's own checkout and an install rewrites it outright. Even with cells, a
 * cell's gitignored dirs are only CLONED where the filesystem can copy-on-write
 * and are SHARED by symlink where it cannot (worktree.ts seedIgnoredDir /
 * ignoredDirsWouldBeShared) — so the mutation can outlive the worktree being
 * discarded. An install is also minutes of wall clock, and the cell already has
 * its dependencies seeded, so a reviewer never needs this. Exported for the
 * config-borne grants, which have no argv ceiling and carry the full set.
 */
export const INSTALL_VERBS = ["install", "ci", "add", "remove", "uninstall", "update", "upgrade", "sync"];

/**
 * Interpreters take their program on the command line, which makes the flag the
 * payload: `node -e "<anything>"` is a shell with a different name, and it
 * carries no character SHELL_META would catch. Running a FILE stays allowed —
 * that is no wider than the test suite, which runs the same code. Exported for
 * the config-borne grants, which carry the full cross.
 */
export const INTERPRETERS = ["deno", "node", "php", "python", "python3", "ruby"];
export const INLINE_CODE_FLAGS = ["-e", "--eval", "-p", "--print", "-c", "--command", "-r", "-"];

/**
 * Runners whose real program is an ARGUMENT: `npx wrangler deploy` is a deploy,
 * not an npx. Two-token forms are listed as "runner subcommand"; the rest are
 * whole programs. The decision recurses into the remainder, which terminates
 * because each hop consumes at least one argument.
 */
export const INDIRECT_PAIRS = ["npm exec", "pnpm dlx", "pnpm exec", "yarn dlx", "bun x", "uv run", "poetry run", "pipenv run", "bundle exec"];
export const INDIRECT_PROGRAMS = ["npx", "bunx", "uvx"];
/** every indirect form — a runner reached through another runner is a hand-off */
export const INDIRECT_SUBFORMS = [...INDIRECT_PAIRS, ...INDIRECT_PROGRAMS];

/**
 * A metacharacter is how a second command rides along on a first one that
 * passed: we decide over (program, args), so if the cli re-joins them into a
 * shell string, "npm test; git push" would have been decided as "npm test".
 * Refusing them costs the occasional regex — a search pattern containing `|` or
 * `$` is refused and has to be rewritten — which is the cheaper side of this trade.
 */
const SHELL_META = /[;&|<>$`\n\r]/;

const ALLOWED_PROGRAMS = new Set([...READ_TOOLS, ...RUNTIMES, ...RUNNERS, "git"]);

/** every command shape a reviewer may run, as prefixes — the per-cli allowlist flags are built from this */
export const EXEC_ALLOWED_COMMANDS: string[] = [
  ...READ_TOOLS,
  ...RUNTIMES,
  ...RUNNERS,
  ...GIT_READ_ONLY.map((s) => `git ${s}`),
].sort();

/**
 * Refusals that are not a RELEASE_VERB on a runner: a program-specific verb, or
 * an install that lands in a shared prefix rather than in the workspace. Matched
 * as a PREFIX of the whole command, so the same entries serve the decision below
 * and the cli's own denylist.
 */
const EXTRA_DENIED = [
  "cargo publish", "cargo login", "gradle publish", "mvn deploy", "dotnet nuget",
  "go install", "npm install -g", "npm i -g", "pnpm add -g", "yarn global",
  // The inline-code forms, spelled out because a prefix matcher is all the cli's
  // denylist can carry. Only the spellings that EXIST: crossing every
  // interpreter with every flag would put `php --print` on a command line that
  // has 8191 characters to live within on Windows.
  "node -e", "node --eval", "node -p", "node --print", "python -c", "python3 -c",
  "ruby -e", "php -r", "deno eval",
];

/**
 * Installs for the cli's denylist. The decision below refuses INSTALL_VERBS on
 * every runner; this is the subset worth spending command line on — the verbs a
 * reviewer would actually reach for, on the managers that have them.
 */
const INSTALL_DENIED_VERBS = ["install", "i", "ci", "add", "update"];

/**
 * The refusals that must survive the allowlist. A prefix allowlist entry like
 * `npm` would otherwise cover `npm publish` too, so the release verbs are spelled
 * out per runner. git needs nothing here: it is allowed only as `git <read verb>`.
 *
 * The build tools are in EXTRA_DENIED by hand because only a few of them publish
 * at all — crossing every runtime with every verb would triple the command line
 * for combinations that do not exist (`vitest login`).
 */
export const EXEC_DENIED_COMMANDS: string[] = RUNNERS.flatMap((r) =>
  [...RELEASE_VERBS, ...INSTALL_DENIED_VERBS].map((v) => `${r} ${v}`),
)
  .concat(EXTRA_DENIED)
  .sort();

/** the program name as the allowlist sees it: bare, no directory, no .exe/.cmd */
function normalize(program: string): string {
  return program.trim().replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/** the first argument that is not a flag, and where it sits */
function firstVerb(args: string[]): { verb: string; rest: string[] } {
  const i = args.findIndex((a) => !a.startsWith("-"));
  return i === -1 ? { verb: "", rest: [] } : { verb: args[i].toLowerCase(), rest: args.slice(i + 1) };
}

/**
 * May the reviewer run `program args`? Pure, so it is testable on its own — and
 * it has to be, because it is the only part of this policy ralphrun actually owns.
 */
export function reviewExecDecision(program: string, args: string[] = []): ExecDecision {
  const name = normalize(program);
  if (!name) return deny("no program");
  // Checked before the allowlist: a metacharacter means the string is not the
  // single command we are being asked about, whatever the program says.
  if (SHELL_META.test(program) || args.some((a) => SHELL_META.test(a)))
    return deny("shell metacharacter — a second command could ride along");
  // A path means the binary is not the one the allowlist named: `./node` in the
  // workspace under review is a file the executor could have written.
  if (/[/\\]/.test(name)) return deny(`${program} is a path, not an allowed program name`);
  if (!ALLOWED_PROGRAMS.has(name)) return deny(`${name} is not on the reviewer's allowlist`);

  const { verb, rest } = firstVerb(args);
  if (INTERPRETERS.includes(name)) {
    const inline = args.find((a) => INLINE_CODE_FLAGS.includes(a.toLowerCase()));
    if (inline) return deny(`${name} ${inline} runs code written right here, which is a shell by another name`);
    if (name === "deno" && verb === "eval") return deny("deno eval runs code written right here");
  }
  if (INDIRECT_PROGRAMS.includes(name) || INDIRECT_PAIRS.includes(`${name} ${verb}`)) {
    const [next, ...tail] = INDIRECT_PROGRAMS.includes(name) ? [verb, ...rest] : rest;
    // a runner with nothing to run runs nothing, so there is nothing to refuse
    return next ? reviewExecDecision(next, tail) : ALLOW;
  }
  if (name === "git") {
    if (!GIT_READ_ONLY.includes(verb)) return deny(`git ${verb || "(no subcommand)"} is not a read-only git command`);
    return ALLOW;
  }
  const full = [name, ...args].join(" ").toLowerCase();
  const extra = EXTRA_DENIED.find((d) => full === d || full.startsWith(d + " "));
  if (extra) return deny(`${extra} reaches outside this workspace`);
  // A package manager's verb is not always the FIRST non-flag word — `npm
  // --access public publish` puts a flag VALUE in front of it, and nothing here
  // knows a flag's arity — so every word of a runner's command line is scanned.
  // A test runner is not scanned that way, or `pytest -k version` would read as
  // a release.
  const verbs = RUNNERS.includes(name) ? args.filter((a) => !a.startsWith("-")).map((a) => a.toLowerCase()) : [verb];
  const release = verbs.find((v) => RELEASE_VERBS.includes(v));
  if (release) return deny(`${name} ${release} mutates something outside this workspace`);
  // A global install writes into a shared prefix; a LOCAL one is no safer here,
  // because the reviewer's cwd is usually the user's own checkout and, in a
  // cell, node_modules is a symlink to it whenever the filesystem cannot clone
  // (see INSTALL_VERBS). "i" is npm's alias and is not spelled out in the cross
  // above.
  if (RUNNERS.includes(name) && (INSTALL_VERBS.includes(verb) || verb === "i"))
    return deny(`${name} ${verb} rewrites a dependency tree outside this attempt`);
  // `run <script>` executes whatever the manifest says, which we cannot read.
  // ponytail: the script NAME is the only signal there is; a release script
  // called something else gets through. Reading package.json here would make
  // this function impure for one heuristic, so it stays a name check.
  if (verb === "run" && RELEASE_VERBS.some((v) => (rest[0] ?? "").toLowerCase().includes(v)))
    return deny(`${name} run ${rest[0]} looks like a release script`);
  return ALLOW;
}
