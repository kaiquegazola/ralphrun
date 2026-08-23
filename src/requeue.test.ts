// requeue.test.ts — one task's status, rewritten in the process that owns the
// backlog. The point of the module is WHERE it runs, so what is testable here
// is that it changes exactly one task and refuses everything it cannot.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { requeueTask } from "./requeue.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}));

const mRead = vi.mocked(readFileSync);
const mWrite = vi.mocked(writeFileSync);

const PRD = {
  project: "qc",
  stack: "ts",
  architecture_notes: "",
  tasks: [
    { id: "t1", title: "one", status: "doing", deps: [], retries: 0 },
    { id: "t2", title: "two", status: "blocked", deps: ["t1"], retries: 3 },
  ],
};

/** What the file would hold after the call. */
function written(): typeof PRD {
  return JSON.parse(String(mWrite.mock.calls.at(-1)![1]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mRead.mockReturnValue(JSON.stringify(PRD) as never);
});

describe("requeueTask", () => {
  it("puts a blocked task back to todo with a full retry budget", () => {
    // a task that comes back with its attempts already spent re-blocks on the
    // first stumble, which is not what the human asked for
    expect(requeueTask("/repo/prd.json", "t2", "retry")).toBe(true);
    expect(written().tasks[1]).toMatchObject({ id: "t2", status: "todo", retries: 0 });
  });

  it("marks a task done on accept, leaving its retry count alone", () => {
    expect(requeueTask("/repo/prd.json", "t2", "accept")).toBe(true);
    expect(written().tasks[1]).toMatchObject({ id: "t2", status: "done", retries: 3 });
  });

  it("leaves every other task exactly as it found it", () => {
    // the sibling is IN FLIGHT: rewriting its status from here is the bug this
    // whole module exists to avoid
    requeueTask("/repo/prd.json", "t2", "retry");
    expect(written().tasks[0]).toMatchObject({ id: "t1", status: "doing" });
  });

  it("drops the advisor plan a retry must not inherit", () => {
    mRead.mockReturnValue(
      JSON.stringify({
        ...PRD,
        tasks: [{ ...PRD.tasks[1], plan: "do it like this", planKey: "abc123" }],
      }) as never,
    );
    requeueTask("/repo/prd.json", "t2", "retry");
    // the cached plan belongs to the attempt that FAILED; its key still matches,
    // so leaving it would hand the retry the same plan that did not work
    expect(written().tasks[0]).not.toHaveProperty("plan");
    expect(written().tasks[0]).not.toHaveProperty("planKey");
  });

  it("puts a task back to blocked for a host rolling its own write back", () => {
    // a host that reset a task and then could not start the run has to restore
    // the status rather than leave a retry nothing will ever execute
    expect(requeueTask("/repo/prd.json", "t2", "block")).toBe(true);
    expect(written().tasks[1]).toMatchObject({ id: "t2", status: "blocked", retries: 3 });
  });

  it("swaps the backlog in atomically instead of truncating it mid-write", () => {
    // a write that dies halfway leaves NO tasks for the loop to read; the old
    // file has to stay whole until the new one is complete
    requeueTask("/repo/prd.json", "t2", "retry");
    const tmp = String(mWrite.mock.calls[0][0]);
    expect(tmp).toMatch(/^\/repo\/prd\.json\..*\.tmp$/);
    expect(vi.mocked(renameSync)).toHaveBeenCalledWith(tmp, "/repo/prd.json");
  });

  it("reports a write it could not do rather than throwing at its caller", () => {
    // the callers are answering a HUMAN decision — they have to say "not
    // applied" (the item comes back) instead of taking the host process down
    mWrite.mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    expect(requeueTask("/repo/prd.json", "t2", "retry")).toBe(false);
  });

  it("refuses an unknown task without writing anything", () => {
    expect(requeueTask("/repo/prd.json", "t9", "retry")).toBe(false);
    expect(mWrite).not.toHaveBeenCalled();
  });

  it("refuses an unreadable or non-PRD file instead of throwing", () => {
    mRead.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(requeueTask("/repo/prd.json", "t2", "retry")).toBe(false);

    mRead.mockReturnValue("{not json" as never);
    expect(requeueTask("/repo/prd.json", "t2", "retry")).toBe(false);

    mRead.mockReturnValue(JSON.stringify({ project: "qc" }) as never);
    expect(requeueTask("/repo/prd.json", "t2", "retry")).toBe(false);
    expect(mWrite).not.toHaveBeenCalled();
  });
});
