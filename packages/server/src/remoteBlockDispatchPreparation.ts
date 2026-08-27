import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  OUTPUT_MAX_ARTIFACT_COUNT,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
  agentHostProtocolVersion,
  assertAgentHostProtocolCompatible,
  executionEnvelopeSchema,
  type OwnerPackageLocator
} from "@planweave-ai/agent-host-protocol";
import { RemoteBlockRuntimeError, type RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import type {
  CanvasRuntimeInitializationEvidence,
  CanvasExecutionRuntimeLeasePort,
  CanvasExecutionRuntimeRoutePort
} from "./canvas/executionRuntimePort.js";
import {
  acquireRemoteRuntimeLease,
  type RemoteRuntimeLocator
} from "./remoteBlockCoordinatorPorts.js";
import type { RemoteOperation } from "./remoteOperations.js";

/** Creates the immutable Host envelope after authorization and before artifact materialization. */
export function buildRemoteBlockExecutionEnvelope(
  operation: RemoteOperation,
  candidate: RemoteBlockDispatchCandidate,
  ownerPackageLocator?: OwnerPackageLocator,
  runtimeMaterialization?: CanvasRuntimeInitializationEvidence
) {
  const protocolCheck = assertAgentHostProtocolCompatible(agentHostProtocolVersion);
  if (!protocolCheck.ok) {
    throw new Error(`${protocolCheck.code}:${protocolCheck.message}`);
  }
  const targetKind = operation.endpointSelection?.authority.kind;
  if (targetKind === undefined) {
    throw new Error("remote_operation_endpoint_selection_missing");
  }
  const workspaceCapabilityPersisted = operation.requiredCapabilities.includes(
    WORKSPACE_CANVAS_EXECUTION_CAPABILITY
  );
  if (workspaceCapabilityPersisted !== (targetKind === "workspace_canvas")) {
    throw new Error("remote_operation_runtime_capability_mismatch");
  }
  return executionEnvelopeSchema.parse({
    protocolVersion: agentHostProtocolVersion,
    execution: {
      dispatchId: operation.dispatchId,
      attemptId: operation.executionAttemptId
    },
    projectId: candidate.projectId,
    canvasId: candidate.canvasId,
    taskId: candidate.taskId,
    blockRef: candidate.blockRef,
    blockType: candidate.blockType,
    sourceRevision: candidate.sourceRevision,
    graphFingerprint: candidate.graphFingerprint,
    ...(runtimeMaterialization === undefined
      ? {}
      : {
          runtimeMaterialization: {
            sourceRevision: runtimeMaterialization.sourceRevision,
            graphFingerprint: runtimeMaterialization.graphFingerprint
          }
        }),
    renderedPrompt: candidate.renderedPrompt,
    acceptance: candidate.acceptance,
    dependencySummaries: candidate.dependencySummaries,
    inputArtifacts: candidate.inputArtifacts,
    workspaceId: candidate.workspaceId,
    ...(ownerPackageLocator === undefined ? {} : { ownerPackageLocator }),
    agentId: operation.endpointSelection?.agentId ?? candidate.agentId,
    agentProfileId: operation.endpointSelection?.profileId ?? candidate.agentProfileId,
    session: candidate.session,
    requiredCapabilities: operation.requiredCapabilities,
    output: {
      reportRequired: true,
      maxArtifactBytes: OUTPUT_MAX_ARTIFACT_BYTES,
      maxArtifactCount: OUTPUT_MAX_ARTIFACT_COUNT
    },
    trace: { correlationId: operation.id }
  });
}

/** Reads a dispatch candidate through the authorized route and retries only source refresh drift. */
export async function inspectRemoteBlockDispatchCandidate(
  runtimeLeases: CanvasExecutionRuntimeLeasePort | CanvasExecutionRuntimeRoutePort,
  request: RemoteRuntimeLocator & { blockRef: string },
  hostId?: string
): Promise<RemoteBlockDispatchCandidate> {
  const inspect = async () => {
    const acquired = await acquireRemoteRuntimeLease(runtimeLeases, request, hostId);
    try {
      return await acquired.runtime.inspect({ ref: request.blockRef });
    } finally {
      await acquired.release();
    }
  };
  try {
    return await inspect();
  } catch (error) {
    if (
      !(error instanceof RemoteBlockRuntimeError) ||
      error.code !== "remote_block_source_changed"
    ) {
      throw error;
    }
    return inspect();
  }
}
