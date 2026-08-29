import { describe, expect, it } from "vitest";
import { remoteRunnerEventBatchV2Schema, runnerBodyFragmentSchema } from "../runnerEvents.js";
import { redactRunnerEventPayload } from "../runnerEventRedaction.js";

const redaction = { classes: [], replaced: 0 } as const;
const persistedInteraction = {
  version: "planweave.runner/v1" as const,
  interactionId: "interaction-1",
  requestId: "request-1",
  kind: "permission" as const,
  requestedAt: "2026-08-29T00:00:00.000Z",
  summary: "approve",
  status: "approved" as const,
  actionable: false as const,
  nonActionableReason: "persisted_history" as const
};
const allowedBodies = [
  { kind: "lifecycle", state: "running", message: "running" },
  { kind: "output", stream: "stdout", content: "output", redaction },
  {
    kind: "message",
    role: "assistant",
    messageId: null,
    chunk: true,
    content: "message",
    redaction
  },
  { kind: "tool_call", callId: "call-1", status: "pending", title: "tool", content: null },
  { kind: "tool_update", callId: "call-1", status: "completed", content: null },
  { kind: "plan_update", content: "plan", redaction },
  { kind: "usage_update", usedTokens: 1, contextWindowTokens: 2, cost: null },
  {
    kind: "session_configuration_snapshot",
    phase: "initial",
    configuration: { modes: null, configOptions: [] }
  },
  { kind: "session_mode_update", currentModeId: "code" },
  { kind: "session_config_options_update", configOptions: [] },
  { kind: "terminal_output", terminalId: "terminal-1", content: "terminal", redaction },
  { kind: "interaction", interaction: persistedInteraction },
  {
    kind: "interaction_result",
    requestId: "request-1",
    interactionId: "interaction-1",
    interactionKind: "permission",
    outcome: "approved",
    message: "approved"
  },
  { kind: "diagnostic", code: "protocol_error", message: "diagnostic" }
] as const;

function batch(body: unknown) {
  return {
    type: "acp.events",
    eventProtocolVersion: 2,
    dispatchId: "dispatch-001",
    leaseId: "lease-001",
    executionAttemptId: "attempt-001",
    acpSessionId: "session-001",
    afterCursor: 0,
    cursor: 1,
    events: [
      {
        eventVersion: 2,
        cursor: 1,
        sourceSequence: 7,
        timestamp: "2026-08-29T00:00:00.000Z",
        fragment: { kind: "runner_body", body }
      }
    ]
  };
}

describe("remote runner event v2", () => {
  it("strictly encodes every transportable Runner body leaf", () => {
    for (const body of allowedBodies) {
      expect(remoteRunnerEventBatchV2Schema.parse(batch(body)).events[0]?.fragment).toEqual({
        kind: "runner_body",
        body
      });
    }
  });
  it("preserves strict Runner leaf identity and timing", () => {
    expect(
      remoteRunnerEventBatchV2Schema.parse(
        batch({
          kind: "message",
          role: "assistant",
          messageId: "message-1",
          chunk: true,
          content: "hello",
          redaction: { classes: [], replaced: 0 }
        })
      ).events[0]
    ).toMatchObject({ eventVersion: 2, sourceSequence: 7 });
  });

  it("rejects unknown leaves, Runtime artifacts, and unredacted secrets", () => {
    expect(runnerBodyFragmentSchema.safeParse({ kind: "message", role: "assistant" }).success).toBe(
      false
    );
    expect(runnerBodyFragmentSchema.safeParse({ kind: "artifact", artifact: {} }).success).toBe(
      false
    );
    expect(
      remoteRunnerEventBatchV2Schema.safeParse(
        batch({
          kind: "output",
          stream: "stdout",
          content: "Authorization: Bearer secret-token-value",
          redaction: { classes: [], replaced: 0 }
        })
      ).success
    ).toBe(false);
  });

  it("rejects oversized nested content and recursively redacts structured secrets", () => {
    expect(
      remoteRunnerEventBatchV2Schema.safeParse(
        batch({ kind: "output", stream: "stdout", content: "x".repeat(65_537), redaction })
      ).success
    ).toBe(false);
    expect(
      remoteRunnerEventBatchV2Schema.safeParse(
        batch({
          kind: "tool_update",
          callId: "call-1",
          rawInput: {
            content: 'nested={"credentials":{"token":"secret-token-value"}}',
            redaction
          }
        })
      ).success
    ).toBe(false);
    expect(
      redactRunnerEventPayload({ nested: { credentials: { token: "secret-token-value" } } })
    ).toEqual({ nested: { credentials: { token: "[REDACTED:CREDENTIAL]" } } });
  });
});
