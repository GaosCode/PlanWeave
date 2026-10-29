import { vi } from "vitest";
import {
  ACP_CONVERSATION_CAPABILITY,
  acpConversationEventSchema,
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  executeBlockCommandSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { AcpConversationService } from "../../acpConversationService.js";
import { DurableMailbox } from "../../mailbox.js";
import { AgentHostRepository } from "../../hosts.js";
import { RemoteOperationRepository } from "../../remoteOperations.js";
import { createRemoteAcpEventV2Fixture } from "./remoteAcpEventV2Fixture.js";
export async function createAcpConversationFixture(
  options: {
    clock?: () => Date;
    restoreTask?: NonNullable<
      ConstructorParameters<typeof AcpConversationService>[1]["restoreTask"]
    >;
  } = {}
) {
  const f = await createRemoteAcpEventV2Fixture(options.clock);
  const db = f.server.database;
  const hosts = new AgentHostRepository(db, f.clock);
  hosts.reportOnline(f.host.id, ["linux", "acp.codex", ACP_CONVERSATION_CAPABILITY], 2);
  const envelope = executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    execution: { dispatchId: f.operation.dispatchId, attemptId: f.operation.executionAttemptId }
  });
  const mailbox = new DurableMailbox(db);
  mailbox.enqueue(
    f.host.id,
    executeBlockCommandSchema.parse({
      type: "execute_block",
      protocolVersion: 1,
      dispatchId: f.operation.dispatchId,
      executionAttemptId: f.operation.executionAttemptId,
      leaseId: f.reservation.leaseId,
      leaseExpiresAt: f.reservation.leaseExpiresAt,
      envelope,
      envelopeDigest: hashExecutionEnvelope(envelope)
    })
  );
  db.prepare(`INSERT INTO remote_acp_event_streams(execution_attempt_id,operation_id,dispatch_id,lease_id,host_id,acp_session_id,updated_at)
    VALUES(?,?,?,?,?,'original-session',?)`).run(
    f.operation.executionAttemptId,
    f.operation.id,
    f.operation.dispatchId,
    f.reservation.leaseId,
    f.host.id,
    f.clock().toISOString()
  );
  db.prepare(
    "UPDATE remote_operations SET state='completed',terminal_at='2030-01-01T00:00:00.000Z' WHERE id=?"
  ).run(f.operation.id);
  const operation = new RemoteOperationRepository(db, f.clock).getRequired(f.operation.id);
  const authorize = vi.fn();
  const service = new AcpConversationService(db, {
    hosts,
    mailbox,
    hostOfflineAfterMs: 60_000,
    clock: f.clock,
    authorize,
    restoreTask: options.restoreTask
  });
  const prompt = {
    kind: "prompt" as const,
    turnId: "turn-one",
    executionAttemptId: operation.executionAttemptId,
    sessionId: "original-session",
    text: "Continue please"
  };
  const event = (sequence: number, payload: unknown, turnId = prompt.turnId) =>
    acpConversationEventSchema.parse({
      protocolVersion: 1,
      type: "acp_conversation.event",
      messageId: `message-${turnId}-${sequence}`,
      operationId: operation.id,
      turnId,
      executionAttemptId: operation.executionAttemptId,
      sessionId: prompt.sessionId,
      sequence,
      timestamp: f.clock().toISOString(),
      payload
    });
  return { ...f, db, hosts, mailbox, operation, service, prompt, event, authorize };
}
