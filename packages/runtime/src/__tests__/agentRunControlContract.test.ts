// biome-ignore lint/style/noExcessiveLinesPerFile: One suite keeps the versioned control contract reviewable as a whole.
import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_CONTROL_MAX_FOLLOW_UP_BYTES,
  AGENT_RUN_CONTROL_MAX_FRAME_BYTES,
  AGENT_RUN_CONTROL_MAX_UNIX_ADDRESS_BYTES,
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlCancelCommandSchema,
  agentRunControlCommandSchema,
  agentRunControlEndpointDescriptorSchema,
  agentRunControlErrorCodeSchema,
  agentRunControlErrorResponseSchema,
  agentRunControlFollowUpCommandSchema,
  agentRunControlRespondCommandSchema,
  agentRunControlResponseSchema,
  agentRunControlSuccessReceiptSchema
} from "../autoRun/agentRunControlContract.js";
import {
  runnerRequestActionIdentitySchema,
  runnerSessionActionIdentitySchema
} from "../autoRun/runnerContractSchemas.js";
import {
  desktopAgentActionIdentitySchema,
  desktopAgentSessionActionIdentitySchema
} from "../desktop/types/acpBridgeTypes.js";

const commandId = "4f0fda0a-90d9-4f28-9b55-7d31839fc102";
const leaseId = "f32905ce-87f8-4653-8814-6324f5a11f7d";
const publishedAt = "2026-07-17T06:00:00.000Z";

function sessionIdentityFixture() {
  return {
    scope: "/workspace/planweave",
    executorRunId: "executor-run-1",
    desktopRunId: "desktop-run-1",
    runSessionId: "run-session-1",
    claimRef: "T-001#B-001",
    sessionId: "acp-session-1"
  };
}

function requestIdentityFixture() {
  return {
    ...sessionIdentityFixture(),
    requestId: "acp-request-1"
  };
}

function commandEnvelope() {
  return {
    version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    commandId,
    leaseId
  };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Contract cases share exact identity and envelope fixtures.
describe("agent run control contract", () => {
  it("reuses the canonical action identities for every command", () => {
    expect(agentRunControlCancelCommandSchema.shape.identity).toBe(
      runnerSessionActionIdentitySchema
    );
    expect(agentRunControlFollowUpCommandSchema.shape.identity).toBe(
      runnerSessionActionIdentitySchema
    );
    expect(agentRunControlRespondCommandSchema.shape.identity).toBe(
      runnerRequestActionIdentitySchema
    );

    expect(
      agentRunControlCommandSchema.parse({
        ...commandEnvelope(),
        kind: "cancel",
        identity: sessionIdentityFixture()
      }).kind
    ).toBe("cancel");
    expect(
      agentRunControlCommandSchema.parse({
        ...commandEnvelope(),
        kind: "follow_up",
        identity: sessionIdentityFixture(),
        prompt: "Please verify the focused tests."
      }).kind
    ).toBe("follow_up");
    expect(
      agentRunControlCommandSchema.parse({
        ...commandEnvelope(),
        kind: "respond",
        identity: requestIdentityFixture(),
        outcome: "allow-once"
      }).kind
    ).toBe("respond");
  });

  it("accepts bounded Unix and Windows endpoint descriptors", () => {
    expect(
      agentRunControlEndpointDescriptorSchema.parse({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        transport: "unix",
        address: "/tmp/pw-control.sock",
        leaseId,
        ownerPid: 4242,
        publishedAt
      }).transport
    ).toBe("unix");
    expect(
      agentRunControlEndpointDescriptorSchema.parse({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        transport: "named_pipe",
        address: "\\\\.\\pipe\\planweave-control-4f0fda0a",
        leaseId,
        ownerPid: 4242,
        publishedAt
      }).transport
    ).toBe("named_pipe");
  });

  it("rejects unknown fields, wrong versions, non-v4 identifiers, and transport mismatches", () => {
    const endpoint = {
      version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
      transport: "unix",
      address: "/tmp/pw-control.sock",
      leaseId,
      ownerPid: 4242,
      publishedAt
    };

    expect(
      agentRunControlEndpointDescriptorSchema.safeParse({ ...endpoint, token: "secret" }).success
    ).toBe(false);
    expect(
      agentRunControlEndpointDescriptorSchema.safeParse({
        ...endpoint,
        version: "planweave.agent-run-control/v2"
      }).success
    ).toBe(false);
    expect(
      agentRunControlEndpointDescriptorSchema.safeParse({
        ...endpoint,
        leaseId: "00000000-0000-0000-0000-000000000000"
      }).success
    ).toBe(false);
    expect(
      agentRunControlEndpointDescriptorSchema.safeParse({
        ...endpoint,
        transport: "named_pipe"
      }).success
    ).toBe(false);
    expect(
      agentRunControlCommandSchema.safeParse({
        ...commandEnvelope(),
        version: "planweave.agent-run-control/v2",
        kind: "cancel",
        identity: sessionIdentityFixture()
      }).success
    ).toBe(false);
  });

  it("rejects persistence identities and all identity widening", () => {
    const persistedMailboxIdentity = {
      projectId: "project-1",
      canvasId: "default",
      claimRef: "T-001#B-001",
      executorRunId: "executor-run-1",
      sessionId: "acp-session-1",
      requestId: "acp-request-1",
      ownerLeaseId: leaseId,
      ownerGeneration: 1
    };

    expect(
      agentRunControlCommandSchema.safeParse({
        ...commandEnvelope(),
        kind: "respond",
        identity: persistedMailboxIdentity,
        outcome: "allow-once"
      }).success
    ).toBe(false);
    expect(
      agentRunControlCommandSchema.safeParse({
        ...commandEnvelope(),
        kind: "cancel",
        identity: { ...sessionIdentityFixture(), ownerLeaseId: leaseId }
      }).success
    ).toBe(false);
    expect(
      agentRunControlCommandSchema.safeParse({
        ...commandEnvelope(),
        kind: "respond",
        identity: { ...requestIdentityFixture(), requestId: undefined },
        outcome: "allow-once"
      }).success
    ).toBe(false);
  });

  it("bounds addresses, follow-up prompts, and complete command frames", () => {
    expect(
      agentRunControlEndpointDescriptorSchema.safeParse({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        transport: "unix",
        address: `/${"a".repeat(AGENT_RUN_CONTROL_MAX_UNIX_ADDRESS_BYTES)}`,
        leaseId,
        ownerPid: 4242,
        publishedAt
      }).success
    ).toBe(false);
    expect(
      agentRunControlCommandSchema.safeParse({
        ...commandEnvelope(),
        kind: "follow_up",
        identity: sessionIdentityFixture(),
        prompt: "   "
      }).success
    ).toBe(false);
    expect(
      agentRunControlCommandSchema.safeParse({
        ...commandEnvelope(),
        kind: "follow_up",
        identity: sessionIdentityFixture(),
        prompt: "a".repeat(AGENT_RUN_CONTROL_MAX_FOLLOW_UP_BYTES + 1)
      }).success
    ).toBe(false);
    expect(
      agentRunControlCommandSchema.safeParse({
        ...commandEnvelope(),
        kind: "respond",
        identity: requestIdentityFixture(),
        outcome: {
          action: "accept",
          content: { oversized: "a".repeat(AGENT_RUN_CONTROL_MAX_FRAME_BYTES) }
        }
      }).success
    ).toBe(false);
  });

  it("accepts only supported permission and elicitation outcomes", () => {
    const outcomes = [
      "allow-once",
      { action: "accept", content: { answer: "yes" } },
      { action: "decline" },
      { action: "cancel" }
    ];
    for (const outcome of outcomes) {
      expect(
        agentRunControlRespondCommandSchema.safeParse({
          ...commandEnvelope(),
          kind: "respond",
          identity: requestIdentityFixture(),
          outcome
        }).success
      ).toBe(true);
    }

    for (const outcome of [
      { outcome: "approved" },
      { outcome: "selected" },
      { outcome: "cancelled", optionId: "unexpected" },
      { action: "accept" },
      { action: "decline", content: {} },
      { action: "approve" }
    ]) {
      expect(
        agentRunControlRespondCommandSchema.safeParse({
          ...commandEnvelope(),
          kind: "respond",
          identity: requestIdentityFixture(),
          outcome
        }).success
      ).toBe(false);
    }
  });

  it("distinguishes accepted from delivered and represents delivery failure as an error", () => {
    const receipt = {
      version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
      ok: true,
      commandId,
      acceptedAt: "2026-07-17T06:01:00.000Z",
      ownerPid: 4242,
      leaseId
    };

    expect(
      agentRunControlSuccessReceiptSchema.parse({
        ...receipt,
        result: { status: "accepted" }
      }).result.status
    ).toBe("accepted");
    expect(
      agentRunControlSuccessReceiptSchema.parse({
        ...receipt,
        result: { status: "delivered", deliveredAt: "2026-07-17T06:01:01.000Z" }
      }).result.status
    ).toBe("delivered");
    expect(
      agentRunControlSuccessReceiptSchema.safeParse({
        ...receipt,
        result: { status: "delivered", deliveredAt: "2026-07-17T06:00:59.000Z" }
      }).success
    ).toBe(false);
    expect(
      agentRunControlSuccessReceiptSchema.safeParse({
        ...receipt,
        result: { status: "accepted", deliveredAt: "2026-07-17T06:01:01.000Z" }
      }).success
    ).toBe(false);
    expect(
      agentRunControlResponseSchema.parse({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        ok: false,
        commandId,
        code: "delivery_failed",
        message: "The live ACP connection rejected the prompt."
      }).ok
    ).toBe(false);
  });

  it("exposes only the planned typed errors through a strict response", () => {
    expect(agentRunControlErrorCodeSchema.options).toEqual([
      "invalid_identity",
      "stale_lease",
      "not_owner",
      "not_active",
      "request_not_pending",
      "capability_denied",
      "delivery_failed",
      "protocol_mismatch"
    ]);
    expect(
      agentRunControlErrorResponseSchema.safeParse({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        ok: false,
        commandId: null,
        code: "protocol_mismatch",
        message: "Unsupported protocol version.",
        retryable: false
      }).success
    ).toBe(false);
    expect(
      agentRunControlErrorResponseSchema.safeParse({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        ok: false,
        commandId,
        code: "duplicate",
        message: "Duplicate command."
      }).success
    ).toBe(false);
  });

  it("does not expose endpoint state or owner takeover fields through desktop action DTOs", () => {
    const transportFields = {
      leaseId,
      address: "/tmp/pw-control.sock",
      ownerPid: 4242,
      takeover: true
    };

    expect(
      desktopAgentSessionActionIdentitySchema.safeParse({
        ...sessionIdentityFixture(),
        ...transportFields
      }).success
    ).toBe(false);
    expect(
      desktopAgentActionIdentitySchema.safeParse({
        ...requestIdentityFixture(),
        ...transportFields
      }).success
    ).toBe(false);
    expect(
      agentRunControlCommandSchema.safeParse({
        ...commandEnvelope(),
        kind: "cancel",
        identity: sessionIdentityFixture(),
        previousLeaseId: "126ea75d-84cf-447a-9208-9af52350f746",
        ownerGeneration: 2,
        takeover: true
      }).success
    ).toBe(false);
  });
});
