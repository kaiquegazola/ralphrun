// gate.ts — the seam a HEADLESS host uses to answer a review-blocked task.
//
// A run with a TUI asks the human through the dashboard modal. A run with no
// TTY has always answered from a policy instead (review_blocked_policy),
// because nothing was on the other end. A GUI host IS on the other end: it can
// show the reviewer's refusal in an inbox and hand back the same four answers
// the modal produces — but only if the loop waits for it.
//
// So a host may install ONE gate for its process. Without it nothing changes:
// the policy still decides, and every existing headless run behaves exactly as
// it did. The safety property the modal has is preserved by the CALLER, not by
// this module: `canApprove` is false when no verify passed, and taskrun refuses
// an approve it did not offer.

export type GateAnswer = "retry" | "approve" | "block" | "quit";

export interface GateRequest {
  taskId: string;
  /** the reviewer's reason, already shaped for a human to read */
  reason: string;
  /** false = the task has no passing verify, so "approve" must not be offered */
  canApprove: boolean;
}

export type ReviewGate = (req: GateRequest) => Promise<GateAnswer>;

let gate: ReviewGate | null = null;

/** Install (or clear, with null) the process's headless review gate. */
export function setReviewGate(g: ReviewGate | null): void {
  gate = g;
}

export function reviewGate(): ReviewGate | null {
  return gate;
}
