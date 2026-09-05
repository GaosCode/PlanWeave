import { describe, expect, it } from "vitest";
import { acpConversationActionSchema } from "../acpConversationProtocol.js";

describe("remote ACP conversation actions", () => {
  it("requires the original session and a stable turn identity to send a follow-up", () => {
    const action = {
      kind: "prompt",
      turnId: "turn-1",
      executionAttemptId: "attempt-1",
      sessionId: "original-session",
      text: "Continue our discussion"
    };
    expect(acpConversationActionSchema.parse(action)).toEqual(action);
    expect(acpConversationActionSchema.safeParse({ ...action, sessionId: "" }).success).toBe(false);
    expect(acpConversationActionSchema.safeParse({ ...action, turnId: undefined }).success).toBe(
      false
    );
  });

  it("does not permit a silent new-session fallback or empty prompt", () => {
    expect(
      acpConversationActionSchema.safeParse({
        kind: "prompt",
        turnId: "turn-1",
        executionAttemptId: "attempt-1",
        sessionId: "original-session",
        text: "   "
      }).success
    ).toBe(false);
    expect(
      acpConversationActionSchema.safeParse({
        kind: "prompt",
        turnId: "turn-1",
        executionAttemptId: "attempt-1",
        sessionId: "original-session",
        text: "Hello",
        fallback: "new"
      }).success
    ).toBe(false);
  });
});
