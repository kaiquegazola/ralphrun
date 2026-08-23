// run-child.ts — one run, one process.
//
// The core's run loop keeps per-run state in MODULE globals: the event bus in
// tui/events.ts, the locale in i18n.ts, the advisor plan cache. Two runs in one
// process would share all three, so parallelism has to be a process boundary —
// which is also what makes a stuck run killable without touching its siblings.
//
// stdout is a pure NDJSON channel. Everything the core would print (log lines,
// spawn warnings) is captured by patching console BEFORE the loop is imported,
// so no stray write can corrupt a frame.

// a TYPE import is erased, so it does not pull the module in before console is
// patched — the runtime import stays inside main()
import type { GateAnswer } from "../../../src/gate.js";

const emitLine = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};

for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    emitLine({ t: "log", line: args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") });
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * End by setting the exit code and letting node finish, NOT by process.exit.
 *
 * The last frame is the one that matters most — for a failed run it carries the
 * only diagnostic the supervisor will ever see — and on a pipe process.exit can
 * tear the process down with that frame still buffered. Releasing stdin (the
 * gate's answer channel is the one thing holding the loop open) lets the runtime
 * flush and exit on its own.
 */
function finish(code: number): void {
  process.exitCode = code;
  // pause is enough to stop holding the loop open; unref is not implemented for
  // every stdin kind (a TTY under Bun has none), so it is best-effort.
  process.stdin.pause();
  process.stdin.unref?.();
}

async function main(): Promise<void> {
  const prd = arg("prd");
  const workspace = arg("workspace");
  if (!prd || !workspace) {
    emitLine({ t: "exit", code: 2, error: "run-child: --prd and --workspace are required" });
    finish(2);
    return;
  }

  // The CLI sets the locale from argv/user config before anything renders; this
  // process has no argv to read, so it does the same from the saved preference.
  // Without it every progress.md line and error a GUI run writes is English.
  const { resolveLocale, setLocale } = await import("../../../src/i18n.js");
  setLocale(resolveLocale(arg("lang")));

  const { on } = await import("../../../src/tui/events.js");
  const { setReviewGate } = await import("../../../src/gate.js");
  const { requeueTask } = await import("../../../src/requeue.js");
  const { runLoop } = await import("../../../src/loop.js");

  on((e) => emitLine({ t: "ev", e }));

  // ── the decision inbox, from the loop's side ─────────────────────────────
  // A task the reviewer refused stops HERE, waiting on the human, instead of
  // being decided by review_blocked_policy and having its cell discarded before
  // anyone saw it. The supervisor writes the answer back on stdin, keyed by an
  // id, so a wave can have several tasks waiting at once without their answers
  // getting crossed.
  const pending = new Map<string, (a: GateAnswer) => void>();
  let gateSeq = 0;

  let stdinBuf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    stdinBuf += chunk;
    const lines = stdinBuf.split("\n");
    stdinBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as {
          t?: string;
          id?: string;
          answer?: GateAnswer;
          taskId?: string;
          action?: "retry" | "accept";
        };
        // A decision on a task the loop already settled. It is applied HERE,
        // inside the process that owns prd.json: this handler runs on the same
        // event loop as the loop's own synchronous read-modify-write, so the
        // two cannot interleave. From the supervisor's process they would.
        if (msg.t === "decide" && msg.taskId) {
          // its OWN catch: the outer one exists for corrupt control lines, and
          // letting a failed write fall into it would drop the receipt. The
          // supervisor has already dismissed the inbox item by then, so a
          // silent failure is a decision that disappears.
          let ok = false;
          try {
            ok = requeueTask(prd, msg.taskId, msg.action ?? "retry");
          } catch {
            ok = false;
          }
          emitLine({ t: "decided", taskId: msg.taskId, ok });
          continue;
        }
        if (msg.t !== "gate-answer" || !msg.id) continue;
        const resolve = pending.get(msg.id);
        if (!resolve) continue;
        pending.delete(msg.id);
        resolve(msg.answer ?? "block");
      } catch {
        // a corrupt control line must not take the run down with it
      }
    }
  });

  setReviewGate(
    (req) =>
      new Promise<GateAnswer>((resolve) => {
        const id = `g${++gateSeq}`;
        pending.set(id, resolve);
        emitLine({ t: "gate", id, ...req });
      }),
  );

  try {
    await runLoop({
      prd,
      workspace,
      config: arg("config"),
      task: arg("task"),
      // a GUI run is unattended at the process level: the human answers in the
      // inbox (see the gate above), not at a prompt this process could show.
      skipConfirm: true,
    });
    emitLine({ t: "exit", code: 0 });
    finish(0);
  } catch (err) {
    emitLine({ t: "exit", code: 1, error: err instanceof Error ? err.message : String(err) });
    finish(1);
  }
}

await main();
