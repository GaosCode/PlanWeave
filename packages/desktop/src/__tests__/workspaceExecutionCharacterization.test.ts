import { remoteOperationObservationSchema } from "@planweave-ai/collaboration-protocol/remote-run";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationRemoteOperationsPort } from "../main/collaboration/CollaborationRemoteOperationsClient.js";
import { CollaborationRemoteOperationsFacade } from "../main/collaboration/collaborationRemoteOperations.js";

const observation = remoteOperationObservationSchema.parse({
  operationId: "operation-characterization",
  projectId: "foreign-project",
  canvasId: "foreign-canvas",
  blockRef: "T-foreign#B-foreign",
  state: "running",
  dispatchId: "dispatch-characterization",
  executionAttemptId: "attempt-characterization",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:01:00.000Z",
  attempt: {
    executionAttemptId: "attempt-characterization",
    dispatchId: "dispatch-characterization",
    status: "running",
    leaseId: "lease-characterization",
    stateVersion: 1
  },
  runtime: { ref: "T-foreign#B-foreign", status: "in_progress" }
});

function fixture() {
  const listAgentEndpoints = vi.fn(async () => ({
    schemaVersion: "agent-endpoint-list/v1" as const,
    items: []
  }));
  const dispatchRemoteOperation = vi.fn(async () => observation);
  const lookupRemoteOperation = vi.fn(async () => observation);
  const unused = async (): Promise<never> => {
    throw new Error("unused_remote_operation_port_method");
  };
  const client: CollaborationRemoteOperationsPort = {
    listAgentEndpoints,
    dispatchRemoteOperation,
    observeRemoteOperation: unused,
    lookupRemoteOperation,
    executeRemoteOperationAction: unused,
    replayRemoteOperationEvents: unused,
    listRemoteOperationInteractions: unused,
    settleRemoteOperationInteraction: unused
  };
  const activeClientCalls = vi.fn();
  const workspaceClientCalls = vi.fn();
  const facade = new CollaborationRemoteOperationsFacade(
    async (operation) => {
      activeClientCalls();
      return operation(client);
    },
    async (_locator, operation) => {
      workspaceClientCalls();
      return operation(client);
    }
  );
  return {
    facade,
    listAgentEndpoints,
    dispatchRemoteOperation,
    lookupRemoteOperation,
    activeClientCalls,
    workspaceClientCalls
  };
}

describe("workspace execution authority characterization", () => {
  it("routes Catalog and Dispatch through the active client without a validated Workspace binding", async () => {
    const current = fixture();

    await current.facade.listAgentEndpoints({
      projectId: "selected-project",
      workspaceId: "selected-workspace",
      canvasId: "selected-canvas"
    });
    await current.facade.dispatch({
      schemaVersion: "remote-run/v3",
      projectId: "selected-project",
      canvasId: "selected-canvas",
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-characterization",
      idempotencyKey: "dispatch-characterization",
      expectedResponsibilityRevision: 1,
      expectedReviewerRevision: 1
    });

    expect(current.activeClientCalls).toHaveBeenCalledTimes(2);
    expect(current.listAgentEndpoints).toHaveBeenCalledTimes(1);
    expect(current.dispatchRemoteOperation).toHaveBeenCalledTimes(1);
    expect(current.workspaceClientCalls).not.toHaveBeenCalled();
  });

  it("detects a Workspace operation authority mismatch only after the lookup call returns", async () => {
    const current = fixture();

    await expect(
      current.facade.lookupWorkspace({
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-selected",
          workspaceId: "workspace-selected",
          projectId: "project-selected",
          canvasId: "canvas-selected"
        },
        blockRef: "T-001#B-001"
      })
    ).rejects.toThrow("workspace_remote_operation_authority_mismatch");

    expect(current.workspaceClientCalls).toHaveBeenCalledTimes(1);
    expect(current.lookupRemoteOperation).toHaveBeenCalledTimes(1);
  });
});
