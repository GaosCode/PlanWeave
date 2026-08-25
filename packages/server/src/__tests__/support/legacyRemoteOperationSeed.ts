import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import { SqliteRemoteOperationCandidateRepository } from "../../remoteCoordinatorPersistence.js";
import { RemoteOperationRepository, type RemoteOperation } from "../../remoteOperations.js";
import type { RemoteRuntimeLocator } from "../../remoteBlockCoordinatorPorts.js";
import type { SqliteDatabase } from "../../sqlite.js";
import type { DispatchHostSelectionSnapshot } from "../../work/dispatchIntegration.js";
import type { PersistedRemoteAgentAccessSnapshot } from "../../remoteAgent/schema.js";

export function seedLegacyRemoteOperation(input: {
  database: SqliteDatabase;
  operations: RemoteOperationRepository;
  locator: RemoteRuntimeLocator;
  candidate: RemoteBlockDispatchCandidate;
  idempotencyKey: string;
  hostSelection?: DispatchHostSelectionSnapshot;
  agentAccess?: PersistedRemoteAgentAccessSnapshot;
}): RemoteOperation {
  if (
    input.candidate.workspaceId !== input.locator.workspaceId ||
    input.candidate.projectId !== input.locator.projectId ||
    input.candidate.canvasId !== input.locator.canvasId
  ) {
    throw new Error("legacy_seed_locator_candidate_mismatch");
  }
  const operation = input.operations.create({
    ...input.locator,
    blockRef: input.candidate.blockRef,
    ownershipGeneration: input.candidate.sourceRevision,
    idempotencyKey: input.idempotencyKey,
    sourceFingerprint: input.candidate.graphFingerprint,
    requiredCapabilities: input.candidate.requiredCapabilities,
    ...(input.hostSelection === undefined ? {} : { hostSelection: input.hostSelection }),
    ...(input.agentAccess === undefined ? {} : { agentAccess: input.agentAccess })
  });
  new SqliteRemoteOperationCandidateRepository(input.database).record(
    operation.id,
    input.candidate
  );
  return operation;
}
