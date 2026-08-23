// prdwrite.ts — the one way prd.json reaches disk.
//
// A backlog is rewritten while a run is mid-flight, so a plain writeFileSync
// that dies halfway (disk full, power, a kill between truncate and write)
// leaves the file TRUNCATED — and the loop's next read finds no tasks at all.
// tmp + rename in the same directory makes the swap atomic: the old backlog
// stays whole until the new one is complete.
import { renameSync, rmSync, writeFileSync } from "node:fs";

import type { PRD } from "./prd.js";

let seq = 0;

/** Throws whatever the write threw, having cleaned up its own temp file. */
export function savePrdAtomic(prdPath: string, prd: PRD): void {
  // pid + counter: two processes saving the same backlog must not share a tmp
  const tmp = `${prdPath}.${process.pid}.${++seq}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(prd, null, 2) + "\n");
    renameSync(tmp, prdPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
