// PrdApp.tsx — Ink render of the PRD studio, embeddable as the wizard's studio
// screen. TOP: header + aligned task table; MIDDLE: chat tail; BOTTOM: input
// line + statusbar. All PRD state lives in prdController; only the input BUFFER,
// '@'-picker flags, the q → quit? y/n gate, and the spinner frame are ephemeral
// local useState. Accepts height/width from the fullscreen shell (flexible
// row budget replaces the old fixed MAX_ROWS/CHAT_TAIL). useInput drives send /
// s (save) / c (build) / u / q and the inline '@' fuzzy file picker; `active`
// folds into isActive so the wizard shell owns keys on non-studio screens.
// Excluded from coverage.

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { t } from "../../i18n.js";
import type { TaskStatus } from "../../prd.js";
import { searchFiles } from "../../picker.js";
import { validatePrd } from "./validatePrd.js";
import { canSave, taskCount, depsOk, type PrdAction, type PrdState, type Role } from "./prdController.js";
import { mdToLines, type Span, type SpanStyle } from "./markdown.js";

export interface PrdStore {
  subscribe(cb: () => void): () => void;
  getSnapshot(): PrdState;
  dispatch(a: PrdAction): void;
}

export interface PrdAppProps {
  store: PrdStore;
  cwd: string;
  onSend(text: string): void;
  onSave(): void; // [s]/ctrl+s — mount decides save-as vs silent re-save
  onBuild(): void; // [c] CONSTRUIR — save then resolve run:true
  onQuit(): void;
  savedPath?: string | null; // wizard's remembered save path (statusbar "saved ✓")
  height?: number; // content rows available (fullscreen shell); default fits inline use
  width?: number;
  active?: boolean; // false = another screen owns the keys
}

const GLYPH: Record<TaskStatus, string> = { todo: "○", doing: "⠿", done: "✓", blocked: "✗" };
const COLOR: Record<TaskStatus, string> = { todo: "gray", doing: "cyan", done: "green", blocked: "red" };
const MSG_COLOR: Record<Role, string | undefined> = { you: "cyan", planner: undefined, error: "red" };

// markdown-lite span -> Text props (OpenCode-ish styling)
function spanProps(st: SpanStyle): { color?: string; bold?: boolean; dimColor?: boolean } {
  if (st === "heading") return { color: "cyan", bold: true };
  if (st === "bold") return { bold: true };
  if (st === "code") return { color: "yellow" };
  if (st === "bullet") return { color: "cyan" };
  return {};
}

const PREFIX_W = 10; // "planner › " — chat text wraps at cols - PREFIX_W

const PICKER_MAX = 8;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// the row budget assumes ONE rendered row per item, but wrap="truncate-end"
// preserves embedded newlines — flatten them so a multiline title/message
// can't blow the budget.
const oneLine = (t: string): string => t.replace(/\s*\n\s*/g, " ");

export function PrdApp({ store, cwd, onSend, onSave, onBuild, onQuit, savedPath, height, width, active }: PrdAppProps): React.ReactElement {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [buffer, setBuffer] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pendingQuit, setPendingQuit] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null); // s/c pressed with an invalid PRD
  const [frame, setFrame] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0); // rows scrolled up from the chat tail
  const [focus, setFocus] = useState<"input" | "table">("input"); // Tab alterna
  const [taskCursor, setTaskCursor] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);

  // new message (or a streaming chunk) snaps the chat back to the tail
  useEffect(() => setScrollOffset(0), [s.messages.length]);
  // keep the task cursor valid when the planner rewrites the task list
  const nTasks = s.prd?.tasks?.length ?? 0;
  useEffect(() => setTaskCursor((c) => Math.min(c, Math.max(0, nTasks - 1))), [nTasks]);

  const drafting = s.status === "drafting";
  useEffect(() => {
    if (!drafting) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [drafting]);

  const atIdx = buffer.lastIndexOf("@");
  const fragment = pickerOpen && atIdx >= 0 ? buffer.slice(atIdx + 1) : "";
  // full result set (searchFiles default cap) — PICKER_MAX is only the visible
  // window; ↑↓ scrolls through everything like Claude Code's '@'.
  const results = pickerOpen ? searchFiles(fragment, cwd) : [];

  // [s]/[c]/ctrl+s with an invalid PRD: flash WHY in the statusbar (no dispatch)
  const gated = (fn: () => void): void => {
    if (canSave(s)) return void fn();
    const errors = s.prd ? validatePrd(s.prd).errors.join("; ") : t("studio.header.empty");
    setSaveErr(t("studio.err.cantSave", { errors }));
  };

  useInput(
    (input, key) => {
      if (saveErr) setSaveErr(null); // flash clears on the next keypress
      // ctrl+c routes through the same y/n gate as [q], so a dirty PRD always
      // warns before quitting — including mid-draft (the shell skips studio).
      if (key.ctrl && input === "c") return void setPendingQuit(true);
      if (pendingQuit) {
        if (input === "y") return void onQuit();
        if (input === "n" || key.escape) return void setPendingQuit(false);
        return; // swallow everything else while confirming
      }
      if (drafting) {
        // planner turn owns the terminal — but say WHY save is blocked, and
        // keep quit reachable (the y/n gate above still warns when dirty).
        if (input === "s" || input === "c" || (key.ctrl && input === "s")) {
          return void setSaveErr(t("studio.err.draftingSave"));
        }
        if (input === "q") return void setPendingQuit(true);
        return; // swallow the rest while drafting
      }
      if (pickerOpen) {
        if (key.escape) return void setPickerOpen(false);
        if (key.upArrow) return void setPickerIndex((i) => Math.max(0, i - 1));
        if (key.downArrow) return void setPickerIndex((i) => Math.min(results.length - 1, i + 1));
        if (key.return) {
          const chosen = results[pickerIndex];
          if (chosen?.dir) {
            // descend into the folder: replace the fragment with its path and keep picking
            setBuffer(buffer.slice(0, atIdx + 1) + chosen.absolute + "/");
            setPickerIndex(0);
            return;
          }
          if (chosen) {
            store.dispatch({ type: "addAttachment", path: chosen.absolute });
            setBuffer(buffer.slice(0, atIdx) + "@" + chosen.relative + " ");
          }
          setPickerOpen(false);
          setPickerIndex(0);
          return;
        }
        if (key.backspace || key.delete) {
          const nb = buffer.slice(0, -1);
          setBuffer(nb);
          if (nb.length <= atIdx) setPickerOpen(false); // backspaced over the '@'
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setBuffer(buffer + input);
          setPickerIndex(0);
        }
        return;
      }

      // ctrl+s saves in BOTH focus modes (best-effort: many terminals eat it as
      // XOFF flow control — [s] on an empty buffer is the primary binding).
      if (key.ctrl && input === "s") return void gated(onSave);

      // Tab alterna foco input <-> tabela de tasks (o "clique" é teclado)
      if (key.tab) {
        setDetailOpen(false);
        return void setFocus((f) => (f === "input" ? "table" : "input"));
      }

      if (focus === "table") {
        if (detailOpen) {
          // modal: qualquer tecla de saída fecha; edição fica pro chat ("task 15: …")
          if (key.escape || key.return || input === "q") return void setDetailOpen(false);
          return;
        }
        const tasksNow = Array.isArray(s.prd?.tasks) ? s.prd.tasks : [];
        if (key.upArrow) return void setTaskCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) return void setTaskCursor((c) => Math.min(Math.max(0, tasksNow.length - 1), c + 1));
        if (key.return) return void setDetailOpen(tasksNow.length > 0);
        if (key.escape) return void setFocus("input");
        if (input === "u") return void store.dispatch({ type: "undo" });
        if (input === "s") return void gated(onSave);
        if (input === "c") return void gated(onBuild);
        if (input === "q") return void setPendingQuit(true);
        return; // table focus swallows the rest
      }

      if (key.escape) return; // nothing to close
      // chat scroll — ↑/↓ scroll by line (the mouse wheel sends these via the
      // ?1007 alternate-scroll mode); PgUp/PgDn jump (ctrl+u/ctrl+d fallback).
      if (key.upArrow) return void setScrollOffset((o) => o + 1);
      if (key.downArrow) return void setScrollOffset((o) => Math.max(0, o - 1));
      if (key.pageUp || (key.ctrl && input === "u")) return void setScrollOffset((o) => o + 5);
      if (key.pageDown || (key.ctrl && input === "d")) return void setScrollOffset((o) => Math.max(0, o - 5));
      if (key.return) {
        const t = buffer.trim();
        if (t) {
          onSend(t);
          setBuffer("");
        }
        return; // empty input is a no-op
      }
      if (key.backspace || key.delete) return void setBuffer((b) => b.slice(0, -1));
      if (input === "@") {
        setBuffer((b) => b + "@");
        setPickerOpen(true);
        setPickerIndex(0);
        return;
      }
      // s/c/u/q are typeable letters — fire the command ONLY on an empty buffer.
      if (buffer === "") {
        if (input === "s") return void gated(onSave);
        if (input === "c") return void gated(onBuild);
        if (input === "u") return void store.dispatch({ type: "undo" });
        if (input === "q") return void setPendingQuit(true);
      }
      if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
    },
    // stays active while drafting: the drafting branch above surfaces WHY
    // save is blocked and keeps q/ctrl+c on the y/n quit gate.
    { isActive: active !== false },
  );

  const prd = s.prd;
  const project = prd?.project ?? t("studio.header.newProject");
  const ok = canSave(s);
  // derived, no timers: shows after any save, clears when the next edit sets
  // dirty again. ponytail: persistent while clean, not a timed flash.
  const savedFlash = savedPath != null && !s.dirty;
  const dep = prd
    ? depsOk(s)
      ? t("studio.header.depsOk")
      : t("studio.header.issues", { n: validatePrd(prd).errors.length })
    : t("studio.header.empty");
  // Array.isArray: a seeded invalid PRD is sanitized upstream, but a non-array
  // `tasks` must never crash the render (tasks.slice below).
  const tasks = Array.isArray(prd?.tasks) ? prd.tasks : [];

  // row budget: header + separator + input + statusbar are fixed; picker and
  // attachments lines appear as needed; the rest splits table/chat. NO floors:
  // the budget never exceeds `height`, so a tiny terminal shrinks the panes
  // instead of painting overflow rows over budgeted ones.
  const totalRows = height ?? 24;
  const cols = width ?? 80;
  const pickerRows = pickerOpen ? Math.max(1, Math.min(results.length, PICKER_MAX)) : 0;
  const selTask = focus === "table" ? (tasks[taskCursor] ?? null) : null;
  const detail = detailOpen && selTask ? selTask : null; // modal replaces the body, no row budget needed
  const fixed = 4 + (s.attachments.length > 0 ? 1 : 0) + pickerRows;
  const body = Math.max(0, totalRows - fixed);
  const taskRows = Math.min(Math.max(tasks.length, 1), Math.max(body > 0 ? 1 : 0, Math.floor(body / 2)));
  const chatRows = Math.max(0, body - taskRows);

  // table window follows the cursor when the table has focus, so the selected
  // row is always visible even with more tasks than rows.
  const visTaskRows = tasks.length > taskRows ? Math.max(0, taskRows - 1) : taskRows;
  const winStart =
    tasks.length > visTaskRows && focus === "table"
      ? Math.max(0, Math.min(taskCursor - Math.floor(visTaskRows / 2), tasks.length - visTaskRows))
      : 0;
  const shown = tasks.slice(winStart, winStart + Math.max(visTaskRows, tasks.length <= taskRows ? tasks.length : 0));
  const more = tasks.length - winStart - shown.length;
  const idW = shown.reduce((w, t) => Math.max(w, t.id.length), 2);
  const numW = String(Math.max(1, tasks.length)).length;

  // chat: every message flattened into EXACT styled rows (markdown-lite, hard-
  // wrapped at cols - PREFIX_W), then windowed by scrollOffset rows from the
  // tail. Exact rows = scrolling and the budget can't drift apart.
  const chatW = Math.max(1, cols - PREFIX_W);
  // while drafting, the live planner message shows the spinner: "⠹ thinking…"
  // (studio.thinking) before the first chunk, "…text ⠹" while streaming.
  const msgsForRender = s.messages.slice();
  if (drafting && msgsForRender.length > 0) {
    const last = msgsForRender[msgsForRender.length - 1];
    if (last.role === "planner") {
      msgsForRender[msgsForRender.length - 1] = {
        ...last,
        text: last.text ? `${last.text} ${SPINNER[frame]}` : `${SPINNER[frame]} ${t("studio.thinking")}`,
      };
    }
  }
  const allRows: Array<{ role: Role; spans: Span[]; first: boolean }> = [];
  for (const m of msgsForRender) {
    mdToLines(m.text, chatW).forEach((spans, i) => allRows.push({ role: m.role, spans, first: i === 0 }));
  }
  const maxOffset = Math.max(0, allRows.length - chatRows);
  const off = Math.min(scrollOffset, maxOffset);
  const scrolled = off > 0;
  const contentRows = scrolled ? Math.max(0, chatRows - 1) : chatRows; // 1 row for the ▼ indicator
  const rowsEnd = allRows.length - off;
  const visible = contentRows > 0 ? allRows.slice(Math.max(0, rowsEnd - contentRows), rowsEnd) : [];

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Text bold wrap="truncate-end">
        {t("studio.header.prd")} {oneLine(project)}{" "}
        <Text dimColor>· {t("studio.header.tasks", { n: taskCount(s) })} ·</Text>{" "}
        <Text color={prd && depsOk(s) ? "green" : "yellow"}>{dep}</Text>
      </Text>

      {detail ? (
        // modal centralizado: substitui tabela+chat com o detalhe completo
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
            width={Math.min(Math.max(40, cols - 8), 76)}
          >
            <Text bold color="cyan" wrap="truncate-end">
              #{taskCursor + 1} {detail.id} — {oneLine(detail.title)}
            </Text>
            <Text wrap="truncate-end">
              <Text color={COLOR[detail.status]}>{GLYPH[detail.status]} {detail.status}</Text>
              <Text dimColor>  deps:[{detail.deps.join(",")}]  retries:{detail.retries}</Text>
            </Text>
            <Text> </Text>
            <Text wrap="wrap">{detail.description.slice(0, 1200) || t("studio.detail.noDescription")}</Text>
            {detail.acceptance.length > 0 && <Text> </Text>}
            {detail.acceptance.map((a, i) => (
              <Text key={i} wrap="wrap">
                <Text color="cyan">• </Text>
                {a}
              </Text>
            ))}
            <Text> </Text>
            <Text wrap="wrap">
              <Text dimColor>{t("studio.detail.verify")}</Text>{" "}
              <Text color="yellow">{detail.verify ?? t("studio.detail.noVerify")}</Text>
            </Text>
            <Text dimColor>{t("studio.detail.hint", { n: taskCursor + 1 })}</Text>
          </Box>
        </Box>
      ) : (
        <>
          <Box flexDirection="column">
            {tasks.length === 0 && taskRows > 0 && <Text dimColor>{t("studio.noTasks")}</Text>}
            {shown.map((t, i) => {
              const n = winStart + i;
              const sel = focus === "table" && n === taskCursor;
              return (
                <Text key={t.id} wrap="truncate-end">
                  <Text color="cyan">{sel ? "❯" : " "}</Text>
                  <Text dimColor>{String(n + 1).padStart(numW)}</Text>{" "}
                  <Text color={COLOR[t.status]}>{GLYPH[t.status]}</Text>{" "}
                  <Text bold={sel} dimColor={!sel && t.status === "todo"}>
                    {t.id.padEnd(idW)}  {oneLine(t.title)}
                  </Text>
                  <Text dimColor>  deps:[{t.deps.join(",")}]</Text>
                </Text>
              );
            })}
            {more > 0 && taskRows > 0 && <Text dimColor>{t("studio.moreTasks", { n: more })}</Text>}
          </Box>

          <Text dimColor>{"─".repeat(Math.max(0, cols))}</Text>

          <Box flexDirection="column" flexGrow={1}>
            {visible.map((r, i) => (
              <Text key={i} wrap="truncate-end">
                <Text color={MSG_COLOR[r.role]} dimColor={r.role === "planner"}>
                  {r.first ? `${t(`studio.role.${r.role}`).padEnd(PREFIX_W - 3)} › ` : " ".repeat(PREFIX_W)}
                </Text>
                {r.spans.map((sp, j) => (
                  <Text key={j} {...spanProps(sp.style)} color={MSG_COLOR[r.role] === "red" ? "red" : spanProps(sp.style).color}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            ))}
            {scrolled && (
              <Text dimColor>{t(off === 1 ? "studio.scrollBelowOne" : "studio.scrollBelowMany", { n: off })}</Text>
            )}
          </Box>
        </>
      )}

      {s.attachments.length > 0 && (
        <Text dimColor wrap="truncate-end">
          @ {s.attachments.map((a) => a.path).join(", ")}
        </Text>
      )}

      {pickerOpen &&
        (results.length === 0 ? (
          <Text dimColor>{t("common.noMatch")}</Text>
        ) : (
          <Box flexDirection="column">
            {(() => {
              // scroll window of PICKER_MAX rows around the cursor
              const win = Math.min(results.length, PICKER_MAX);
              const start = Math.max(0, Math.min(pickerIndex - Math.floor(win / 2), results.length - win));
              return results.slice(start, start + win).map((r, i) => {
                const idx = start + i;
                return (
                  <Text key={r.absolute} wrap="truncate-end">
                    {idx === pickerIndex ? <Text color="cyan">❯ </Text> : "  "}
                    <Text bold={idx === pickerIndex} dimColor={idx !== pickerIndex} color={r.dir ? "blue" : undefined}>
                      {r.relative}
                    </Text>
                    {idx === pickerIndex && results.length > win ? (
                      <Text dimColor>{`  ${pickerIndex + 1}/${results.length}`}</Text>
                    ) : null}
                  </Text>
                );
              });
            })()}
          </Box>
        ))}

      <Text wrap="truncate-end">
        <Text color="cyan">{drafting ? `${SPINNER[frame]} ` : "❯ "}</Text>
        {buffer}
        {!drafting && <Text dimColor>▌</Text>}
      </Text>

      {pendingQuit ? (
        <Text color="yellow">
          {t(s.dirty ? "studio.quit.confirmUnsaved" : "studio.quit.confirm")} <Text color="cyan">y</Text>{" "}
          {t("studio.quit.yes")} · <Text color="cyan">n</Text> {t("studio.quit.stay")}
        </Text>
      ) : saveErr !== null ? (
        <Text color="yellow" wrap="truncate-end">
          {saveErr}
        </Text>
      ) : focus === "table" ? (
        <Text dimColor wrap="truncate-end">
          <Text color="cyan">↑↓</Text> {t("studio.hint.task")} · <Text color="cyan">⏎</Text> {t("studio.hint.details")} ·{" "}
          <Text color="cyan">u</Text> {t("studio.hint.undo")} · <Text color="cyan">tab</Text> {t("studio.hint.chat")} ·{" "}
          <Text color="cyan">q</Text> {t("studio.hint.quit")}
          {savedFlash && <Text color="green"> · {t("studio.savedFlash")}</Text>}
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          <Text color="cyan">⏎</Text> {t("studio.hint.send")} · <Text color="cyan">@</Text> {t("studio.hint.attach")} ·{" "}
          <Text color={ok ? "cyan" : undefined}>s</Text> {t("studio.hint.save")} ·{" "}
          <Text color={ok ? "cyan" : undefined}>c</Text> {t("studio.hint.build")} · <Text color="cyan">u</Text>{" "}
          {t("studio.hint.undo")} · <Text color="cyan">tab</Text> {t("studio.hint.tasks")} ·{" "}
          <Text color="cyan">⇞⇟</Text> {t("studio.hint.scroll")} · <Text color="cyan">q</Text> {t("studio.hint.quit")}
          {savedFlash && <Text color="green"> · {t("studio.savedFlash")}</Text>}
        </Text>
      )}
    </Box>
  );
}
