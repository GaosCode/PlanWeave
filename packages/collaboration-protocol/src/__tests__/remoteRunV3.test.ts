import { describe, expect, it } from "vitest";
import {
  legacyRemoteDispatchIntentV2Schema,
  remoteDispatchIntentSchema,
  remoteDispatchIntentV3Schema,
  remoteDispatchVersionedIntentSchema,
  remoteEndpointOperationObservationSchema,
  remoteEventReplaySchema,
  remoteOperationLookupQuerySchema,
  remoteOperationObservationSchema
} from "../remoteRun.js";

const v3 = {
  schemaVersion: "remote-run/v3" as const,
  projectId: "project-a",
  canvasId: "default",
  blockRef: "T-001#B-001",
  agentEndpointId: "aep_endpoint",
  idempotencyKey: "dispatch-once",
  expectedResponsibilityRevision: 3,
  expectedReviewerRevision: 2
};

describe("remote-run/v3 dispatch contract", () => {
  it("accepts only the endpoint-scoped authority fields", () => {
    expect(remoteDispatchIntentV3Schema.parse(v3)).toEqual(v3);
    for (const forbidden of [
      { hostId: "host-a" },
      { requestedHostId: "host-a" },
      { executionTarget: { kind: "exact_host", hostId: "host-a" } },
      { expectedExecutionTargetRevision: 1 },
      { unknown: true }
    ]) {
      expect(() => remoteDispatchIntentV3Schema.parse({ ...v3, ...forbidden })).toThrow();
    }
  });

  it("accepts a canvas and block scoped operation lookup without execution inputs", () => {
    expect(
      remoteOperationLookupQuerySchema.parse({
        canvasId: "default",
        blockRef: "T-001#B-001"
      })
    ).toEqual({ canvasId: "default", blockRef: "T-001#B-001" });
  });

  it("rejects endpoint observations that mix in an internal Host ID", () => {
    const endpointObservation = {
      operationId: "operation-1",
      projectId: "project-a",
      canvasId: "default",
      blockRef: "T-001#B-001",
      state: "running" as const,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:00.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "running" as const,
        leaseId: "lease-1",
        stateVersion: 1
      },
      agentEndpoint: {
        schemaVersion: "agent-endpoint/v1" as const,
        endpointId: "endpoint-1",
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        hostDisplayName: "Build Mac",
        capabilities: ["acp.codex"],
        status: "available" as const,
        resolvedAt: "2030-01-01T00:00:00.000Z"
      },
      runtime: { ref: "T-001#B-001", status: "in_progress" }
    };
    expect(remoteEndpointOperationObservationSchema.parse(endpointObservation)).toEqual(
      endpointObservation
    );
    expect(() =>
      remoteOperationObservationSchema.parse({
        ...endpointObservation,
        attempt: { ...endpointObservation.attempt, hostId: "host-internal" }
      })
    ).toThrowError("endpoint_observation_must_redact_host_id");
  });

  it("projects a normalized terminal failure for human observation", () => {
    const failure = {
      code: "acp_authentication_required",
      message: "ACP authentication is required.",
      retryable: false
    };
    const observation = {
      operationId: "operation-1",
      projectId: "project-a",
      canvasId: "default",
      blockRef: "T-001#B-001",
      state: "failed" as const,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:00.000Z",
      terminalAt: "2030-01-01T00:01:00.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "failed" as const,
        stateVersion: 2
      },
      dispatchStatus: "failed" as const,
      failure,
      runtime: {
        ref: "T-001#B-001",
        status: "blocked",
        blockedReason: "[remote_execution_failed] Remote execution failed."
      }
    };

    expect(remoteOperationObservationSchema.parse(observation)).toEqual(observation);
  });

  it("accepts redacted ordered diagnostics and rejects internal Host material", () => {
    const diagnostics = {
      stage: "attaching_runtime" as const,
      revision: 12,
      attemptId: "attempt-1",
      locator: {
        workspaceId: "workspace-a",
        projectId: "project-a",
        canvasId: "default"
      },
      endpointId: "endpoint-1",
      hostGeneration: "hostgen:sha256:0123456789abcdef",
      authorityRevisions: { responsibility: 3, reviewer: 2 },
      content: { revision: "source-4", fingerprint: "fingerprint-4" },
      reservation: { status: "active" as const },
      attachment: { status: "preparing" as const },
      lease: { status: "active" as const, expiresAt: "2030-01-01T00:02:00.000Z" },
      startedAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:00.000Z",
      timeoutAt: "2030-01-01T00:02:00.000Z"
    };
    const observation = remoteOperationObservationSchema.parse({
      operationId: "operation-1",
      projectId: "project-a",
      canvasId: "default",
      blockRef: "T-001#B-001",
      state: "reserved",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: diagnostics.startedAt,
      updatedAt: diagnostics.updatedAt,
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "reserved",
        stateVersion: 1
      },
      diagnostics,
      runtime: { ref: "T-001#B-001", status: "in_progress" }
    });
    expect(observation.diagnostics).toEqual(diagnostics);
    for (const forbidden of [
      { hostId: "host-internal" },
      { projectRoot: "/srv/private/workspace" },
      { readiness: "TOKEN=secret" }
    ]) {
      expect(() =>
        remoteOperationObservationSchema.parse({
          ...observation,
          diagnostics: { ...diagnostics, ...forbidden }
        })
      ).toThrow();
    }
  });

  it("keeps legacy v2 strict and independently parseable for migration", () => {
    const v2 = {
      schemaVersion: "remote-run/v2" as const,
      projectId: "project-a",
      canvasId: "default",
      blockRef: "T-001#B-001",
      idempotencyKey: "legacy-dispatch",
      expectedResponsibilityRevision: 3,
      expectedReviewerRevision: 2,
      expectedExecutionTargetRevision: 4
    };
    expect(legacyRemoteDispatchIntentV2Schema.parse(v2)).toEqual(v2);
    expect(remoteDispatchIntentSchema).toBe(legacyRemoteDispatchIntentV2Schema);
    expect(remoteDispatchVersionedIntentSchema.parse(v2)).toEqual(v2);
    expect(remoteDispatchVersionedIntentSchema.parse(v3)).toEqual(v3);
    for (const forbidden of [
      { agentEndpointId: "endpoint-1" },
      { agentEndpoint: { endpointId: "endpoint-1" } }
    ]) {
      expect(() => legacyRemoteDispatchIntentV2Schema.parse({ ...v2, ...forbidden })).toThrow();
    }
    expect(() => legacyRemoteDispatchIntentV2Schema.parse(v3)).toThrow();
  });

  it("rejects replay payloads that mix v1 and v2 event contracts", () => {
    const replay = {
      executionAttemptId: "attempt-1",
      afterCursor: 0,
      cursor: 1,
      highWatermark: 1,
      hasMore: false
    };
    const v1Event = { cursor: 1, kind: "agent_message", text: "legacy" };
    const v2Event = {
      eventVersion: 2,
      cursor: 1,
      sourceSequence: 1,
      timestamp: "2030-01-01T00:00:00.000Z",
      fragment: {
        kind: "runner_body",
        body: {
          kind: "output",
          stream: "stdout",
          content: "v2",
          redaction: { classes: [], replaced: 0 }
        }
      }
    };

    expect(
      remoteEventReplaySchema.safeParse({ ...replay, eventProtocolVersion: 1, events: [v1Event] })
        .success
    ).toBe(true);
    expect(
      remoteEventReplaySchema.safeParse({ ...replay, eventProtocolVersion: 2, events: [v2Event] })
        .success
    ).toBe(true);
    expect(
      remoteEventReplaySchema.safeParse({ ...replay, eventProtocolVersion: 1, events: [v2Event] })
        .success
    ).toBe(false);
    expect(
      remoteEventReplaySchema.safeParse({ ...replay, eventProtocolVersion: 2, events: [v1Event] })
        .success
    ).toBe(false);
  });
});
