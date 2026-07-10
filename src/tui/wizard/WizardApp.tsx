// WizardApp.tsx — fullscreen app shell for `ralphrun init`: header bar, screen
// router (preflight → … → studio), statusbar with contextual keybinds. All
// state lives in wizardController (pure reducer); this file only renders and
// maps keys → actions via useInput. Hand-rolled select list + text input — no
// new deps. Studio screen embeds PrdApp with the lazily-created prd store.
// Excluded from coverage (Ink can't mount under the test runner).

import React, { useEffect, useSyncExternalStore } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
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
  prdStore(): PrdStore | null; // lazy — created by mount on the proceed transition
  cwd: string;
  checkAgents(): AgentDiagnostic[];
  cfgExistsFor(prdPath: string): boolean;
  onSend(text: string): void;
  onFinalize(): void;
  onQuitStudio(): void;
  onResize?(): void; // mount wires instance.clear() to avoid stale cells on shrink
}

// per-call (not a module const): t() must see the locale picked on the
// first-run language screen, which runs after module import.
const TITLES: Partial<Record<Screen, () => string>> = {
  language: () => t("wizard.title.language"),
  preflight: () => t("wizard.title.preflight"),
  filepick: () => t("wizard.title.filepick"),
  plannerCli: () => t("wizard.title.plannerCli"),
  executorCli: () => t("wizard.title.executorCli"),
  advisorCli: () => t("wizard.title.advisorCli"),
  commit: () => t("wizard.title.commit"),
};

const REFRESH_SCREENS: ReadonlySet<Screen> = new Set(["preflight", "plannerCli", "executorCli", "advisorCli"]);

function title(s: WizardState): string {
  switch (s.screen) {
    case "action":
      return s.ctx.fromRootFallback ? t("wizard.title.actionNoPrd") : t("wizard.title.action");
    case "plannerModel":
      return t("wizard.title.plannerModel", { cli: s.plannerSpec!.cli });
    case "executorModel":
      return t("wizard.title.executorModel", { cli: s.executorSpec!.cli });
    case "advisorModel":
      return t("wizard.title.advisorModel", { cli: s.advisorSpec!.cli });
    case "overwrite": {
      const o = s.needsOverwrite!;
      const names = [o.prd && "prd.json", o.cfg && "ralph.config.json"].filter(Boolean).join(t("common.and"));
      return t("wizard.title.overwrite", { names });
    }
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
  if (screen === "overwrite") {
    return [
      ["y", t("hint.overwrite")],
      ["n", t("hint.cancel")],
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

  // always-active ctrl+c → quit, even on studio / while the planner is drafting
  // (PrdApp's own useInput is inactive then; exitOnCtrlC is false in mount).
  useInput((input, key) => {
    if (key.ctrl && input === "c") dispatch({ type: "quit" });
  });

  // setup-screen keys; studio input is owned entirely by PrdApp
  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return; // ctrl+c handled by the hook above
      if (s.screen === "filepick") {
        if (key.escape) return void dispatch({ type: "back" });
        if (key.return) {
          const chosen = results[fileCursor];
          if (chosen) {
            dispatch({ type: "pickFile", path: chosen.absolute, cfgExists: props.cfgExistsFor(chosen.absolute) });
          }
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
      if (s.screen === "overwrite") {
        if (input === "y") return void dispatch({ type: "confirm" });
        if (input === "n") return void dispatch({ type: "deny" });
      }
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
          onSend={props.onSend}
          onFinalize={props.onFinalize}
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

            {s.screen === "filepick" && (
              <Box flexDirection="column">
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

            {s.screen !== "preflight" && s.screen !== "filepick" && (
              <Box flexDirection="column">
                {!canProceed(s) && (
                  <Text color="yellow" wrap="truncate-end">
                    {t("wizard.noClis")}
                  </Text>
                )}
                <SelectList options={visibleOptions(s)} cursor={s.cursor} maxRows={listMax - (canProceed(s) ? 0 : 1)} />
              </Box>
            )}
          </Box>
          <Hints items={statusHints(s.screen)} />
        </>
      )}
    </Box>
  );
}
