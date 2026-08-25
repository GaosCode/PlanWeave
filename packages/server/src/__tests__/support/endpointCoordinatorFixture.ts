import type { AgentEndpointCatalog } from "../../agentEndpointCatalog.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import type { RemoteEndpointDispatchRequest } from "../../remoteBlockCoordinator.js";
import type { RemoteRuntimeLocator } from "../../remoteBlockCoordinatorPorts.js";
import type { SqliteDatabase } from "../../sqlite.js";
import { TEST_REMOTE_AGENT_OWNER_ID } from "./remoteAgentOwnerFixture.js";

export function registerEndpointDispatchAccess(input: {
  database: SqliteDatabase;
  locator: RemoteRuntimeLocator;
  projectRoot: string;
  packageDir: string;
}): void {
  const access = new ProjectAccessRepository(input.database);
  access.registerProjectInternal({
    workspaceId: input.locator.workspaceId,
    projectId: input.locator.projectId,
    projectRoot: input.projectRoot
  });
  access.registerCanvasInternal({
    workspaceId: input.locator.workspaceId,
    projectId: input.locator.projectId,
    canvasId: input.locator.canvasId,
    packageDir: input.packageDir
  });
}

export function endpointDispatchRequest(input: {
  agentEndpoints: AgentEndpointCatalog;
  locator: RemoteRuntimeLocator;
  blockRef: string;
  idempotencyKey: string;
  agentEndpointId?: string;
  expectedResponsibilityRevision?: number;
  expectedReviewerRevision?: number;
  callerHumanPrincipalId?: string;
  controlPlane?: "collaboration" | "owner";
}): RemoteEndpointDispatchRequest {
  const endpointId =
    input.agentEndpointId ??
    input.agentEndpoints
      .listVisible(input.locator.workspaceId)
      .items.find((item) => item.status === "available")?.endpointId ??
    input.agentEndpoints.listVisibleFleet().items.find((item) => item.status === "available")
      ?.endpointId;
  if (!endpointId) throw new Error("expected_available_test_endpoint");
  return {
    ...input.locator,
    blockRef: input.blockRef,
    idempotencyKey: input.idempotencyKey,
    agentEndpointId: endpointId,
    expectedResponsibilityRevision: input.expectedResponsibilityRevision ?? 0,
    expectedReviewerRevision: input.expectedReviewerRevision ?? 0,
    controlPlane: input.controlPlane ?? "collaboration",
    callerHumanPrincipalId: input.callerHumanPrincipalId ?? TEST_REMOTE_AGENT_OWNER_ID
  };
}
