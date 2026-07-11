// configcmd.ts — `ralphrun config show|edit` (project file) + `--global`
// show/reset for the global user config. Show prints the resolved config;
// edit is a Clack wizard over a few key knobs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";

import { DEFAULTS, parseAgent, type Config } from "./config.js";
import { t } from "./i18n.js";
import { configPath, loadUserConfig, resetUserConfig, userConfigExists } from "./userconfig.js";

export async function pickModel(role: "executor" | "advisor", current: string): Promise<string | symbol> {
  const { select, text, isCancel } = await import("@clack/prompts");
  const { MODELS } = await import("./tui/wizard/wizardController.js");

  const options = [];
  if (role === "advisor") {
    options.push({ value: "none", label: t("wizard.agent.disable") });
  }
  for (const [cli, models] of Object.entries(MODELS)) {
    for (const m of models) {
      options.push({ value: `${cli}:${m.value}`, label: `${cli}:${m.label}` });
    }
  }
  options.push({ value: "custom", label: t("config.edit.customModel") });

  let choice = await select({
    message: role === "executor" ? t("config.edit.executor") : t("config.edit.advisor"),
    options,
    initialValue: options.some((o) => o.value === current) ? current : "custom",
  });

  if (isCancel(choice)) return choice;

  if (choice === "custom") {
    choice = await text({
      message: t("config.edit.customModelPrompt"),
      initialValue: current === "none" ? "" : current,
    });
  }

  return choice;
}

interface ConfigOpts {
  config: string;
}

export async function showConfig(opts: ConfigOpts): Promise<void> {
  const cfgPath = resolve(opts.config);
  let cfg: Config;
  if (existsSync(cfgPath)) {
    cfg = { ...structuredClone(DEFAULTS), ...JSON.parse(readFileSync(cfgPath, "utf8")) };
  } else {
    process.stderr.write(t("config.showMissing", { path: cfgPath }) + "\n");
    cfg = structuredClone(DEFAULTS);
  }
  console.log(JSON.stringify(cfg, null, 2));
}

// `ralphrun config show --global`
export async function showGlobal(): Promise<void> {
  if (!userConfigExists()) process.stderr.write(t("config.globalMissing") + "\n");
  console.log(t("config.globalPath", { path: configPath() }));
  console.log(JSON.stringify(loadUserConfig(), null, 2));
}

// `ralphrun config reset --global`
export async function resetGlobal(): Promise<void> {
  resetUserConfig();
  console.log(t("config.resetDone", { path: configPath() }));
}

export async function editConfig(opts: ConfigOpts): Promise<void> {
  p.intro("ralphrun config edit");
  const cfgPath = resolve(opts.config);
  let cfg: Config;
  if (existsSync(cfgPath)) {
    cfg = { ...structuredClone(DEFAULTS), ...JSON.parse(readFileSync(cfgPath, "utf8")) };
  } else {
    cfg = structuredClone(DEFAULTS);
    p.note(t("config.edit.noConfig", { path: cfgPath }), "config");
  }

  // executor
  const executor = await pickModel("executor", `${cfg.executor.cli}:${cfg.executor.model}`);
  if (p.isCancel(executor)) return cancel();
  const espec = parseAgent(executor as string);
  cfg.executor = espec ?? cfg.executor;

  // advisor
  const advisor = await pickModel("advisor", cfg.advisor ? `${cfg.advisor.cli}:${cfg.advisor.model}` : "none");
  if (p.isCancel(advisor)) return cancel();
  cfg.advisor = parseAgent(advisor as string);

  cfg.task_timeout = await numOrKeep(t("config.edit.taskTimeout"), cfg.task_timeout);
  cfg.max_retries_per_task = await numOrKeep(t("config.edit.maxRetries"), cfg.max_retries_per_task);
  cfg.max_review_rounds = await numOrKeep(t("config.edit.maxReviewRounds"), cfg.max_review_rounds);
  cfg.max_stalled_review_rounds = await numOrKeep(
    t("config.edit.maxStalledReviewRounds"),
    cfg.max_stalled_review_rounds,
  );

  const review = await p.confirm({
    message: t("config.edit.reviewAfter"),
    initialValue: cfg.review_after,
  });
  if (!p.isCancel(review)) cfg.review_after = review as boolean;

  const commit = await p.confirm({
    message: t("config.edit.commitPerTask"),
    initialValue: cfg.commit_per_task,
  });
  if (!p.isCancel(commit)) cfg.commit_per_task = commit as boolean;

  const s = p.spinner();
  s.start(t("config.edit.writing"));
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  s.stop(t("config.edit.wrote", { path: cfgPath }));
  p.outro(t("wizard.done"));
}

async function numOrKeep(message: string, current: number): Promise<number> {
  const v = await p.text({
    message,
    initialValue: String(current),
    validate: (s) => {
      const v = s ?? "";
      if (v.trim() === "") return undefined;
      return Number.isNaN(Number(v)) ? t("config.edit.mustBeNumber") : undefined;
    },
  });
  if (p.isCancel(v)) return current;
  const n = Number(v);
  return Number.isNaN(n) ? current : n;
}

function cancel(): void {
  p.cancel(t("config.edit.cancelled"));
  process.exit(0);
}
