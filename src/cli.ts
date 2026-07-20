// cli.ts — Commander setup. Root action = run the loop; subcommands: init, config.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { resolveLocale, setLocale, t } from "./i18n.js";
import { runLoop } from "./loop.js";
import { initWizard } from "./wizard.js";
import { editConfig, resetGlobal, showConfig, showGlobal } from "./configcmd.js";

// Commander .description() strings evaluate at import time, BEFORE parse —
// peek argv for --lang so descriptions (and --help) render in the right locale.
export function peekLang(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lang") return argv[i + 1];
    if (argv[i].startsWith("--lang=")) return argv[i].slice("--lang=".length);
  }
  return undefined;
}

setLocale(resolveLocale(peekLang(process.argv)));

/**
 * Read the version from package.json instead of hardcoding it.
 *
 * It WAS hardcoded, and drifted: `--version` said 0.1.0 while the published
 * package was 0.2.1. That is the one number a user checks to answer "did I get
 * the fix?", so it lying is worse than it being absent.
 *
 * dist/index.js is bundled to the package root's dist/, so package.json is one
 * level up from the bundle. Falls back rather than crashing the CLI: an
 * unreadable package.json must not stop a run.
 */
function readVersion(): string {
  try {
    const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed: unknown = JSON.parse(readFileSync(pkg, "utf8"));
    const v = (parsed as { version?: unknown }).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

export const program = new Command();

program
  .name("ralphrun")
  .description(t("cli.root.desc"))
  .version(readVersion())
  .option("--prd <path>", t("cli.opt.prd"), "prd.json")
  .option("--workspace <path>", t("cli.opt.workspace"))
  .option("--config <path>", t("cli.opt.config"))
  .option("--executor <cli:model>", t("cli.opt.executor"))
  .option("--advisor <cli:model|none>", t("cli.opt.advisor"))
  .option("--no-review-after", t("cli.opt.noReviewAfter"))
  .option("--dry-run", t("cli.opt.dryRun"))
  .option("--task <id>", t("cli.opt.task"))
  .option("--lang <en|pt-br>", t("cli.opt.lang"))
  .option("-y, --yes", t("cli.opt.yes"))
  .action(async (opts) => {
    setLocale(resolveLocale(opts.lang)); // idempotent after the import-time peek; never saved
    console.clear();
    if (!existsSync(resolve(opts.prd)) && opts.prd === "prd.json") {
      // wizard fully unmounted + alt-screen exited when initWizard resolves —
      // runLoop's own dashboard mounts strictly after (no double-TUI).
      const res = await initWizard({
        prd: opts.prd,
        config: opts.config, // undefined = default (config next to the PRD)
        fromRootFallback: true,
      });
      if (!res) process.exit(0);
      if (!res.run) {
        console.log(t("cli.savedRunHint", { path: res.prdPath }));
        return;
      }
      opts.prd = res.prdPath;
    }

    await runLoop({
      prd: opts.prd,
      workspace: opts.workspace,
      config: opts.config,
      executor: opts.executor,
      advisor: opts.advisor,
      noReviewAfter: opts.reviewAfter === false,
      dryRun: opts.dryRun,
      task: opts.task,
      skipConfirm: opts.yes,
    });
  });

program
  .command("init")
  .description(t("cli.init.desc"))
  .option("--prd <path>", t("cli.init.optPrd"), "prd.json")
  // no default: an absent --config means "next to the PRD" inside the wizard
  .option("--config <path>", t("cli.init.optConfig"))
  .option("--force", t("cli.init.optForce"))
  .option("--lang <en|pt-br>", t("cli.opt.lang")) // shown in `init --help`; the value binds to the root option
  .action(async (opts) => {
    setLocale(resolveLocale(program.opts().lang));
    const res = await initWizard(opts); // alt-screen app clears its own buffer
    if (!res) return; // quit → nothing
    // CONSTRUIR = explicit intent; pass --config through so the loop reads the
    // same file the wizard just wrote.
    if (res.run) await runLoop({ prd: res.prdPath, config: opts.config });
    else console.log(t("cli.savedRunHint", { path: res.prdPath }));
  });

const configCmd = program.command("config");
configCmd
  .description(t("cli.config.desc"))
  .argument("[action]", t("cli.config.action"), "show")
  .option("--config <path>", t("cli.config.optConfig"), "ralph.config.json")
  .option("--global", t("cli.config.optGlobal"))
  .action(async (action, opts) => {
    if (action === "reset") {
      if (!opts.global) {
        console.error(t("config.resetGlobalOnly"));
        process.exit(1);
      }
      await resetGlobal();
    } else if (action === "edit") await editConfig(opts);
    else if (opts.global) await showGlobal();
    else await showConfig(opts);
  });
