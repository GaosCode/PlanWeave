import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACP_CONVERSATION_CAPABILITY,
  acpConversationEventSchema,
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  executeBlockCommandSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { AcpConversationService } from "../acpConversationService.js";
import { DurableMailbox } from "../mailbox.js";
import { AgentHostRepository } from "../hosts.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import { createRemoteAcpEventV2Fixture } from "./support/remoteAcpEventV2Fixture.js";
const fixtures: Awaited<ReturnType<typeof createRemoteAcpEventV2Fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const f = await createRemoteAcpEventV2Fixture();
  fixtures.push(f);
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
    authorize
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
describe("durable remote ACP continuation", () => {
  it("continues a cancelled execution in its original session while retaining its cancelled outcome", async () => {
    const f = await setup();
    f.db.prepare("UPDATE remote_operations SET state='cancelled' WHERE id=?").run(f.operation.id);
    const operation = new RemoteOperationRepository(f.db, f.clock).getRequired(f.operation.id);
    expect(f.service.page(operation, "actor").available).toBe(true);
    expect(f.service.act(operation, "actor", f.prompt).turns[0]).toMatchObject({
      sessionId: "original-session",
      status: "queued"
    });
    expect(new RemoteOperationRepository(f.db, f.clock).getRequired(f.operation.id).state).toBe(
      "cancelled"
    );
    f.db
      .prepare("DELETE FROM remote_acp_event_streams WHERE execution_attempt_id=?")
      .run(operation.executionAttemptId);
    expect(f.service.page(operation, "actor")).toMatchObject({
      available: false,
      reason: "acp_conversation_session_unavailable"
    });
  });

  it.each(["running", "failed"] as const)("does not unlock a %s execution", async (state) => {
    const f = await setup();
    const operation = { ...f.operation, state };
    expect(f.service.page(operation, "actor").available).toBe(false);
    expect(() => f.service.act(operation, "actor", f.prompt)).toThrow(
      "acp_conversation_execution_not_completed"
    );
  });

  it("sends two turns in the original session without reopening the completed operation, and deduplicates retries", async () => {
    const f = await setup();
    expect(f.service.page(f.operation, "actor").available).toBe(true);
    const page = f.service.act(f.operation, "actor", f.prompt);
    expect(page.turns[0]?.status).toBe("queued");
    f.service.act(f.operation, "actor", f.prompt);
    expect(
      f.mailbox.listAfter(f.host.id, 0).filter((m) => m.command.type === "acp_conversation.prompt")
    ).toHaveLength(1);
    expect(() => f.service.act(f.operation, "actor", { ...f.prompt, turnId: "other" })).toThrow(
      "in_flight"
    );
    const completed = f.event(1, { kind: "status", status: "completed", error: null });
    f.service.ingest(f.host.id, completed);
    f.service.ingest(f.host.id, completed);
    f.service.act(f.operation, "actor", { ...f.prompt, turnId: "turn-two", text: "One more" });
    expect(f.service.page(f.operation, "actor").turns).toHaveLength(2);
    expect(new RemoteOperationRepository(f.db, f.clock).getRequired(f.operation.id).state).toBe(
      "completed"
    );
    expect(f.service.page(f.operation, "actor", 1).events).toHaveLength(0);
  });
  it("rejects cross-session, cross-host, changed retries, event gaps, and unauthorized actors", async () => {
    const f = await setup();
    f.service.act(f.operation, "actor", f.prompt);
    expect(() => f.service.act(f.operation, "other", f.prompt)).toThrow("forbidden");
    expect(() => f.service.act(f.operation, "actor", { ...f.prompt, text: "changed" })).toThrow(
      "conflict"
    );
    expect(() => f.service.act(f.operation, "actor", { ...f.prompt, sessionId: "wrong" })).toThrow(
      "mismatch"
    );
    const event = f.event(1, { kind: "status", status: "running", error: null });
    expect(() => f.service.ingest("another-host", event)).toThrow("identity_mismatch");
    expect(() => f.service.ingest(f.host.id, { ...event, sequence: 2 })).toThrow("gap");
    f.authorize.mockImplementation(() => {
      throw new Error("forbidden");
    });
    expect(() => f.service.page(f.operation, "actor")).toThrow("forbidden");
  });
  it("validates permission options and makes responses idempotent even after settlement", async () => {
    const f = await setup();
    f.service.act(f.operation, "actor", f.prompt);
    f.service.ingest(
      f.host.id,
      f.event(1, {
        kind: "interaction",
        request: {
          kind: "permission",
          requestId: "permission-one",
          summary: "Read file",
          deadline: "2030-01-01T00:01:00.000Z",
          options: [{ optionId: "allow", label: "Allow", decision: "approve" }]
        }
      })
    );
    const action = {
      kind: "respond",
      turnId: f.prompt.turnId,
      sessionId: f.prompt.sessionId,
      executionAttemptId: f.prompt.executionAttemptId,
      requestId: "permission-one",
      decision: { kind: "permission", optionId: "allow" }
    };
    expect(() =>
      f.service.act(f.operation, "actor", {
        ...action,
        decision: { kind: "permission", optionId: "invalid" }
      })
    ).toThrow("decision_invalid");
    f.service.act(f.operation, "actor", action);
    f.service.ingest(
      f.host.id,
      f.event(2, { kind: "interaction_settled", requestId: "permission-one" })
    );
    f.service.act(f.operation, "actor", action);
    expect(() =>
      f.service.act(f.operation, "actor", {
        ...action,
        decision: { kind: "permission", optionId: null }
      })
    ).toThrow("response_conflict");
    expect(
      f.mailbox.listAfter(f.host.id, 0).filter((m) => m.command.type === "acp_conversation.respond")
    ).toHaveLength(1);
  });
});
