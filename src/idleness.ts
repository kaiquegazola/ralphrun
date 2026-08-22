// idleness.ts — the escalating-silence watchdog shared by every spawned phase.
//
// A turn dies by LIVENESS, not by a wall-clock budget: while output keeps
// flowing, the child runs as long as the model needs — slow generation is work,
// not a hang (a 22KB PRD once died mid-string at an old 10-min wall clock).
// Silence is the hang signal, and it escalates: each stepMs of CONTINUOUS
// silence climbs one rung — early rungs only ANNOUNCE (the user sees the stall
// forming), the last rung kills. Every line from the child resets to rung
// zero, so provider backoff, silent retries and slow thinking all pass; a
// genuinely frozen stream does not (proven against opencode's own log: request
// opened, zero tokens, zero errors until we cut it).

export interface IdleLadder {
  /** a line arrived: back to rung zero */
  bump(): void;
  /** stop the ladder alongside the other timers */
  stop(): void;
}

export function startIdleLadder(opts: {
  /** milliseconds of continuous silence per rung */
  stepMs: number;
  /** total rungs; the LAST one is lethal */
  steps: number;
  /** a non-lethal rung was reached: announce it where the user looks */
  warn(mins: number): void;
  /** the last rung: the caller owns the kill */
  fatal(): void;
}): IdleLadder {
  let rung = 0;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      rung++;
      if (rung < opts.steps) {
        opts.warn((rung * opts.stepMs) / 60_000);
        arm();
      } else {
        opts.fatal();
      }
    }, opts.stepMs);
    timer.unref?.();
  };
  arm(); // armed at creation: zero-output silence climbs from t0
  return {
    bump: (): void => {
      rung = 0;
      arm();
    },
    stop: (): void => clearTimeout(timer),
  };
}
