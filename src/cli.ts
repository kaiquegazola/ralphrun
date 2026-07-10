// cli.ts — Commander setup. Root action = run the loop; subcommands: init, config.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

export const program = new Command();

program
  .name("ralphrun")
  .description(t("cli.root.desc"))
  .version("0.1.0")
  .option("--prd <path>", t("cli.opt.prd"), "prd.json")
  .option("--workspace <path>", t("cli.opt.workspace"))
  .option("--config <path>", t("cli.opt.config"))
  .option("--executor <cli:model>", t("cli.opt.executor"))
  .option("--advisor <cli:model|none>", t("cli.opt.advisor"))
  .option("--no-review-after", t("cli.opt.noReviewAfter"))
  .option("--dry-run", t("cli.opt.dryRun"))
  .option("--task <id>", t("cli.opt.task"))
  .option("--lang <en|pt-br>", t("cli.opt.lang"))
  .action(async (opts) => {
    setLocale(resolveLocale(opts.lang)); // idempotent after the import-time peek; never saved
    console.clear();
    let prdPath = resolve(opts.prd);
    if (!existsSync(prdPath) && opts.prd === "prd.json") {
      const picked = await initWizard({
        prd: opts.prd,
        config: opts.config ?? "ralph.config.json",
        fromRootFallback: true,
      });
      if (!picked) process.exit(0);
      opts.prd = picked;
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
    });
  });

program
  .command("init")
  .description(t("cli.init.desc"))
  .option("--prd <path>", t("cli.init.optPrd"), "prd.json")
  .option("--config <path>", t("cli.init.optConfig"), "ralph.config.json")
  .option("--force", t("cli.init.optForce"))
  .option("--lang <en|pt-br>", t("cli.opt.lang")) // shown in `init --help`; the value binds to the root option
  .action(async (opts) => {
    setLocale(resolveLocale(program.opts().lang));
    await initWizard(opts); // alt-screen app clears its own buffer
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
