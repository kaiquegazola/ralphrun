// log.ts — append-only run log to stdout + progress.md with [HH:MM:SS] timestamp

import { appendFileSync } from "node:fs";

type Reporter = (line: string) => void;
let reporter: Reporter | null = null;
export function setReporter(r: Reporter | null): void {
  reporter = r;
}

export function log(progressPath: string, msg: string): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const line = `- [${hh}:${mm}:${ss}] ${msg}`;
  appendFileSync(progressPath, line + "\n");
  if (reporter) reporter(line);
  else console.log(line);
}