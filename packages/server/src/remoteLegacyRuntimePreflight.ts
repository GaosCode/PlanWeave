import type { RemoteBlockCoordinatorOptions } from "./remoteBlockCoordinator.js";
import type { RemoteOperation } from "./remoteOperations.js";
import {
  acquireRemoteRuntimeLease,
  authorizedOperationHostId
} from "./remoteBlockCoordinatorPorts.js";
import { candidateForIdentity } from "./remoteBlockCoordinatorEndpoint.js";
import { withRemoteRuntimeLease } from "./remoteRuntimeLeaseCleanup.js";

/** Check unmigrated attempts against their exact Host before reserving execution capacity. */
export async function inspectLegacyRemoteRuntime(
  options: Pick<RemoteBlockCoordinatorOptions, "operations" | "runtimeLeases" | "candidates">,
  operation: RemoteOperation
): Promise<void> {
  if (!operation.endpointSelection) {
    if (operation.state === "preparing") options.operations.markClaimed(operation.id);
    throw new Error("remote_operation_endpoint_selection_missing");
  }
  const legacyRuntimeLease = await acquireRemoteRuntimeLease(
    options.runtimeLeases,
    operation,
    authorizedOperationHostId(operation)
  );
  await withRemoteRuntimeLease(options.operations, operation.id, legacyRuntimeLease, async () => {
    const current = await legacyRuntimeLease.runtime.inspect({ ref: operation.blockRef });
    const candidate = candidateForIdentity(operation, options.candidates);
    if (
      current.sourceRevision !== candidate.sourceRevision ||
      current.graphFingerprint !== candidate.graphFingerprint
    ) {
      if (operation.state === "preparing") options.operations.markClaimed(operation.id);
      options.operations.recordDiagnostic(
        operation.id,
        "remote_source_changed",
        "The Runtime source changed before Host reservation."
      );
      throw new Error("remote_source_changed");
    }
  });
}
