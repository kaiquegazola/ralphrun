// App.tsx — thin Ink render of UiState. NO logic beyond presentation: reads the
// external store via useSyncExternalStore, maps p/s/q/y/n keys to controller
// actions via useInput. All state folding lives in controller.ts. Excluded from
// coverage (vitest include glob is *.ts, which does not match *.tsx).

import React, { useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { t } from "../i18n.js";
import type { TaskStatus } from "../prd.js";
import type { Action, UiState } from "./controller.js";
import { selectFooterHint, selectProgress } from "./controller.js";

export interface Store {
  subscribe(cb: () => void): () => void;
  getSnapshot(): UiState;
  dispatch(a: Action): void;
}

export interface AppProps {
  store: Store;
  header: string;
}

const GLYPH: Record<TaskStatus, string> = { todo: "○", doing: "◐", done: "✓", blocked: "✗" };
const COLOR: Record<TaskStatus, string> = { todo: "gray", doing: "cyan", done: "green", blocked: "red" };

function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function gate(label: string, v?: boolean): React.ReactElement {
  const color = v === undefined ? "gray" : v ? "green" : "red";
  const mark = v === undefined ? "·" : v ? "✓" : "✗";
  return (
    <Text color={color}>
      {label}:{mark}
    </Text>
  );
}

export function App({ store, header }: AppProps): React.ReactElement {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useInput((input, key) => {
    if (s.stalled) {
      if (input === "r") store.dispatch({ type: "stalledPick", pick: "retry" });
      else if (input === "q") store.dispatch({ type: "stalledPick", pick: "quit" });
      return;
    }
    if (s.pendingConfirm) {
      if (input === "y") store.dispatch({ type: "confirm" });
      else if (input === "n" || key.escape) store.dispatch({ type: "cancelConfirm" });
      return; // swallow everything else while confirming
    }
    if (input === "p") store.dispatch({ type: "pauseToggle" });
    else if (input === "s") store.dispatch({ type: "requestSkip" });
    else if (input === "q") store.dispatch({ type: "requestQuit" });
  });

  const { current, counts } = s;
  const elapsedS = current.elapsedMs !== undefined ? Math.round(current.elapsedMs / 1000) : undefined;
  const timeoutS = current.timeoutMs !== undefined ? Math.round(current.timeoutMs / 1000) : undefined;

  return (
    <Box flexDirection="column">
      <Text bold>{header}</Text>
      <Box flexDirection="row">
        {/* sidebar */}
        <Box flexDirection="column" borderStyle="round" borderDimColor width={34} paddingX={1}>
          <Text bold>{t("run.tasks")}</Text>
          {s.tasks.map((t) => (
            <Text key={t.id} color={COLOR[t.status]} wrap="truncate-end">
              {GLYPH[t.status]} {t.title}
            </Text>
          ))}
          <Box marginTop={1} flexDirection="column">
            <Text>
              {bar(selectProgress(s), 20)} {Math.round(selectProgress(s) * 100)}%
            </Text>
            <Text dimColor>
              {counts.done}✓ {counts.doing}◐ {counts.todo}○ {counts.blocked}✗ / {counts.total}
            </Text>
          </Box>
        </Box>

        {/* live pane */}
        <Box flexDirection="column" borderStyle="round" borderDimColor flexGrow={1} paddingX={1}>
          <Text bold color="cyan" wrap="truncate-end">
            {current.title ?? "—"}
          </Text>
          <Box gap={2}>
            <Text>
              {t("run.phase")} <Text color="yellow">{current.subphase}</Text>
            </Text>
            {current.round && (
              <Text>
                {t("run.round")} {current.round.n}/{current.round.max}
              </Text>
            )}
            {current.attempt && (
              <Text>
                {t("run.attempt")} {current.attempt.n}/{current.attempt.max}
              </Text>
            )}
          </Box>
          <Box gap={2}>
            {gate(t("run.gate.exec"), current.gates.exec)}
            {gate(t("run.gate.tests"), current.gates.tests)}
            {gate(t("run.gate.review"), current.gates.review)}
          </Box>
          {elapsedS !== undefined && (
            <Text dimColor>
              {timeoutS !== undefined ? bar(elapsedS / timeoutS, 20) + " " : ""}
              {elapsedS}s{timeoutS !== undefined ? ` / ${timeoutS}s` : ""}
            </Text>
          )}
          <Box flexDirection="column" marginTop={1}>
            {current.lines.map((line, i) => (
              <Text key={i} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      </Box>
      <Text color={s.pendingConfirm || s.stalled ? "yellow" : undefined}>{selectFooterHint(s)}</Text>
    </Box>
  );
}
