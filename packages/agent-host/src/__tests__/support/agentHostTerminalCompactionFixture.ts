import {
  agentHostProtocolVersion,
  exampleExecuteDelivery,
  executeBlockCommandSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { openAgentHostState, type AgentHostState } from "../../state/agentHostState.js";
import { DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY } from "../../state/agentHostTerminalCompaction.js";
import { openAgentHostDatabase } from "../../state/sqliteDatabase.js";

const directories: string[] = [];
export const states: AgentHostState[] = [];

export async function cleanup() {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
}

export async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-compaction-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const state = await openAgentHostState(path);
  states.push(state);
  return { path, state };
}

export function commandFor(index: number) {
  const dispatchId = `dispatch-compaction-${index}`;
  const executionAttemptId = `attempt-compaction-${index}`;
  const envelope = {
    ...exampleExecuteDelivery.command.envelope,
    execution: {
      ...exampleExecuteDelivery.command.envelope.execution,
      dispatchId,
      attemptId: executionAttemptId
    }
  };
  return executeBlockCommandSchema.parse({
    ...exampleExecuteDelivery.command,
    dispatchId,
    leaseId: `lease-compaction-${index}`,
    executionAttemptId,
    envelope,
    envelopeDigest: hashExecutionEnvelope(envelope)
  });
}

export function delivery(sequence: number, index = sequence) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: agentHostProtocolVersion,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-compaction-${sequence}`,
    command: commandFor(index)
  };
}

export function cancelDelivery(sequence: number, index = 1) {
  const command = commandFor(index);
  return {
    type: "mailbox.message" as const,
    protocolVersion: agentHostProtocolVersion,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-cancel-compaction-${sequence}`,
    command: {
      type: "cancel_execution" as const,
      protocolVersion: agentHostProtocolVersion,
      dispatchId: command.dispatchId,
      leaseId: command.leaseId,
      executionAttemptId: command.executionAttemptId,
      reason: "Compaction replay cancellation."
    }
  };
}

export function permissionDelivery(sequence: number, index = 1) {
  const command = commandFor(index);
  return {
    type: "mailbox.message" as const,
    protocolVersion: agentHostProtocolVersion,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-permission-compaction-${sequence}`,
    command: {
      type: "interaction.permission_response" as const,
      dispatchId: command.dispatchId,
      leaseId: command.leaseId,
      executionAttemptId: command.executionAttemptId,
      acpSessionId: "acp-compaction",
      actionId: "permission-compaction",
      decision: "deny" as const
    }
  };
}

export const result = {
  summary: "terminal compaction complete",
  reportArtifactRef: `artifact:sha256:${"a".repeat(64)}` as const,
  artifactRefs: []
};

export function acknowledgeByType(state: AgentHostState, type: string): void {
  const event = state.pendingEvents().find((candidate) => candidate.type === type);
  if (!event) throw new Error(`missing_test_event:${type}`);
  expect(state.acknowledgeEvent(event.messageId)).toBe(true);
}

export function count(
  database: Awaited<ReturnType<typeof openAgentHostDatabase>>,
  table: string
): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

export function seedReceiptHistory(
  database: Awaited<ReturnType<typeof openAgentHostDatabase>>,
  compactedAt: string,
  executionCount = DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY.maxReceipts,
  mailboxCount = DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY.maxMailboxReceipts
): void {
  database
    .prepare(
      `WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<?)
       INSERT INTO agent_host_terminal_execution_receipts
       SELECT 'historical-dispatch','attempt-'||n,n,n-1,'execution-'||n,'digest',
              'lease',1,'envelope',1,'workspace','profile','revision','completed',
              'terminal-digest','terminal-'||n,?,? FROM rows`
    )
    .run(executionCount, compactedAt, compactedAt);
  database
    .prepare(
      `WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<?)
       INSERT INTO agent_host_compacted_mailbox_receipts
       SELECT n,n-1,'mailbox-'||n,'execute_block','digest','historical-dispatch','attempt-'||n,?
       FROM rows`
    )
    .run(mailboxCount, compactedAt);
  database
    .prepare(
      `UPDATE agent_host_mailbox_checkpoint
       SET received_high_water_sequence=?,acknowledged_high_water_sequence=?`
    )
    .run(mailboxCount, mailboxCount);
}
