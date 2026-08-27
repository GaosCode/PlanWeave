import { WORKSPACE_CANVAS_EXECUTION_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import {
  remoteBlockDispatchCandidateSchema,
  type RemoteBlockDispatchCandidate
} from "@planweave-ai/runtime";
import { endpointIdFor, type AgentEndpointCatalog } from "../../agentEndpointCatalog.js";
import { runtimeAuthoritySnapshotForTarget } from "../../endpointSelection.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import type { RemoteEndpointDispatchRequest } from "../../remoteBlockCoordinator.js";
import { snapshotDispatchEndpoint } from "../../remoteBlockCoordinatorEndpoint.js";
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
  targetKind?: "owner_canvas" | "workspace_canvas";
}): RemoteEndpointDispatchRequest {
  const targetKind = input.targetKind ?? "workspace_canvas";
  const listed =
    targetKind === "owner_canvas"
      ? input.agentEndpoints.listVisibleFleet()
      : input.agentEndpoints.listVisible(input.locator.workspaceId);
  const endpointId =
    input.agentEndpointId ??
    listed.items.find((item) => item.status === "available")?.endpointId ??
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
    targetKind,
    callerHumanPrincipalId: input.callerHumanPrincipalId ?? TEST_REMOTE_AGENT_OWNER_ID
  };
}

export function workspaceExecutionCandidate(
  candidate: RemoteBlockDispatchCandidate
): RemoteBlockDispatchCandidate {
  return remoteBlockDispatchCandidateSchema.parse({
    ...candidate,
    requiredCapabilities: [...candidate.requiredCapabilities, WORKSPACE_CANVAS_EXECUTION_CAPABILITY]
  });
}

export function workspaceEndpointSelection(input: {
  agentEndpoints: AgentEndpointCatalog;
  candidate: RemoteBlockDispatchCandidate;
  hostId: string;
  workspaceId: string;
}) {
  return snapshotDispatchEndpoint(
    input.agentEndpoints.resolveForRun(
      endpointIdFor({ hostId: input.hostId, profileId: "codex-acp", agentId: "codex" }),
      input.workspaceId,
      input.candidate.requiredCapabilities,
      { kind: "workspace" }
    ),
    input.candidate,
    runtimeAuthoritySnapshotForTarget(
      { kind: "workspace_canvas", workspaceId: input.workspaceId },
      { responsibilityRevision: 0, reviewerRevision: 0 }
    )
  );
}
