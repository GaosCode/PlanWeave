import { describe, expect, it } from "vitest";
import { OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE } from "@planweave-ai/collaboration-protocol/remote-run";
import {
  createOperatorRemoteOperationsPort,
  operatorObservationToRemoteRun
} from "../main/operatorControl/operatorRemoteOperations.js";

describe("operatorRemoteOperations", () => {
  it("maps operator operation view to remote-run observation", () => {
    const observation = operatorObservationToRemoteRun({
      operationId: "operation-1",
      projectId: "project-a",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      state: "running",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:01.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "running",
        stateVersion: 1
      },
      runtime: {
        ref: "T-001#B-001",
        status: "in_progress",
        ownership: {
          phase: "active",
          operationId: "operation-1",
          sourceRevision: "source-revision-1",
          graphFingerprint: "graph-fingerprint-1",
          dispatchId: "dispatch-1",
          executionAttemptId: "attempt-1"
        }
      },
      agentEndpoint: {
        schemaVersion: "agent-endpoint/v1",
        endpointId: "aep_test",
        agentId: "codex",
        profileId: "codex-acp",
        displayName: "Codex",
        hostDisplayName: "Fleet Host",
        status: "available",
        capabilities: ["acp.codex"],
        resolvedAt: "2026-08-03T08:00:00.000Z"
      }
    });
    expect(observation.operationId).toBe("operation-1");
    expect(observation.agentEndpoint?.endpointId).toBe("aep_test");
    expect(observation.runtime.ownership).toEqual({
      operationId: "operation-1",
      phase: "active",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1"
    });
    expect(JSON.stringify(observation.runtime)).not.toMatch(/sourceRevision|graphFingerprint/);
  });

  it("preserves the public terminal Runtime projection", () => {
    const observation = operatorObservationToRemoteRun({
      operationId: "operation-2",
      projectId: "project-a",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      state: "completed",
      dispatchId: "dispatch-2",
      executionAttemptId: "attempt-2",
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:01.000Z",
      terminalAt: "2026-08-03T08:00:01.000Z",
      attempt: {
        executionAttemptId: "attempt-2",
        dispatchId: "dispatch-2",
        status: "completed",
        stateVersion: 2
      },
      runtime: {
        ref: "T-001#B-001",
        status: "completed",
        terminalReceipt: {
          outcome: "completed",
          operationId: "operation-2",
          summary: "Completed remotely."
        }
      }
    });

    expect(observation.runtime.terminalReceipt).toEqual({
      operationId: "operation-2",
      outcome: "completed",
      summary: "Completed remotely."
    });
  });

  it("accepts a persisted cancelled terminal projection without a live Runtime", () => {
    const observation = operatorObservationToRemoteRun({
      operationId: "operation-3",
      projectId: "project-a",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      state: "cancelled",
      dispatchId: "dispatch-3",
      executionAttemptId: "attempt-3",
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:01.000Z",
      terminalAt: "2026-08-03T08:00:01.000Z",
      attempt: {
        executionAttemptId: "attempt-3",
        dispatchId: "dispatch-3",
        status: "cancelled",
        stateVersion: 1
      },
      runtime: {
        ref: "T-001#B-001",
        status: "cancelled",
        terminalReceipt: { operationId: "operation-3", outcome: "cancelled" }
      }
    });

    expect(observation.runtime).toEqual({
      ref: "T-001#B-001",
      status: "cancelled",
      terminalReceipt: { operationId: "operation-3", outcome: "cancelled" }
    });
  });

  it("requests the public Runtime wire for operation dispatch and observation", async () => {
    const calls: Array<{ method: string; path: string; accept?: string }> = [];
    const response = {
      operationId: "operation-4",
      projectId: "project-a",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      state: "cancelled",
      dispatchId: "dispatch-4",
      executionAttemptId: "attempt-4",
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:01.000Z",
      terminalAt: "2026-08-03T08:00:01.000Z",
      attempt: {
        executionAttemptId: "attempt-4",
        dispatchId: "dispatch-4",
        status: "cancelled",
        stateVersion: 1
      },
      runtime: {
        ref: "T-001#B-001",
        status: "cancelled",
        terminalReceipt: { operationId: "operation-4", outcome: "cancelled" }
      }
    };
    const port = createOperatorRemoteOperationsPort({
      async json(_method, _path, _schema, options) {
        calls.push({ method: _method, path: _path, accept: options?.accept });
        return _schema.parse(response);
      }
    });

    await port.dispatchRemoteOperation({
      schemaVersion: "remote-run/v3",
      projectId: "project-a",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-1",
      idempotencyKey: "dispatch-once",
      expectedResponsibilityRevision: 1,
      expectedReviewerRevision: 1,
      executionTargetRevision: 1,
      contentRevision: "1",
      graphFingerprint: `pkg-${"a".repeat(64)}`
    });
    await port.observeRemoteOperation("operation-4");

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/remote-operations",
        accept: OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE
      },
      {
        method: "GET",
        path: "/api/v1/remote-operations/operation-4",
        accept: OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE
      }
    ]);
  });
});
