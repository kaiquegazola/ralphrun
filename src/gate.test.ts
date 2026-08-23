// gate.test.ts — the headless review gate is process-global state, so the two
// things worth pinning are that it starts absent and that it can be cleared.
import { describe, it, expect, afterEach } from "vitest";

import { reviewGate, setReviewGate } from "./gate.js";

afterEach(() => setReviewGate(null));

describe("reviewGate", () => {
  it("is absent by default, so an unhosted headless run still decides by policy", () => {
    expect(reviewGate()).toBeNull();
  });

  it("hands back the installed gate and can be cleared again", async () => {
    const gate = async (): Promise<"approve"> => "approve";
    setReviewGate(gate);
    expect(reviewGate()).toBe(gate);
    await expect(reviewGate()!({ taskId: "t1", reason: "r", canApprove: true })).resolves.toBe("approve");

    setReviewGate(null);
    expect(reviewGate()).toBeNull();
  });
});
