import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agentHostProtocolVersion,
  exampleExecuteDelivery,
  executeBlockCommandSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { restoreLegacyAgentHostFixture } from "./support/legacyAgentHostFixture.js";

const cases = [
  { name: "queued", status: "accepted", confirmed: 1, compacted: false },
  { name: "running", status: "running", confirmed: 1, compacted: false },
  { name: "completedMailboxUnconfirmed", status: "completed", confirmed: 1, compacted: true },
  { name: "terminalEventUnconfirmed", status: "completed", confirmed: 1, compacted: false },
  { name: "terminalRetained", status: "completed", confirmed: 1, compacted: false },
  { name: "compacted", status: "completed", confirmed: 1, compacted: true },
  { name: "failedMailboxUnconfirmed", status: "failed", confirmed: 1, compacted: true },
  { name: "cancelledMailboxUnconfirmed", status: "cancelled", confirmed: 2, compacted: true }
] as const;

function currentDelivery(previousSequence: number) {
  const envelope = {
    ...exampleExecuteDelivery.command.envelope,
    execution: { dispatchId: "dispatch-after-upgrade", attemptId: "attempt-after-upgrade" }
  };
  return {
    ...exampleExecuteDelivery,
    sequence: previousSequence + 1,
    previousSequence,
    messageId: "mailbox-after-upgrade",
    command: executeBlockCommandSchema.parse({
      ...exampleExecuteDelivery.command,
      protocolVersion: agentHostProtocolVersion,
      dispatchId: envelope.execution.dispatchId,
      executionAttemptId: envelope.execution.attemptId,
      leaseId: "lease-after-upgrade",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      envelope,
      envelopeDigest: hashExecutionEnvelope(envelope)
    })
  };
}

describe("original v1 Agent Host database upgrade matrix", () => {
  it.each(
    cases
  )("preserves $name evidence through upgrade, confirmation and repeated reopen", async (testCase) => {
    const fixture = await restoreLegacyAgentHostFixture(testCase.name);
    let state = await fixture.open();
    const database = await openAgentHostDatabase(fixture.path, 5_000);
    try {
      const inbox = fixture.tables.agent_host_inbox ?? [];
      const outbox = fixture.tables.agent_host_outbox ?? [];
      for (const row of inbox)
        expect(row.command_digest).toBe(
          `sha256:${createHash("sha256").update(String(row.command_json)).digest("hex")}`
        );
      for (const row of inbox)
        expect(
          database
            .prepare("SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?")
            .get(row.sequence)
        ).toEqual({ command_json: row.command_json, command_digest: row.command_digest });
      for (const row of outbox)
        expect(
          database
            .prepare("SELECT event_json,acknowledged_at FROM agent_host_outbox WHERE message_id=?")
            .get(row.message_id)
        ).toEqual({ event_json: row.event_json, acknowledged_at: row.acknowledged_at });
      expect(state.pendingEvents()).toEqual([]);
      state.synchronizeMailboxAcknowledgement(testCase.confirmed);
      state.synchronizeMailboxAcknowledgement(testCase.confirmed);
      fixture.close(state);
      state = await fixture.open();
      expect(state.lastAcknowledgedSequence()).toBe(testCase.confirmed);
      expect(state.lastReceivedSequence()).toBe(testCase.confirmed);
      if (testCase.compacted) {
        expect(state.executionEvidence(1)).toBeUndefined();
        const oldReceipt = fixture.tables.agent_host_terminal_execution_receipts?.[0];
        const oldExecution = fixture.tables.agent_host_executions?.[0];
        const original = oldReceipt ?? oldExecution;
        if (!original) throw new Error("expected_original_execution_evidence");
        expect(
          database.prepare("SELECT * FROM agent_host_terminal_execution_receipts").get()
        ).toMatchObject({
          dispatch_id: original.dispatch_id,
          execution_attempt_id: original.execution_attempt_id,
          lease_id: original.lease_id,
          protocol_version: 1,
          envelope_digest: original.envelope_digest,
          terminal_kind: testCase.status,
          terminal_payload_digest: original.terminal_payload_digest,
          command_digest: oldReceipt?.command_digest ?? inbox[0]?.command_digest
        });
        expect(database.prepare("SELECT * FROM agent_host_inbox").all()).toEqual([]);
        expect(database.prepare("SELECT * FROM agent_host_outbox").all()).toEqual([]);
      } else {
        expect(state.executionEvidence(1)).toMatchObject({
          protocolVersion: 1,
          status: testCase.status
        });
        for (const row of inbox)
          expect(
            database
              .prepare("SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?")
              .get(row.sequence)
          ).toEqual({ command_json: row.command_json, command_digest: row.command_digest });
      }
      const current = currentDelivery(state.lastReceivedSequence());
      const accepted = state.receive(current);
      expect(accepted.stored).toBe(true);
      state.acknowledgeEvent(accepted.acknowledgement.messageId);
      expect(state.startExecution(current.sequence)?.command.protocolVersion).toBe(2);
      const started = state.pendingEvents().find((event) => event.type === "dispatch.accepted");
      if (!started) throw new Error("expected_current_execution_acceptance");
      state.acknowledgeEvent(started.messageId);
      expect(
        state.completeExecution(current.sequence, current.command, {
          summary: "Current execution completed after upgrade",
          reportArtifactRef: `artifact:sha256:${"b".repeat(64)}`,
          artifactRefs: []
        })
      ).toBe("applied");
      const completed = state.pendingEvents().find((event) => event.type === "dispatch.completed");
      if (!completed) throw new Error("expected_current_execution_completion");
      state.acknowledgeEvent(completed.messageId);
      fixture.close(state);
      state = await fixture.open();
      expect(state.executionEvidence(current.sequence)).toBeUndefined();
      expect(state.lastAcknowledgedSequence()).toBe(current.sequence);
      expect(
        database
          .prepare(
            "SELECT protocol_version,terminal_kind FROM agent_host_terminal_execution_receipts WHERE dispatch_id=?"
          )
          .get(current.command.dispatchId)
      ).toEqual({ protocol_version: 2, terminal_kind: "completed" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
