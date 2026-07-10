// i18n.ts — two typed dicts + t(). MsgKey derives from `en`, so a key missing
// from pt-br is a COMPILE error (and an extra pt-br key errors via excess-
// property checking). Locale is module state set once at startup (and once
// more by the wizard's first-run language screen). Prompts and prompt-injected
// strings stay English elsewhere; run log lines localize (they render live in
// the TUI), so progress.md is written in the active locale too.

import { loadUserConfig } from "./userconfig.js";

export type Locale = "en" | "pt-br";

const en = {
  // cli.ts — Commander descriptions
  "cli.root.desc":
    "CLI-agnostic autonomous build loop — fresh context per task, executor + advisor. Inspired by snarktank/ralph.",
  "cli.opt.prd": "path to the backlog (prd.json)",
  "cli.opt.workspace": "where to build (default: current dir)",
  "cli.opt.config": "path to ralph.config.json (default: next to --prd)",
  "cli.opt.executor": "cli:model, e.g. claude:sonnet or grok:grok-4.5",
  "cli.opt.advisor": "cli:model (e.g. claude:fable) or 'none'",
  "cli.opt.noReviewAfter": "disable the CROSS-mode review-after loop (on by default)",
  "cli.opt.dryRun": "inspect routing without running anything",
  "cli.opt.task": "run a single task id",
  "cli.opt.lang": "force UI language for this run (not saved)",
  "cli.init.desc": "Scaffold ralph.config.json + a starter prd.json in the current dir (interactive).",
  "cli.init.optPrd": "path to write the backlog",
  "cli.init.optConfig": "path to write ralph.config.json",
  "cli.init.optForce": "overwrite existing files without prompting",
  "cli.config.desc": "Show or interactively edit ralph.config.json.",
  "cli.config.action": "show | edit | reset",
  "cli.config.optConfig": "path to ralph.config.json",
  "cli.config.optGlobal": "operate on the global user config",

  // loop.ts — preflight errors
  "loop.err.notInstalled": "❌ CLI '{cli}' is not installed on your PATH.",
  "loop.err.notLoggedIn": "❌ CLI '{cli}' is installed but NOT logged in. Please run '{cmd}' first.",
  "loop.err.noPrd": "no PRD at {path}",
  "loop.err.noTask": "no task {id}",

  // loop.ts — --dry-run report
  "loop.dry.next": "next: {id} — {title}",
  "loop.dry.mode": "mode: {mode} | executor {executor} | advisor {advisor}",
  "loop.dry.review": "review-after: {review}",
  "loop.dry.reviewOn": "on (≤{n} rounds)",
  "loop.dry.reviewOff": "off",
  "loop.dry.reviewNative": "native",

  // loop.ts / run.ts / verify.ts / executor.ts / advisor.ts — run log lines
  // (rendered live in the TUI pane; also appended to progress.md)
  "loop.log.recovered": "recovered/normalized prd.json (reset stuck tasks, filled defaults)",
  "loop.log.quit": "quit by user",
  "loop.log.allDone": "all tasks done — stopping",
  "loop.log.start": "START {id} — {title} (attempt {n})",
  "loop.log.crashed": "  {id}: crashed — {msg}",
  "loop.log.skipped": "SKIPPED {id} ({s}s)",
  "loop.log.done": "DONE {id} ({s}s)",
  "loop.log.blocked": "BLOCKED {id} ({s}s) — max retries",
  "loop.log.retry": "  {id} failed ({s}s) — retry {n}",
  "loop.log.stopBlocked": "stopping on blocked task",
  "loop.reason.skipped": "skipped by user",
  "loop.reason.maxRetries": "max retries exhausted",
  "run.log.native": "  {id}: NATIVE claude {model} + advisor {advisorModel}",
  "run.log.cross": "  {id}: CROSS executor {executor}",
  "run.log.pass": "  {id}: round {n} → PASS (tests ok, review ok)",
  "run.log.fixing": "  {id}: round {n} → fixing (exec_ok={exec} tests_ok={tests} approved={approved})",
  "run.log.exhausted": "  {id}: review/fix rounds exhausted",
  "run.log.neverApproved": "  {id}: review never approved — not marking done",
  "verify.failed": "  {id}: verify FAILED (exit {status})",
  "verify.crashed": "  {id}: verify crashed — {msg}",
  "exec.working": "  {tag}: …working ({s}s)",
  "exec.skipped": "  {tag}: skipped by user — killing {cli}",
  "exec.timeout": "  {tag}: {cli} TIMEOUT after {s}s — killed",
  "exec.spawnFailed": "  {tag}: failed to spawn {cli} — {msg}",
  "advisor.failed": "  {id}: advisor failed — continuing without",
  "advisor.advice": "  {id}: advisor {agent} → {n} chars",
  "advisor.reviewFailed": "  {id}: review failed — treating as APPROVE",

  // wizard.ts
  "wizard.nontty.exists":
    "ralphrun init: prd.json / ralph.config.json already exist — rerun with --force to overwrite.",
  "wizard.nontty.skipped": "No interactive TTY — skipping the wizard; wrote default config + PRD scaffold.",
  "wizard.usingPrd": "Using PRD: {path}",
  "wizard.done": "done ✓",
  "wizard.err.invalidPrd": "refusing to write invalid PRD: {errors}",

  // wizardController.ts — option labels (built per-call so locale applies)
  "wizard.action.createNew": "Create a new PRD (chat with the planner)",
  "wizard.action.selectExisting": "Select an existing PRD (*.json)",
  "wizard.advisor.none": "none (skip)",
  "wizard.model.recommended": "(recommended)",
  "wizard.header.studio": "studio",
  "wizard.header.setup": "setup {n}/7",

  // WizardApp.tsx — titles
  "wizard.title.preflight": "Agents preflight",
  "wizard.title.filepick": "Select an existing PRD (*.json)",
  "wizard.title.plannerCli": "Planner CLI (the agent that drafts + refines the PRD in the studio):",
  "wizard.title.executorCli": "Executor CLI (the agent that does the actual file editing):",
  "wizard.title.advisorCli": "Advisor CLI (a stronger model that steers — 'none' to skip):",
  "wizard.title.commit": "Commit automatically after each passing task?",
  "wizard.title.actionNoPrd": "No PRD found. What would you like to do?",
  "wizard.title.action": "What would you like to do?",
  "wizard.title.plannerModel": "Model for Planner ({cli}):",
  "wizard.title.executorModel": "Model for Executor ({cli}):",
  "wizard.title.advisorModel": "Model for Advisor ({cli}):",
  "wizard.title.overwrite": "{names} already exist here. Overwrite?",
  // locale not chosen yet — bilingual literal, identical in both dicts
  "wizard.title.language": "Choose your language / Escolha seu idioma",

  // WizardApp.tsx — preflight rows
  "wizard.preflight.ok": "✅ OK",
  "wizard.preflight.notInstalled": "❌ Not installed",
  "wizard.preflight.notLoggedIn": "⚠️ Not logged in (run '{cmd}')",
  "wizard.preflight.authUnknown": "✅ Installed (auth unknown)",
  "wizard.preflight.continue": "press ⏎ to continue",
  "wizard.noClis": "No supported CLIs are ready. Install and login to Claude, Grok, or Cursor, then press r.",

  // statusbar hint labels (key glyphs ↑↓/⏎/esc/q/r stay literal in the views)
  "hint.filter": "to filter",
  "hint.move": "move",
  "hint.pick": "pick",
  "hint.back": "back",
  "hint.overwrite": "overwrite",
  "hint.cancel": "cancel",
  "hint.select": "select",
  "hint.refresh": "refresh",
  "hint.quit": "quit",
  "hint.type": "type",

  // shared
  "common.noMatch": "no match",
  "common.yesOverwrite": "Yes, overwrite",
  "common.noCancel": "No, cancel",
  "common.yes": "Yes",
  "common.no": "No",
  "common.and": " and ",

  // PrdApp.tsx — PRD studio
  "studio.thinking": "thinking…",
  "studio.scrollBelowOne": "▼ {n} line below — PgDn to jump to end",
  "studio.scrollBelowMany": "▼ {n} lines below — PgDn to jump to end",
  "studio.detail.hint": 'esc close · edit via chat: "task {n}: …"',
  "studio.detail.noDescription": "(no description)",
  "studio.detail.noVerify": "(none)",
  "studio.detail.verify": "verify:",
  "studio.header.prd": "PRD:",
  "studio.header.tasks": "{n} tasks",
  "studio.header.newProject": "(new)",
  "studio.header.depsOk": "deps ok",
  "studio.header.issues": "{n} issues",
  "studio.header.empty": "empty",
  "studio.noTasks": "no tasks yet — describe what to build below",
  "studio.moreTasks": "…+{n} more",
  "studio.quit.confirm": "quit studio?",
  "studio.quit.yes": "quit",
  "studio.quit.stay": "stay",
  "studio.hint.task": "task",
  "studio.hint.details": "details",
  "studio.hint.undo": "undo",
  "studio.hint.chat": "chat",
  "studio.hint.quit": "quit",
  "studio.hint.send": "send",
  "studio.hint.attach": "attach",
  "studio.hint.finalize": "finalize",
  "studio.hint.tasks": "tasks",
  "studio.hint.scroll": "scroll",
  // PrdApp.tsx — chat role prefixes (≤7 chars: padded into PREFIX_W)
  "studio.role.you": "you",
  "studio.role.planner": "planner",
  "studio.role.error": "error",
  // prdChat.ts — planner-turn errors shown in the chat pane
  "studio.err.noJson": "no valid PRD json found in planner output",
  "studio.err.spawnFailed": "failed to spawn planner",

  // validatePrd.ts — structural errors (studio chat pane + finalize gate)
  "prd.err.notObject": "prd must be an object",
  "prd.err.project": "project must be a string",
  "prd.err.stack": "stack must be a string",
  "prd.err.arch": "architecture_notes must be a string",
  "prd.err.tasksArray": "tasks must be an array",
  "prd.err.noTasks": "prd must have at least one task",
  "prd.err.taskObject": "task[{i}] must be an object",
  "prd.err.id": "task[{i}].id must be a string",
  "prd.err.dupId": "duplicate task id: {id}",
  "prd.err.title": "task[{i}].title must be a string",
  "prd.err.status": "task[{i}].status invalid",
  "prd.err.retries": "task[{i}].retries must be a number",
  "prd.err.description": "task[{i}].description must be a string",
  "prd.err.acceptance": "task[{i}].acceptance must be an array",
  "prd.err.deps": "task[{i}].deps must be an array",
  "prd.err.depUnknown": "task[{i}] dep references unknown id: {d}",

  // run-loop TUI (App.tsx + controller.ts)
  "run.tasks": "Tasks",
  "run.phase": "phase",
  "run.round": "round",
  "run.attempt": "attempt",
  "run.gate.exec": "exec",
  "run.gate.tests": "tests",
  "run.gate.review": "review",
  "run.confirmSkip": "confirm skip? y/n",
  "run.confirmQuit": "confirm quit? y/n",
  "run.footerHint": "[p]ause [s]kip [q]uit",

  // configcmd.ts — global config
  "config.resetDone": "Global config reset ({path}).",
  "config.globalPath": "global config: {path}",
  "config.globalMissing": "(no global config — showing defaults)",

  // cli.ts + configcmd.ts — config show/edit/reset
  "config.resetGlobalOnly": "config reset only supports --global (edit the project file directly)",
  "config.showMissing": "(no config at {path} — showing built-in defaults)",
  "config.edit.noConfig": "No config found — starting from defaults; will write to {path}.",
  "config.edit.executor": "Executor (cli:model, e.g. claude:sonnet or grok:grok-4.5):",
  "config.edit.advisor": "Advisor (cli:model, or 'none'):",
  "config.edit.taskTimeout": "Task timeout (sec):",
  "config.edit.maxRetries": "Max retries per task:",
  "config.edit.maxReviewRounds": "Max review rounds (CROSS):",
  "config.edit.reviewAfter": "Enable review-after loop (CROSS)?",
  "config.edit.commitPerTask": "Commit per task?",
  "config.edit.writing": "Writing config",
  "config.edit.wrote": "Wrote {path}",
  "config.edit.mustBeNumber": "must be a number",
  "config.edit.cancelled": "config edit cancelled.",
} as const;

export type MsgKey = keyof typeof en;

const ptBr: Record<MsgKey, string> = {
  "cli.root.desc":
    "Loop de build autônomo agnóstico de CLI — contexto novo por task, executor + advisor. Inspirado no snarktank/ralph.",
  "cli.opt.prd": "caminho do backlog (prd.json)",
  "cli.opt.workspace": "onde construir (padrão: diretório atual)",
  "cli.opt.config": "caminho do ralph.config.json (padrão: ao lado de --prd)",
  "cli.opt.executor": "cli:modelo, ex.: claude:sonnet ou grok:grok-4.5",
  "cli.opt.advisor": "cli:modelo (ex.: claude:fable) ou 'none'",
  "cli.opt.noReviewAfter": "desativa o loop de review-after do modo CROSS (ligado por padrão)",
  "cli.opt.dryRun": "inspeciona o roteamento sem executar nada",
  "cli.opt.task": "executa uma única task pelo id",
  "cli.opt.lang": "força o idioma da interface nesta execução (não é salvo)",
  "cli.init.desc": "Cria ralph.config.json + um prd.json inicial no diretório atual (interativo).",
  "cli.init.optPrd": "caminho para gravar o backlog",
  "cli.init.optConfig": "caminho para gravar o ralph.config.json",
  "cli.init.optForce": "sobrescreve arquivos existentes sem perguntar",
  "cli.config.desc": "Mostra ou edita interativamente o ralph.config.json.",
  "cli.config.action": "show | edit | reset",
  "cli.config.optConfig": "caminho do ralph.config.json",
  "cli.config.optGlobal": "opera na configuração global do usuário",

  "loop.err.notInstalled": "❌ A CLI '{cli}' não está instalada no seu PATH.",
  "loop.err.notLoggedIn": "❌ A CLI '{cli}' está instalada mas NÃO está logada. Rode '{cmd}' primeiro.",
  "loop.err.noPrd": "nenhum PRD em {path}",
  "loop.err.noTask": "task {id} não existe",

  "loop.dry.next": "próxima: {id} — {title}",
  "loop.dry.mode": "modo: {mode} | executor {executor} | advisor {advisor}",
  "loop.dry.review": "review-after: {review}",
  "loop.dry.reviewOn": "ligado (≤{n} rodadas)",
  "loop.dry.reviewOff": "desligado",
  "loop.dry.reviewNative": "nativo",

  "loop.log.recovered": "prd.json recuperado/normalizado (tasks travadas resetadas, padrões preenchidos)",
  "loop.log.quit": "encerrado pelo usuário",
  "loop.log.allDone": "todas as tasks concluídas — parando",
  "loop.log.start": "START {id} — {title} (tentativa {n})",
  "loop.log.crashed": "  {id}: quebrou — {msg}",
  "loop.log.skipped": "PULADA {id} ({s}s)",
  "loop.log.done": "CONCLUÍDA {id} ({s}s)",
  "loop.log.blocked": "BLOQUEADA {id} ({s}s) — máximo de tentativas",
  "loop.log.retry": "  {id} falhou ({s}s) — tentativa {n}",
  "loop.log.stopBlocked": "parando em task bloqueada",
  "loop.reason.skipped": "pulada pelo usuário",
  "loop.reason.maxRetries": "máximo de tentativas esgotado",
  "run.log.native": "  {id}: NATIVE claude {model} + advisor {advisorModel}",
  "run.log.cross": "  {id}: CROSS executor {executor}",
  "run.log.pass": "  {id}: rodada {n} → PASSOU (testes ok, review ok)",
  "run.log.fixing": "  {id}: rodada {n} → corrigindo (exec_ok={exec} tests_ok={tests} approved={approved})",
  "run.log.exhausted": "  {id}: rodadas de review/correção esgotadas",
  "run.log.neverApproved": "  {id}: review nunca aprovado — não marcando como concluída",
  "verify.failed": "  {id}: verify FALHOU (exit {status})",
  "verify.crashed": "  {id}: verify quebrou — {msg}",
  "exec.working": "  {tag}: …trabalhando ({s}s)",
  "exec.skipped": "  {tag}: pulada pelo usuário — matando {cli}",
  "exec.timeout": "  {tag}: {cli} TIMEOUT após {s}s — morta",
  "exec.spawnFailed": "  {tag}: falha ao iniciar {cli} — {msg}",
  "advisor.failed": "  {id}: advisor falhou — continuando sem",
  "advisor.advice": "  {id}: advisor {agent} → {n} caracteres",
  "advisor.reviewFailed": "  {id}: review falhou — tratando como APPROVE",

  "wizard.nontty.exists":
    "ralphrun init: prd.json / ralph.config.json já existem — rode de novo com --force para sobrescrever.",
  "wizard.nontty.skipped": "Sem TTY interativo — pulando o assistente; config padrão + esqueleto de PRD gravados.",
  "wizard.usingPrd": "Usando PRD: {path}",
  "wizard.done": "pronto ✓",
  "wizard.err.invalidPrd": "recusando gravar PRD inválido: {errors}",

  "wizard.action.createNew": "Criar um novo PRD (conversar com o planner)",
  "wizard.action.selectExisting": "Selecionar um PRD existente (*.json)",
  "wizard.advisor.none": "nenhum (pular)",
  "wizard.model.recommended": "(recomendado)",
  "wizard.header.studio": "studio",
  "wizard.header.setup": "setup {n}/7",

  "wizard.title.preflight": "Verificação dos agentes",
  "wizard.title.filepick": "Selecione um PRD existente (*.json)",
  "wizard.title.plannerCli": "CLI do Planner (o agente que rascunha + refina o PRD no studio):",
  "wizard.title.executorCli": "CLI do Executor (o agente que faz a edição real dos arquivos):",
  "wizard.title.advisorCli": "CLI do Advisor (um modelo mais forte que orienta — 'none' para pular):",
  "wizard.title.commit": "Commitar automaticamente após cada task que passar?",
  "wizard.title.actionNoPrd": "Nenhum PRD encontrado. O que você quer fazer?",
  "wizard.title.action": "O que você quer fazer?",
  "wizard.title.plannerModel": "Modelo para o Planner ({cli}):",
  "wizard.title.executorModel": "Modelo para o Executor ({cli}):",
  "wizard.title.advisorModel": "Modelo para o Advisor ({cli}):",
  "wizard.title.overwrite": "{names} já existem aqui. Sobrescrever?",
  "wizard.title.language": "Choose your language / Escolha seu idioma",

  "wizard.preflight.ok": "✅ OK",
  "wizard.preflight.notInstalled": "❌ Não instalada",
  "wizard.preflight.notLoggedIn": "⚠️ Não logada (rode '{cmd}')",
  "wizard.preflight.authUnknown": "✅ Instalada (auth desconhecida)",
  "wizard.preflight.continue": "pressione ⏎ para continuar",
  "wizard.noClis": "Nenhuma CLI suportada está pronta. Instale e faça login no Claude, Grok ou Cursor, depois pressione r.",

  "hint.filter": "para filtrar",
  "hint.move": "mover",
  "hint.pick": "escolher",
  "hint.back": "voltar",
  "hint.overwrite": "sobrescrever",
  "hint.cancel": "cancelar",
  "hint.select": "selecionar",
  "hint.refresh": "atualizar",
  "hint.quit": "sair",
  "hint.type": "digite",

  "common.noMatch": "nada encontrado",
  "common.yesOverwrite": "Sim, sobrescrever",
  "common.noCancel": "Não, cancelar",
  "common.yes": "Sim",
  "common.no": "Não",
  "common.and": " e ",

  "studio.thinking": "pensando…",
  "studio.scrollBelowOne": "▼ {n} linha abaixo — PgDn volta pro fim",
  "studio.scrollBelowMany": "▼ {n} linhas abaixo — PgDn volta pro fim",
  "studio.detail.hint": 'esc fechar · edite via chat: "task {n}: …"',
  "studio.detail.noDescription": "(sem descrição)",
  "studio.detail.noVerify": "(nenhum)",
  "studio.detail.verify": "verify:",
  "studio.header.prd": "PRD:",
  "studio.header.tasks": "{n} tarefas",
  "studio.header.newProject": "(novo)",
  "studio.header.depsOk": "deps ok",
  "studio.header.issues": "{n} problemas",
  "studio.header.empty": "vazio",
  "studio.noTasks": "nenhuma tarefa ainda — descreva abaixo o que construir",
  "studio.moreTasks": "…+{n} mais",
  "studio.quit.confirm": "sair do studio?",
  "studio.quit.yes": "sair",
  "studio.quit.stay": "ficar",
  "studio.hint.task": "tarefa",
  "studio.hint.details": "detalhes",
  "studio.hint.undo": "desfazer",
  "studio.hint.chat": "chat",
  "studio.hint.quit": "sair",
  "studio.hint.send": "enviar",
  "studio.hint.attach": "anexar",
  "studio.hint.finalize": "finalizar",
  "studio.hint.tasks": "tarefas",
  "studio.hint.scroll": "rolar",
  "studio.role.you": "você",
  "studio.role.planner": "planner",
  "studio.role.error": "erro",
  "studio.err.noJson": "nenhum json de PRD válido encontrado na saída do planner",
  "studio.err.spawnFailed": "falha ao iniciar o planner",

  "prd.err.notObject": "prd precisa ser um objeto",
  "prd.err.project": "project precisa ser uma string",
  "prd.err.stack": "stack precisa ser uma string",
  "prd.err.arch": "architecture_notes precisa ser uma string",
  "prd.err.tasksArray": "tasks precisa ser um array",
  "prd.err.noTasks": "o prd precisa ter pelo menos uma task",
  "prd.err.taskObject": "task[{i}] precisa ser um objeto",
  "prd.err.id": "task[{i}].id precisa ser uma string",
  "prd.err.dupId": "id de task duplicado: {id}",
  "prd.err.title": "task[{i}].title precisa ser uma string",
  "prd.err.status": "task[{i}].status inválido",
  "prd.err.retries": "task[{i}].retries precisa ser um número",
  "prd.err.description": "task[{i}].description precisa ser uma string",
  "prd.err.acceptance": "task[{i}].acceptance precisa ser um array",
  "prd.err.deps": "task[{i}].deps precisa ser um array",
  "prd.err.depUnknown": "task[{i}] dep referencia id desconhecido: {d}",

  "run.tasks": "Tarefas",
  "run.phase": "fase",
  "run.round": "rodada",
  "run.attempt": "tentativa",
  "run.gate.exec": "exec",
  "run.gate.tests": "testes",
  "run.gate.review": "revisão",
  "run.confirmSkip": "confirmar pular? y/n",
  "run.confirmQuit": "confirmar sair? y/n",
  "run.footerHint": "[p] pausar [s] pular [q] sair",

  "config.resetDone": "Configuração global resetada ({path}).",
  "config.globalPath": "configuração global: {path}",
  "config.globalMissing": "(sem configuração global — mostrando padrões)",

  "config.resetGlobalOnly": "config reset só suporta --global (edite o arquivo do projeto diretamente)",
  "config.showMissing": "(sem config em {path} — mostrando padrões embutidos)",
  "config.edit.noConfig": "Nenhuma config encontrada — começando dos padrões; será gravada em {path}.",
  "config.edit.executor": "Executor (cli:modelo, ex.: claude:sonnet ou grok:grok-4.5):",
  "config.edit.advisor": "Advisor (cli:modelo, ou 'none'):",
  "config.edit.taskTimeout": "Timeout da task (seg):",
  "config.edit.maxRetries": "Máximo de tentativas por task:",
  "config.edit.maxReviewRounds": "Máximo de rodadas de review (CROSS):",
  "config.edit.reviewAfter": "Ativar o loop de review-after (CROSS)?",
  "config.edit.commitPerTask": "Commitar por task?",
  "config.edit.writing": "Gravando config",
  "config.edit.wrote": "Gravado {path}",
  "config.edit.mustBeNumber": "precisa ser um número",
  "config.edit.cancelled": "config edit cancelado.",
};

// exported for the dict-parity test only — not for rendering (use t()).
export const DICTS: Record<Locale, Record<MsgKey, string>> = { en, "pt-br": ptBr };

let locale: Locale = "en";

export function setLocale(l: Locale): void {
  locale = l;
}

export function getLocale(): Locale {
  return locale;
}

// explicit flag > saved global config > system Intl > "en"; unknown → "en"
export function resolveLocale(explicit?: string): Locale {
  for (const c of [explicit, loadUserConfig().language]) {
    if (c === "en" || c === "pt-br") return c;
  }
  try {
    const sys = new Intl.DateTimeFormat().resolvedOptions().locale;
    if (sys.toLowerCase().startsWith("pt")) return "pt-br";
  } catch {
    /* CI/odd ICU builds: fall through to en */
  }
  return "en";
}

// literal {name} interpolation; a param not present in `params` stays as-is.
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  let s: string = DICTS[locale][key];
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
