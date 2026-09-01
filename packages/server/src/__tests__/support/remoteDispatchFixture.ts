import {
  agentHostProtocolVersion,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  mailboxCommandSchema,
  type ExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { HostReservationRepository } from "../../hostReservations.js";
import { RemoteOperationRepository } from "../../remoteOperations.js";
import { SqliteRemoteDispatchPersistence } from "../../remoteCoordinatorPersistence.js";
import type { SqliteDatabase } from "../../sqlite.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import type { TestDispatchCoordination } from "./testDispatchCoordination.js";

type FixtureOptions = {
  leaseDurationMs?: number;
  hostOfflineAfterMs?: number;
};

export function createRemoteDispatchFixture(
  database: SqliteDatabase,
  coordination: Pick<TestDispatchCoordination, "mailbox" | "dispatches" | "hosts">,
  sourceEnvelope: ExecutionEnvelope,
  options: FixtureOptions = {}
) {
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject(sourceEnvelope.projectId);
  const requiredCapabilities = new Set(sourceEnvelope.requiredCapabilities);
  const candidateHost = coordination.hosts.list().find((host) => {
    const hostWorkspaceId = workspaceIdentity.workspaceForHost(host.id);
    return (
      (hostWorkspaceId === undefined || hostWorkspaceId === workspaceId) &&
      [...requiredCapabilities].every((capability) => host.capabilities.includes(capability))
    );
  });
  if (candidateHost) {
    if (workspaceIdentity.workspaceForHost(candidateHost.id) === undefined) {
      coordination.hosts.bindToWorkspace(candidateHost.id, workspaceId);
    }
    coordination.hosts.reportOnline(
      candidateHost.id,
      candidateHost.capabilities,
      candidateHost.capacity,
      {
        workspaceMappings: [{ workspaceId, status: "ready" }],
        acpProfiles: [
          {
            profileId: sourceEnvelope.agentProfileId,
            agentId: sourceEnvelope.agentId,
            displayName: "Test Agent",
            status: "ready",
            capabilities: candidateHost.capabilities
          }
        ]
      }
    );
  }
  const operations = new RemoteOperationRepository(database);
  let operation = operations.create({
    workspaceId,
    projectId: sourceEnvelope.projectId,
    canvasId: sourceEnvelope.canvasId,
    blockRef: sourceEnvelope.blockRef,
    ownershipGeneration: sourceEnvelope.sourceRevision,
    idempotencyKey: sourceEnvelope.execution.dispatchId,
    sourceFingerprint: sourceEnvelope.graphFingerprint,
    requiredCapabilities: sourceEnvelope.requiredCapabilities
  });
  if (operation.state === "preparing") operation = operations.markClaimed(operation.id);
  const envelope = executionEnvelopeSchema.parse({
    ...sourceEnvelope,
    execution: {
      dispatchId: operation.dispatchId,
      attemptId: operation.executionAttemptId
    }
  });
  const envelopeDigest = hashExecutionEnvelope(envelope);
  operation = operations.recordEnvelope({ operationId: operation.id, digest: envelopeDigest });
  const reservations = new HostReservationRepository(database, {
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    hostOfflineAfterMs: options.hostOfflineAfterMs ?? 60_000
  });
  const reservation = operation.attempt.leaseId
    ? reservations.getRequired(operation.attempt.leaseId)
    : reservations.reserve(operation.id, {
        agentId: sourceEnvelope.agentId,
        agentProfileId: sourceEnvelope.agentProfileId
      });
  operation = operations.getRequired(operation.id);
  const persistence = new SqliteRemoteDispatchPersistence(database);
  persistence.prepare({ operation, reservation, envelope, envelopeDigest });
  const delivery = persistence.activate({
    operation,
    reservation,
    command: mailboxCommandSchema.parse({
      type: "execute_block",
      protocolVersion: agentHostProtocolVersion,
      dispatchId: operation.dispatchId,
      leaseId: reservation.leaseId,
      executionAttemptId: operation.executionAttemptId,
      leaseExpiresAt: reservation.leaseExpiresAt,
      envelopeDigest,
      envelope
    })
  });
  if (!delivery.message.publishedAt) {
    coordination.mailbox.publish(delivery.message);
    persistence.markMailboxPublished(delivery.message.messageId);
  }
  return coordination.dispatches.getRequired(operation.dispatchId);
}
