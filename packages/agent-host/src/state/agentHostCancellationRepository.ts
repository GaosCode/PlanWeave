import {
  historicalInteractionSettlementSchema,
  mailboxSequenceSchema
} from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import type { AgentHostRemoteExecutionIdentity } from "../execution/remoteAcpPorts.js";
import { parseHistoricalAgentHostMailboxCommand } from "../protocol.js";
import { digestJson } from "./agentHostStateMigrations.js";
import type { AgentHostExecutionEvidence } from "./agentHostStateRecords.js";
import { cancellationForMailboxCommand } from "./historicalPermissionCancellation.js";
import type { SqliteDatabase } from "./sqliteDatabase.js";

const cancellationIntentSchema = z.union([
  z.object({ reason: z.string(), commandSequence: mailboxSequenceSchema }).strict(),
  z.object({ kind: z.literal("authentication_cancelled"), actionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("coordinator_cancel"), migrated: z.literal(true) }).strict()
]);
type CancellationIntent = z.infer<typeof cancellationIntentSchema>;

function sameIdentity(
  left: AgentHostRemoteExecutionIdentity,
  right: AgentHostRemoteExecutionIdentity
): boolean {
  return (
    left.dispatchId === right.dispatchId &&
    left.leaseId === right.leaseId &&
    left.executionAttemptId === right.executionAttemptId
  );
}

export class AgentHostCancellationRepository {
  constructor(private readonly database: SqliteDatabase) {}

  matches(
    evidence: AgentHostExecutionEvidence,
    expected: AgentHostRemoteExecutionIdentity
  ): boolean {
    if (!sameIdentity(evidence, expected) || evidence.cancellationIntent === undefined)
      return false;
    const identity = this.resolve(
      evidence,
      cancellationIntentSchema.parse(evidence.cancellationIntent)
    );
    return (
      sameIdentity(identity, expected) &&
      (identity.acpSessionId === undefined || identity.acpSessionId === evidence.acpSessionId)
    );
  }

  set(evidence: AgentHostExecutionEvidence, input: unknown): void {
    const intent = cancellationIntentSchema.parse(input);
    const identity = this.resolve(evidence, intent);
    if (
      !sameIdentity(identity, evidence) ||
      (identity.acpSessionId !== undefined && identity.acpSessionId !== evidence.acpSessionId)
    )
      throw new Error("execution_cancellation_identity_stale");
    if (evidence.cancellationIntent !== undefined) {
      if (this.matches(evidence, evidence)) return;
      this.archive(evidence);
    }
    this.database
      .prepare("UPDATE agent_host_executions SET cancellation_intent_json=? WHERE inbox_sequence=?")
      .run(JSON.stringify(intent), evidence.sequence);
  }

  archive(evidence: AgentHostExecutionEvidence): void {
    if (evidence.cancellationIntent === undefined) return;
    const intent = cancellationIntentSchema.parse(evidence.cancellationIntent);
    const identity = this.resolve(evidence, intent);
    const serialized = JSON.stringify(intent);
    const existing = this.database
      .prepare(
        `SELECT inbox_sequence,intent_json FROM agent_host_execution_cancellation_history
       WHERE dispatch_id=? AND lease_id=? AND execution_attempt_id=?`
      )
      .get(identity.dispatchId, identity.leaseId, identity.executionAttemptId);
    if (existing) {
      if (
        Number(existing.inbox_sequence) !== evidence.sequence ||
        String(existing.intent_json) !== serialized
      )
        throw new Error("execution_cancellation_history_conflict");
      return;
    }
    this.database
      .prepare(
        `INSERT INTO agent_host_execution_cancellation_history(
        inbox_sequence,dispatch_id,lease_id,execution_attempt_id,intent_json
      ) VALUES(?,?,?,?,?)`
      )
      .run(
        evidence.sequence,
        identity.dispatchId,
        identity.leaseId,
        identity.executionAttemptId,
        serialized
      );
  }

  private resolve(
    evidence: AgentHostExecutionEvidence,
    intent: CancellationIntent
  ): AgentHostRemoteExecutionIdentity & { acpSessionId?: string } {
    let identity: AgentHostRemoteExecutionIdentity & { acpSessionId?: string };
    if ("kind" in intent && intent.kind === "authentication_cancelled") {
      const rows = this.database
        .prepare(
          `SELECT lease_id,session_id,response_json,response_digest FROM agent_host_execution_actions
         WHERE inbox_sequence=? AND action_id=? AND action_kind='authentication' AND settled_at IS NOT NULL`
        )
        .all(evidence.sequence, intent.actionId);
      if (rows.length !== 1) throw new Error("execution_cancellation_action_not_found");
      const row = rows[0]!;
      const response = historicalInteractionSettlementSchema.parse(
        JSON.parse(String(row.response_json))
      );
      if (
        response.type !== "interaction.authentication_action" ||
        response.action !== "cancel" ||
        response.actionId !== intent.actionId ||
        response.leaseId !== row.lease_id ||
        response.acpSessionId !== row.session_id ||
        digestJson(response) !== row.response_digest
      )
        throw new Error("execution_cancellation_action_invalid");
      identity = response;
    } else {
      const row = this.database
        .prepare("SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?")
        .get("commandSequence" in intent ? intent.commandSequence : evidence.sequence);
      if (!row) throw new Error("execution_cancellation_command_not_found");
      const command = parseHistoricalAgentHostMailboxCommand(JSON.parse(String(row.command_json)));
      const cancellation =
        "commandSequence" in intent
          ? cancellationForMailboxCommand(command)
          : command.type === "execute_block"
            ? command
            : undefined;
      if (
        !cancellation ||
        digestJson(command) !== row.command_digest ||
        ("commandSequence" in intent &&
          "reason" in cancellation &&
          cancellation.reason !== intent.reason)
      )
        throw new Error("execution_cancellation_command_invalid");
      identity = cancellation;
    }
    if (
      identity.dispatchId !== evidence.dispatchId ||
      identity.executionAttemptId !== evidence.executionAttemptId
    )
      throw new Error("execution_cancellation_evidence_identity_mismatch");
    return identity;
  }
}
