import { describe, expect, it } from "vitest";
import {
  runnerInteractionClientLabelSchema,
  runnerInteractionIdentityMatches,
  runnerInteractionResponseReceiptSchema,
  runnerInteractionSnapshotSchema,
  runnerPermissionInteractionRequestSchema,
  runnerPermissionInteractionResponseSchema
} from "../autoRun/runnerInteractionContract.js";

function requestFixture() {
  return {
    version: "planweave.runner-interaction/v1",
    kind: "permission",
    identity: {
      projectId: "project-1",
      canvasId: "default",
      claimRef: "T-001#B-001",
      executorRunId: "RUN-001",
      sessionId: "session-1",
      requestId: "permission:1",
      ownerLeaseId: "b3cbd2b7-e1ca-4e7b-b9a2-39a9b6707395",
      ownerGeneration: 1
    },
    requestedAt: "2026-07-17T04:00:00.000Z",
    summary: "Run the focused tests",
    toolCallId: "tool=/../测试?call",
    options: [
      { optionId: "allow=once/../✓", label: "Allow once", decision: "approve" },
      { optionId: "reject once?", label: "Reject", decision: "deny" }
    ]
  };
}

function responseFixture() {
  return {
    version: "planweave.runner-interaction-response/v1",
    identity: requestFixture().identity,
    decision: { kind: "select", optionId: "allow=once/../✓" },
    respondedAt: "2026-07-17T04:01:00.000Z",
    decisionSource: "scheduler-alpha",
    reason: null
  };
}

describe("runner interaction contract", () => {
  it("round-trips strict versioned permission request, response, snapshot, and receipt", () => {
    const request = runnerPermissionInteractionRequestSchema.parse(requestFixture());
    const response = runnerPermissionInteractionResponseSchema.parse(responseFixture());

    expect(request.kind).toBe("permission");
    expect(request.toolCallId).toBe("tool=/../测试?call");
    expect(response.decision).toEqual({ kind: "select", optionId: "allow=once/../✓" });
    expect(
      runnerInteractionSnapshotSchema.parse({
        version: "planweave.runner-interaction-snapshot/v1",
        interactionId: request.identity.requestId,
        status: "answered",
        request,
        response
      }).status
    ).toBe("answered");
    expect(
      runnerInteractionResponseReceiptSchema.parse({
        version: "planweave.runner-interaction-response-receipt/v1",
        identity: response.identity,
        acceptedAt: response.respondedAt,
        decision: response.decision,
        selectedOption: request.options[0],
        decisionSource: response.decisionSource
      }).selectedOption?.decision
    ).toBe("approve");
  });

  it("rejects unknown versions and fields at every persisted boundary", () => {
    expect(() =>
      runnerPermissionInteractionRequestSchema.parse({
        ...requestFixture(),
        version: "planweave.runner-interaction/v2"
      })
    ).toThrow();
    expect(() =>
      runnerPermissionInteractionRequestSchema.parse({ ...requestFixture(), rawPayload: {} })
    ).toThrow();
    expect(() =>
      runnerPermissionInteractionResponseSchema.parse({
        ...responseFixture(),
        decision: { kind: "select", optionId: "allow=once/../✓", permanent: true }
      })
    ).toThrow();
  });

  it("rejects duplicate option ids, invalid identity boundaries, and unsafe text", () => {
    expect(() =>
      runnerPermissionInteractionRequestSchema.parse({
        ...requestFixture(),
        options: [requestFixture().options[0], requestFixture().options[0]]
      })
    ).toThrow(/must be unique/);
    expect(() =>
      runnerPermissionInteractionRequestSchema.parse({
        ...requestFixture(),
        identity: { ...requestFixture().identity, ownerLeaseId: "not-a-uuid" }
      })
    ).toThrow();
    expect(() =>
      runnerPermissionInteractionRequestSchema.parse({
        ...requestFixture(),
        summary: "authorization: Bearer secret-token-value"
      })
    ).toThrow(/unredacted credential/);
    expect(() =>
      runnerPermissionInteractionRequestSchema.parse({
        ...requestFixture(),
        options: [{ optionId: "allow=once/../✓", label: "x".repeat(1_025), decision: "approve" }]
      })
    ).toThrow(/1024-byte/);
    expect(() =>
      runnerPermissionInteractionRequestSchema.parse({ ...requestFixture(), toolCallId: "" })
    ).toThrow();
    expect(() =>
      runnerPermissionInteractionRequestSchema.parse({
        ...requestFixture(),
        options: [{ optionId: "x".repeat(1_025), label: "Allow", decision: "approve" }]
      })
    ).toThrow(/1024-byte/);
  });

  it("requires a cancellation reason and accepts arbitrary valid client labels", () => {
    expect(runnerInteractionClientLabelSchema.parse("scheduler-alpha")).toBe("scheduler-alpha");
    expect(runnerInteractionClientLabelSchema.parse("custom.client:7")).toBe("custom.client:7");
    expect(() => runnerInteractionClientLabelSchema.parse("display name with spaces")).toThrow();
    expect(() =>
      runnerPermissionInteractionResponseSchema.parse({
        ...responseFixture(),
        decision: { kind: "cancel" },
        reason: null
      })
    ).toThrow(/requires a reason/);
  });

  it("compares every identity field exactly", () => {
    const identity = runnerPermissionInteractionRequestSchema.parse(requestFixture()).identity;
    expect(runnerInteractionIdentityMatches(identity, identity)).toBe(true);

    for (const [field, replacement] of [
      ["projectId", "project-2"],
      ["canvasId", "other"],
      ["claimRef", "T-002#B-001"],
      ["executorRunId", "RUN-002"],
      ["sessionId", "session-2"],
      ["requestId", "permission:2"],
      ["ownerLeaseId", "93d88493-a3ed-4b76-86e5-4dd1efee2948"],
      ["ownerGeneration", 2]
    ] as const) {
      expect(
        runnerInteractionIdentityMatches(identity, { ...identity, [field]: replacement })
      ).toBe(false);
    }
  });
});
