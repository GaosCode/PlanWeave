import { describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import {
  CollaborationRemoteOperationsClient,
  type CollaborationRemoteOperationsPort,
  type CollaborationRemoteOperationsTransportPort
} from "../main/collaboration/CollaborationRemoteOperationsClient.js";
import type { JsonMethod } from "../main/collaboration/collaborationHttpTransport.js";
import { CollaborationRemoteOperationsFacade } from "../main/collaboration/collaborationRemoteOperations.js";
import { remoteOperationObservationSchema } from "@planweave-ai/collaboration-protocol/remote-run";

const endpoint = {
  schemaVersion: "agent-endpoint/v1",
  endpointId: "endpoint-vps",
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Codex",
  hostDisplayName: "Build Mac",
  capabilities: ["acp.codex"],
  status: "available"
} as const;

function observation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "operation-v3",
    projectId: "project-demo-001",
    canvasId: "default",
    blockRef: "T-1#B-1",
    state: "running",
    dispatchId: "dispatch-v3",
    executionAttemptId: "attempt-v3",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:01:00.000Z",
    attempt: {
      executionAttemptId: "attempt-v3",
      dispatchId: "dispatch-v3",
      status: "running",
      leaseId: "lease-v3",
      stateVersion: 1
    },
    runtime: { ref: "T-1#B-1", status: "in_progress" },
    ...overrides
  };
}

function fixture(response: unknown) {
  const json = vi.fn(
    async <T>(
      _method: JsonMethod,
      _path: string,
      schema: ZodType<T>,
      _options: { body?: unknown; signal?: AbortSignal }
    ): Promise<T> => schema.parse(response)
  );
  const transport: CollaborationRemoteOperationsTransportPort = { json };
  return { client: new CollaborationRemoteOperationsClient("project-demo-001", transport), json };
}

function remoteOperationsPort(response: unknown): CollaborationRemoteOperationsPort {
  const parsed = remoteOperationObservationSchema.parse(response);
  const unused = async (): Promise<never> => {
    throw new Error("unused_remote_operation_port_method");
  };
  return {
    listAgentEndpoints: unused,
    dispatchRemoteOperation: unused,
    observeRemoteOperation: vi.fn(async () => parsed),
    lookupRemoteOperation: vi.fn(async () => parsed),
    executeRemoteOperationAction: unused,
    replayRemoteOperationEvents: unused,
    listRemoteOperationInteractions: unused,
    settleRemoteOperationInteraction: unused
  };
}

const v3Command = {
  schemaVersion: "remote-run/v3" as const,
  projectId: "project-demo-001",
  canvasId: "default",
  blockRef: "T-1#B-1",
  agentEndpointId: "endpoint-vps",
  idempotencyKey: "endpoint-dispatch-1",
  expectedResponsibilityRevision: 2,
  expectedReviewerRevision: 3,
  executionTargetRevision: 4,
  contentRevision: "7",
  graphFingerprint: `pkg-${"a".repeat(64)}`
};

describe("CollaborationRemoteOperationsClient", () => {
  it("parses endpoint catalogs and an exact v3 observation", async () => {
    const catalogFixture = fixture({
      schemaVersion: "agent-endpoint-list/v1",
      items: [endpoint]
    });
    await expect(catalogFixture.client.listAgentEndpoints()).resolves.toEqual({
      schemaVersion: "agent-endpoint-list/v1",
      items: [endpoint]
    });
    expect(catalogFixture.json).toHaveBeenCalledWith(
      "GET",
      "/api/v1/projects/project-demo-001/agent-endpoints",
      expect.anything(),
      { signal: undefined }
    );
    await expect(
      catalogFixture.client.listAgentEndpoints({
        projectId: "project-demo-001",
        canvasId: "canvas-main",
        workspaceId: "workspace-1",
        humanPrincipalId: "human-owner-1"
      })
    ).resolves.toEqual({
      schemaVersion: "agent-endpoint-list/v1",
      items: [endpoint]
    });
    expect(catalogFixture.json).toHaveBeenCalledWith(
      "GET",
      "/api/v1/projects/project-demo-001/agent-endpoints?canvasId=canvas-main&workspaceId=workspace-1&humanPrincipalId=human-owner-1",
      expect.anything(),
      { signal: undefined }
    );
    expect(
      () => void catalogFixture.client.listAgentEndpoints({ projectId: "other-project" })
    ).toThrow("collaboration_project_scope_mismatch");

    const dispatchFixture = fixture(
      observation({ agentEndpoint: { ...endpoint, resolvedAt: "2030-01-01T00:00:00.000Z" } })
    );
    await expect(dispatchFixture.client.dispatchRemoteOperation(v3Command)).resolves.toMatchObject({
      operationId: "operation-v3",
      agentEndpoint: { endpointId: "endpoint-vps" }
    });
    expect(dispatchFixture.json).toHaveBeenCalledWith(
      "POST",
      "/api/v1/projects/project-demo-001/remote-operations",
      expect.anything(),
      { body: v3Command, signal: undefined }
    );
  });

  it("rejects a v3 response without agentEndpoint", async () => {
    const { client } = fixture(observation());
    await expect(client.dispatchRemoteOperation(v3Command)).rejects.toThrow();
  });

  it("looks up the latest block operation and permits an explicit null result", async () => {
    const present = fixture(observation());
    await expect(
      present.client.lookupRemoteOperation({ canvasId: "default", blockRef: "T-1#B-1" })
    ).resolves.toMatchObject({ operationId: "operation-v3" });
    expect(present.json).toHaveBeenCalledWith(
      "GET",
      "/api/v1/projects/project-demo-001/remote-operations?canvasId=default&blockRef=T-1%23B-1",
      expect.anything(),
      { signal: undefined }
    );

    const absent = fixture(null);
    await expect(
      absent.client.lookupRemoteOperation({ canvasId: "default", blockRef: "T-1#B-1" })
    ).resolves.toBeNull();

    const exact = fixture(observation({ operationId: "operation-exact" }));
    await exact.client.lookupRemoteOperation({
      canvasId: "default",
      blockRef: "T-1#B-1",
      operationId: "operation-exact"
    });
    expect(exact.json).toHaveBeenCalledWith(
      "GET",
      "/api/v1/projects/project-demo-001/remote-operations?canvasId=default&blockRef=T-1%23B-1&operationId=operation-exact",
      expect.anything(),
      { signal: undefined }
    );
  });

  it("rejects a v3 response that leaks attempt.hostId", async () => {
    const leaked = observation({
      attempt: { ...observation().attempt, hostId: "host-internal" },
      agentEndpoint: { ...endpoint, resolvedAt: "2030-01-01T00:00:00.000Z" }
    });
    const { client } = fixture(leaked);
    await expect(client.dispatchRemoteOperation(v3Command)).rejects.toThrow(
      "endpoint_observation_must_redact_host_id"
    );
  });

  it("reads Workspace history from the route profile instead of the active profile", async () => {
    const activePort = remoteOperationsPort(
      observation({ operationId: "operation-active", projectId: "project-active" })
    );
    const workspacePort = remoteOperationsPort(
      observation({ operationId: "operation-workspace", projectId: "project-workspace" })
    );
    const routedProfiles: string[] = [];
    const facade = new CollaborationRemoteOperationsFacade(
      (operation) => operation(activePort),
      (locator, operation) => {
        routedProfiles.push(locator.connectionProfileId);
        return operation(workspacePort);
      }
    );
    const locator = {
      kind: "workspace" as const,
      connectionProfileId: "profile-workspace",
      workspaceId: "workspace-1",
      projectId: "project-workspace",
      canvasId: "default"
    };

    await expect(
      facade.lookupWorkspace({
        locator,
        blockRef: "T-1#B-1",
        operationId: "operation-workspace"
      })
    ).resolves.toMatchObject({ operationId: "operation-workspace" });
    expect(routedProfiles).toEqual(["profile-workspace"]);
    expect(workspacePort.lookupRemoteOperation).toHaveBeenCalledWith({
      canvasId: "default",
      blockRef: "T-1#B-1",
      operationId: "operation-workspace"
    });
    expect(activePort.lookupRemoteOperation).not.toHaveBeenCalled();
  });

  it("rejects a Workspace operation returned outside the routed canvas scope", async () => {
    const mismatched = remoteOperationsPort(observation({ canvasId: "foreign-canvas" }));
    const facade = new CollaborationRemoteOperationsFacade(
      (operation) => operation(mismatched),
      (_locator, operation) => operation(mismatched)
    );

    await expect(
      facade.lookupWorkspace({
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-workspace",
          workspaceId: "workspace-1",
          projectId: "project-demo-001",
          canvasId: "default"
        },
        blockRef: "T-1#B-1"
      })
    ).rejects.toThrow("workspace_remote_operation_authority_mismatch");
  });

  it("rejects legacy dispatch commands before transport", async () => {
    const { client, json } = fixture(observation());
    expect(() =>
      client.dispatchRemoteOperation({
        schemaVersion: "remote-run/v2",
        projectId: "project-demo-001",
        canvasId: "default",
        blockRef: "T-1#B-1",
        idempotencyKey: "legacy-v2",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        expectedExecutionTargetRevision: 0
      } as never)
    ).toThrow();
    expect(json).not.toHaveBeenCalled();
  });
});
