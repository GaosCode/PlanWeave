import { describe, expect, it } from "vitest";
import { observeAutoRunStorageLockOrder } from "./helpers/autoRunStorageLockOrderProcessFixture.js";

describe("Auto Run storage and transition lock order", () => {
  it.each([
    false,
    true
  ])("finishes concurrent public summary and start with a pending intent (session=%s)", async (withSession) => {
    const result = await observeAutoRunStorageLockOrder(withSession);
    expect(result.recoveryDone).toBe(true);
    expect(result.startDone).toBe(true);
    expect(result.recoveryError).toBeNull();
    if (result.startError !== null) {
      expect(result.startError).toContain("another Auto Run is active");
    }
    expect(result.startPendingReads).toBeGreaterThan(0);
  });
});
