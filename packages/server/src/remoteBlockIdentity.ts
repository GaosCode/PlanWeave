import { remoteBlockRefIdentitySchema } from "@planweave-ai/runtime";
import { runtimeControlPlane } from "./endpointSelection.js";
import type { RemoteOperation } from "./remoteOperations.js";

export function remoteBlockIdentity(operation: RemoteOperation) {
  return remoteBlockRefIdentitySchema.parse({
    ref: operation.blockRef,
    operationId: operation.id,
    controlPlane: runtimeControlPlane(operation.endpointSelection?.authority),
    sourceRevision: operation.ownershipGeneration,
    graphFingerprint: operation.sourceFingerprint,
    dispatchId: operation.dispatchId,
    executionAttemptId: operation.executionAttemptId
  });
}
