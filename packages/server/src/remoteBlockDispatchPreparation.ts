import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  OUTPUT_MAX_ARTIFACT_COUNT,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
  agentHostProtocolVersion,
  assertAgentHostProtocolCompatible,
  executionEnvelopeSchema,
  type OwnerPackageLocator
} from "@planweave-ai/agent-host-protocol";
import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import type { CanvasRuntimeInitializationEvidence } from "./canvas/executionRuntimePort.js";
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
