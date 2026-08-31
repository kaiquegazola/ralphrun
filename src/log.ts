// log.ts — append-only run log to stdout + progress.md with [HH:MM:SS] timestamp

import { appendFileSync } from "node:fs";

import { t } from "./i18n.js";

/** Raw agent output is useful for diagnosing a run, but it is not the audit log. */
export const MAX_RAW_LOG_CHARS = 64_000;

type Reporter = (line: string) => void;
let reporter: Reporter | null = null;
export function setReporter(r: Reporter | null): void {
  reporter = r;
}

export function log(progressPath: string, msg: string, forwardToReporter = true, persist = true): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const line = `- [${hh}:${mm}:${ss}] ${msg}`;
  if (persist) appendFileSync(progressPath, line + "\n");
  if (reporter) {
    if (forwardToReporter) reporter(line);
  } else {
    console.log(line);
  }
}

export interface RawLogWriter {
  write(line: string): void;
  finish(): void;
}

/**
 * Keep the live TUI lossless while bounding the copy persisted to progress.md.
 * A new writer belongs to one executor call, so retries and review rounds do
 * not share a counter and the module keeps no per-task state between calls.
 */
export function createRawLog(progressPath: string, tag: string, maxChars = MAX_RAW_LOG_CHARS): RawLogWriter {
  let written = 0;
  let droppedLines = 0;
  let droppedChars = 0;
  let finished = false;
  const prefix = "  " + tag + "› ";
  // `log` adds `- [HH:MM:SS] ` and a newline around every message. Charge
  // those characters too, otherwise a raw payload at the cap still grows the
  // file past it by one timestamp/prefix per line.
  const recordOverhead = 14 + prefix.length;

  return {
    write(line: string): void {
      if (finished || !line.trim()) return;
      const remaining = Math.max(0, maxChars - written);
      if (line.length + recordOverhead > remaining) {
        droppedLines += 1;
        droppedChars += line.length;
        // The live TUI already received this line. In headless mode it still
        // belongs on stdout, but it must not be written to the bounded log.
        log(progressPath, prefix + line, false, false);
        return;
      }
      log(progressPath, prefix + line, false);
      written += recordOverhead + line.length;
    },
    finish(): void {
      if (finished) return;
      finished = true;
      if (droppedLines > 0) {
        log(progressPath, t("exec.rawTruncated", { tag, n: droppedLines, chars: droppedChars }), false);
      }
    },
  };
}
