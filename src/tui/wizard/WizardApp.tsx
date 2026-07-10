// WizardApp.tsx — fullscreen app shell for `ralphrun init`: header bar, screen
// router (preflight → settings → action → studio), statusbar with contextual
// keybinds. All state lives in wizardController (pure reducer); this file only
// renders and maps keys → actions via useInput. Hand-rolled select list + text
// input — no new deps. Studio screen embeds PrdApp with the lazily-created prd
// store. Excluded from coverage (Ink can't mount under the test runner).

import React, { useEffect, useSyncExternalStore } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { AgentDiagnostic } from "../../diagnostics.js";
import { t } from "../../i18n.js";
import { searchFiles } from "../../picker.js";
import { PrdApp, type PrdStore } from "../prd/PrdApp.js";
import {
  canProceed,
  headerLabel,
  visibleOptions,
  type Option,
  type Screen,
  type WizardAction,
  type WizardState,
} from "./wizardController.js";

export interface WizardStore {
  subscribe(cb: () => void): () => void;
  getSnapshot(): WizardState;
  dispatch(a: WizardAction): void;
}

export interface WizardAppProps {
  store: WizardStore;
  prdStore(): PrdStore | null; // lazy — created by mount on the studio transition
  cwd: string;
  checkAgents(): AgentDiagnostic[];
  onSend(text: string): void;
  onSave(): void; // savedPath set → silent re-save; else opens the save-as screen
  onBuild(): void; // save (or save-as) then resolve { prdPath, run:true }
  onQuitStudio(): void;
  onResize?(): void; // mount wires instance.clear() to avoid stale cells on shrink
}

// per-call (not a module const): t() must see the locale picked on the
// first-run language screen, which runs after module import.
const TITLES: Partial<Record<Screen, () => string>> = {
  language: () => t("wizard.title.language"),
  preflight: () => t("wizard.title.preflight"),
  filepick: () => t("wizard.title.filepick"),
  settings: () => t("wizard.title.settings"),
};

const REFRESH_SCREENS: ReadonlySet<Screen> = new Set(["preflight", "settings", "agentPick"]);

function title(s: WizardState): string {
  switch (s.screen) {
    case "action":
      return s.ctx.fromRootFallback ? t("wizard.title.actionNoPrd") : t("wizard.title.action");
    case "agentPick":
      return t("wizard.title.agentPick", { role: t(`wizard.settings.${s.agentRole!}`) });
    case "refineOrRun":
      return s.prdErrors
        ? t("wizard.title.refineInvalid", { path: relative(s.ctx.cwd, s.prdPath!) })
        : t("wizard.title.refineOrRun", { path: relative(s.ctx.cwd, s.prdPath!) });
    case "saveAs":
      return t("wizard.title.saveAs", { cwd: s.ctx.cwd });
    default:
      return TITLES[s.screen]?.() ?? "";
  }
}

// scroll window around the cursor so no list exceeds the viewport
function windowRange(len: number, cursor: number, max: number): { start: number; end: number } {
  if (len <= max) return { start: 0, end: len };
  const start = Math.max(0, Math.min(cursor - Math.floor(max / 2), len - max));
  return { start, end: start + max };
}

function Hints({ items }: { items: [string, string][] }): React.ReactElement {
  return (
    <Text dimColor wrap="truncate-end">
      {items.map(([k, label], i) => (
        <React.Fragment key={i}>
          {i > 0 ? " · " : ""}
          <Text color="cyan">{k}</Text> {label}
        </React.Fragment>
      ))}
    </Text>
  );
}

function SelectList({ options, cursor, maxRows }: { options: Option[]; cursor: number; maxRows: number }): React.ReactElement {
  // the start/end ellipsis rows count AGAINST maxRows so the whole list —
  // ellipses included — never renders more than maxRows rows.
  const max = Math.max(1, maxRows);
  const inner = options.length > max ? Math.max(1, max - 2) : max;
  const { start, end } = windowRange(options.length, cursor, inner);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>…</Text>}
      {options.slice(start, end).map((o, i) => {
        const idx = start + i;
        const focused = idx === cursor;
        return (
          <Text key={o.value} wrap="truncate-end">
            {focused ? <Text color="cyan">❯ </Text> : "  "}
            <Text bold={focused} dimColor={!focused}>
              {o.label}
            </Text>
            {o.hint ? <Text dimColor> {o.hint}</Text> : ""}
          </Text>
        );
      })}
      {end < options.length && <Text dimColor>…</Text>}
    </Box>
  );
}

function Preflight({ diagnostics }: { diagnostics: AgentDiagnostic[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {diagnostics.map((a) => {
        let status = t("wizard.preflight.ok");
        let color = "green";
        if (!a.installed) {
          status = t("wizard.preflight.notInstalled");
          color = "red";
        } else if (a.loggedIn === false) {
          status = t("wizard.preflight.notLoggedIn", { cmd: a.loginCommand! });
          color = "yellow";
        } else if (a.loggedIn === "unknown") {
          status = t("wizard.preflight.authUnknown");
        }
        return (
          <Text key={a.cli} wrap="truncate-end">
            {"  "}
            {a.cli.padEnd(8)} <Text color={color}>{status}</Text>
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>{t("wizard.preflight.continue")}</Text>
      </Box>
    </Box>
  );
}

function statusHints(screen: Screen): [string, string][] {
  if (screen === "filepick") {
    return [
      [t("hint.type"), t("hint.filter")],
      ["↑↓", t("hint.move")],
      ["⏎", t("hint.pick")],
      ["esc", t("hint.back")],
    ];
  }
  const base: [string, string][] = [
    ["↑↓", t("hint.move")],
    ["⏎", t("hint.select")],
  ];
  if (REFRESH_SCREENS.has(screen)) base.push(["r", t("hint.refresh")]);
  base.push(["esc", t("hint.back")], ["q", t("hint.quit")]);
  return base;
}

export function WizardApp(props: WizardAppProps): React.ReactElement {
  const s = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const { columns, rows } = useWindowSize();
  const { dispatch } = props.store;

  // clear stale cells when the terminal is resized inside the alt buffer
  useEffect(() => {
    props.onResize?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, rows]);

  // filepick's list is component-owned: fuzzy search rooted at cwd, *.json only
  const results =
    s.screen === "filepick"
      ? searchFiles(s.filepickQuery, s.ctx.cwd, 200).filter((f) => f.relative.endsWith(".json"))
      : [];
  const fileCursor = Math.min(s.cursor, Math.max(0, results.length - 1));

  // always-active ctrl+c → quit on the setup screens (exitOnCtrlC is false in
  // mount). The studio owns its own ctrl+c: PrdApp routes it through the y/n
  // quit gate so a dirty PRD warns instead of being dropped.
  useInput((input, key) => {
    if (key.ctrl && input === "c" && s.screen !== "studio") dispatch({ type: "quit" });
  });

  // setup-screen keys; studio input is owned entirely by PrdApp
  useInput(
    (input, key) => {
      if (s.screen === "saveAs") {
        // path text input — q is typeable here; ctrl+c handled by the hook above
        if (key.ctrl || key.meta) return;
        if (key.escape) return void dispatch({ type: "saveAsCancel" });
        if (key.return) return void dispatch({ type: "saveAsConfirm" });
        if (key.backspace || key.delete) {
          return void dispatch({ type: "saveAsInput", value: s.saveAsInput.slice(0, -1) });
        }
        if (input) dispatch({ type: "saveAsInput", value: s.saveAsInput + input });
        return;
      }
      if (key.ctrl || key.meta) return; // ctrl+c handled by the hook above
      if (s.screen === "filepick") {
        if (key.escape) return void dispatch({ type: "back" });
        if (key.return) {
          const chosen = results[fileCursor];
          if (chosen) dispatch({ type: "pickFile", path: chosen.absolute });
          return;
        }
        if (key.upArrow) return void dispatch({ type: "up" });
        if (key.downArrow) {
          if (fileCursor < results.length - 1) dispatch({ type: "down" });
          return;
        }
        if (key.backspace || key.delete) {
          return void dispatch({ type: "setQuery", query: s.filepickQuery.slice(0, -1) });
        }
        if (input) dispatch({ type: "setQuery", query: s.filepickQuery + input });
        return;
      }
      if (key.upArrow) return void dispatch({ type: "up" });
      if (key.downArrow) return void dispatch({ type: "down" });
      if (key.return) return void dispatch({ type: "select" });
      if (key.escape) return void dispatch({ type: "back" });
      if (input === "q") return void dispatch({ type: "quit" });
      if (input === "r" && REFRESH_SCREENS.has(s.screen)) {
        dispatch({ type: "refresh", diagnostics: props.checkAgents() });
      }
    },
    { isActive: s.screen !== "studio" },
  );

  const studio = s.screen === "studio";
  const ps = studio ? props.prdStore() : null;
  // chrome: header (1) + separator (1) + statusbar (1, non-studio — PrdApp draws its own)
  const contentRows = Math.max(3, rows - (studio ? 2 : 3));
  // title (1) + its blank margin (1); SelectList's ellipsis rows are already
  // inside its own budget, and the no-CLIs warning row is subtracted at use.
  const listMax = Math.max(1, contentRows - 2);

  // save-as: warn inline when the resolved path already exists (no overwrite screen)
  const saveAsTarget = s.screen === "saveAs" ? s.saveAsInput.trim() : "";
  const saveAsExists = saveAsTarget !== "" && existsSync(resolve(s.ctx.cwd, saveAsTarget));

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box justifyContent="space-between">
        <Text bold>ralphrun</Text>
        <Text dimColor>{headerLabel(s)}</Text>
      </Box>
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>

      {studio && ps ? (
        <PrdApp
          store={ps}
          cwd={props.cwd}
          height={contentRows}
          width={columns}
          active
          savedPath={s.savedPath}
          onSend={props.onSend}
          onSave={props.onSave}
          onBuild={props.onBuild}
          onQuit={props.onQuitStudio}
        />
      ) : (
        <>
          <Box flexDirection="column" flexGrow={1}>
            {title(s) !== "" && (
              <Box marginBottom={1}>
                <Text bold wrap="truncate-end">
                  {title(s)}
                </Text>
              </Box>
            )}

            {s.screen === "preflight" && <Preflight diagnostics={s.diagnostics} />}

            {s.screen === "saveAs" && (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color="cyan">❯ </Text>
                  {s.saveAsInput}
                  <Text dimColor>▌</Text>
                </Text>
                {saveAsExists && (
                  <Text color="yellow" wrap="truncate-end">
                    {t("wizard.saveAs.exists")}
                  </Text>
                )}
              </Box>
            )}

            {s.screen === "filepick" && (
              <Box flexDirection="column">
                {s.prdErrors?.map((e, i) => (
                  <Text key={i} color="red" wrap="truncate-end">
                    {e}
                  </Text>
                ))}
                <Text wrap="truncate-end">
                  <Text color="cyan">❯ </Text>
                  {s.filepickQuery}
                  <Text dimColor>▌</Text>
                </Text>
                {results.length === 0 ? (
                  <Text dimColor>{t("common.noMatch")}</Text>
                ) : (
                  <SelectList
                    options={results.map((r) => ({ value: r.absolute, label: r.relative }))}
                    cursor={fileCursor}
                    maxRows={listMax - 1}
                  />
                )}
              </Box>
            )}

            {s.screen !== "preflight" && s.screen !== "filepick" && s.screen !== "saveAs" && (
              <Box flexDirection="column">
                {s.screen === "refineOrRun" && s.prdErrors && (
                  <Box flexDirection="column" marginBottom={1}>
                    {s.prdErrors.map((e, i) => (
                      <Text key={i} color="red" wrap="truncate-end">
                        {e}
                      </Text>
                    ))}
                    <Text dimColor wrap="truncate-end">
                      {t("wizard.refine.invalidHint")}
                    </Text>
                  </Box>
                )}
                {!canProceed(s) && (
                  <Text color="yellow" wrap="truncate-end">
                    {t("wizard.noClis")}
                  </Text>
                )}
                <SelectList options={visibleOptions(s)} cursor={s.cursor} maxRows={listMax - (canProceed(s) ? 0 : 1)} />
              </Box>
            )}
          </Box>
          {s.screen === "saveAs" ? (
            <Text dimColor wrap="truncate-end">
              {t("wizard.saveAs.hint")}
            </Text>
          ) : (
            <Hints items={statusHints(s.screen)} />
          )}
        </>
      )}
    </Box>
  );
}
