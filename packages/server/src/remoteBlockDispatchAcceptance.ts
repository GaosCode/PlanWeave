import {
  CANVAS_RUNTIME_EXECUTION_CAPABILITY,
  userRequiredCapabilitiesSchema
} from "@planweave-ai/agent-host-protocol";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  remoteBlockDispatchCandidateSchema,
  type RemoteBlockDispatchCandidate
} from "@planweave-ai/runtime";
import type { AgentEndpointCatalog } from "./agentEndpointCatalog.js";
import { runtimeAuthoritySnapshotForTarget } from "./endpointSelection.js";
import type { HumanPrincipalIdentity } from "./identity/humanPrincipalIdentity.js";
import type { AuthorizeRemoteAgentUseInput } from "./remoteAgent/accessPolicy.js";
import { dispatchTarget } from "./remoteAgent/dispatchTarget.js";
import { RemoteAgentAuthorizationError } from "./remoteAgent/errors.js";
import {
  persistedRemoteAgentAccessSnapshotSchema,
  type AuthorizedRemoteAgentUse
} from "./remoteAgent/schema.js";
import type {
  RemoteCoordinatorCheckpoint,
  RemoteContentAuthorizePort,
  RemoteDispatchCandidateReaderPort,
  RemoteOperationCandidatePort,
  RemoteRuntimeLocator
} from "./remoteBlockCoordinatorPorts.js";
import {
  canonicalizeDispatchCaller,
  parseDispatchCaller,
  sameDispatchCaller
} from "./remoteBlockDispatchIdentity.js";
import { snapshotDispatchEndpoint } from "./remoteBlockCoordinatorEndpoint.js";
import type { RemoteOperation, RemoteOperationRepository } from "./remoteOperations.js";

export type RemoteEndpointDispatchRequest = RemoteRuntimeLocator & {
  blockRef: string;
  idempotencyKey: string;
  agentEndpointId: string;
  expectedResponsibilityRevision: number;
  expectedReviewerRevision: number;
  executionTargetRevision: number;
  contentRevision: string;
  graphFingerprint: string;
  targetKind: "owner_canvas" | "workspace_canvas";
  callerHumanPrincipalId: string;
};

type AcceptancePorts = {
  dispatchCandidates: RemoteDispatchCandidateReaderPort;
  operations: RemoteOperationRepository;
  candidates: RemoteOperationCandidatePort;
  agentEndpoints?: AgentEndpointCatalog;
  authorizeRemoteAgentUse?: (input: AuthorizeRemoteAgentUseInput) => AuthorizedRemoteAgentUse;
  authorizeRemoteAgentUseForSnapshot?: (
    input: AuthorizeRemoteAgentUseInput
  ) => AuthorizedRemoteAgentUse;
  endpointAuthorize?: (input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    blockRef: string;
    expectedResponsibilityRevision: number;
    expectedReviewerRevision: number;
    executionTargetRevision: number;
    controlPlane: "collaboration" | "owner";
  }) => void;
  contentAuthorize: RemoteContentAuthorizePort;
  humanIdentity: HumanPrincipalIdentity;
  checkpoint: (point: RemoteCoordinatorCheckpoint) => Promise<void>;
};

function candidateForRuntimeTarget(
  candidate: RemoteBlockDispatchCandidate
): RemoteBlockDispatchCandidate {
  const userRequiredCapabilities = userRequiredCapabilitiesSchema.parse(
    candidate.requiredCapabilities
  );
  const requiredCapabilities = new Set(userRequiredCapabilities);
  requiredCapabilities.add(CANVAS_RUNTIME_EXECUTION_CAPABILITY);
  return remoteBlockDispatchCandidateSchema.parse({
    ...candidate,
    requiredCapabilities: [...requiredCapabilities]
  });
}

export async function acceptRemoteBlockDispatch(
  request: RemoteEndpointDispatchRequest,
  ports: AcceptancePorts
): Promise<RemoteOperation> {
  const requestedCaller = parseDispatchCaller(request.callerHumanPrincipalId);
  const target = dispatchTarget(request);
  const existing = ports.operations.findByCallerIdentity(request);
  if (existing) {
    const originalCaller = existing.agentAccess?.callerHumanPrincipalId;
    if (!originalCaller) {
      throw new RemoteAgentAuthorizationError("remote_agent_access_snapshot_missing");
    }
    if (!sameDispatchCaller(ports.humanIdentity, originalCaller, requestedCaller)) {
      throw new Error("remote_operation_idempotency_conflict");
    }
    if (
      existing.endpointSelection?.endpointId !== request.agentEndpointId ||
      existing.endpointSelection.authority.kind !== target.kind
    ) {
      throw new Error("remote_operation_idempotency_conflict");
    }
    return existing;
  }

  const callerHumanPrincipalId = canonicalizeDispatchCaller(ports.humanIdentity, requestedCaller);
  if (ports.agentEndpoints && ports.endpointAuthorize && ports.authorizeRemoteAgentUseForSnapshot) {
    ports.authorizeRemoteAgentUseForSnapshot({
      principal: { humanPrincipalId: callerHumanPrincipalId },
      endpointId: request.agentEndpointId,
      target,
      requiredCapabilities: [CANVAS_RUNTIME_EXECUTION_CAPABILITY],
      runtimeWorkspaceId: request.workspaceId,
      blockRef: request.blockRef,
      expectedResponsibilityRevision: request.expectedResponsibilityRevision,
      expectedReviewerRevision: request.expectedReviewerRevision,
      executionTargetRevision: request.executionTargetRevision
    });
  }
  const candidate = candidateForRuntimeTarget(await ports.dispatchCandidates.read(request));
  if (
    candidate.workspaceId !== request.workspaceId ||
    candidate.projectId !== request.projectId ||
    candidate.canvasId !== request.canvasId
  ) {
    throw new Error("remote_runtime_locator_candidate_mismatch");
  }
  if (candidate.graphFingerprint !== request.graphFingerprint) {
    throw new Error("remote_content_authority_candidate_mismatch");
  }
  if (!ports.agentEndpoints || !ports.endpointAuthorize || !ports.authorizeRemoteAgentUse) {
    throw new Error("agent_endpoint_dispatch_not_configured");
  }
  const authorizeForSnapshot = ports.authorizeRemoteAgentUseForSnapshot;
  if (!authorizeForSnapshot) throw new Error("agent_endpoint_dispatch_not_configured");
  const authorized = authorizeForSnapshot({
    principal: { humanPrincipalId: callerHumanPrincipalId },
    endpointId: request.agentEndpointId,
    target,
    requiredCapabilities: candidate.requiredCapabilities,
    runtimeWorkspaceId: candidate.workspaceId,
    blockRef: candidate.blockRef,
    expectedResponsibilityRevision: request.expectedResponsibilityRevision,
    expectedReviewerRevision: request.expectedReviewerRevision,
    executionTargetRevision: request.executionTargetRevision
  });
  const endpointSelection = snapshotDispatchEndpoint(
    ports.agentEndpoints.resolveForSnapshot(
      request.agentEndpointId,
      target.kind === "workspace_canvas" ? target.workspaceId : candidate.workspaceId,
      candidate.requiredCapabilities
    ),
    candidate,
    runtimeAuthoritySnapshotForTarget(target, {
      responsibilityRevision: request.expectedResponsibilityRevision,
      reviewerRevision: request.expectedReviewerRevision,
      executionTargetRevision: request.executionTargetRevision
    })
  );
  const agentAccess = persistedRemoteAgentAccessSnapshotSchema.parse({
    callerHumanPrincipalId,
    authorized
  });

  await ports.checkpoint("before_operation_commit");
  const operation = ports.candidates.createWithCandidate(() => {
    ports.endpointAuthorize?.({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      canvasId: request.canvasId,
      blockRef: request.blockRef,
      expectedResponsibilityRevision: request.expectedResponsibilityRevision,
      expectedReviewerRevision: request.expectedReviewerRevision,
      executionTargetRevision: request.executionTargetRevision,
      controlPlane: request.targetKind === "owner_canvas" ? "owner" : "collaboration"
    });
    ports.contentAuthorize({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      canvasId: request.canvasId,
      contentRevision: request.contentRevision,
      graphFingerprint: request.graphFingerprint
    });
    return ports.operations.create({
      workspaceId: workspaceIdSchema.parse(candidate.workspaceId),
      projectId: candidate.projectId,
      canvasId: candidate.canvasId,
      blockRef: candidate.blockRef,
      ownershipGeneration: candidate.sourceRevision,
      idempotencyKey: request.idempotencyKey,
      sourceFingerprint: candidate.graphFingerprint,
      requiredCapabilities: candidate.requiredCapabilities,
      endpointSelection,
      agentAccess
    });
  }, candidate);
  await ports.checkpoint("after_operation_commit");
  await ports.checkpoint("after_candidate_persistence");
  return operation;
}
