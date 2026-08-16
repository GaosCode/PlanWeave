import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  HostReadinessObservation,
  InteractionSettlement
} from "@planweave-ai/agent-host-protocol";
import type {
  AgentHostRemoteExecutionIdentity,
  AgentHostRemoteExecutionRecord
} from "../execution/remoteAcpPorts.js";
import {
  parseAgentHostEvent,
  parseAgentHostMailboxCommand,
  parseAgentHostServerEvent,
  type HostEvent,
  type NormalizedFailure as ProtocolDispatchFailure,
  type DispatchResult as ProtocolDispatchResult,
  type ServerEvent
} from "../protocol.js";
import { AgentHostExecutionRepository } from "./agentHostExecutionRepository.js";
import { digestJson, initializeAgentHostStateSchema } from "./agentHostStateMigrations.js";
import {
  type AgentHostExecution,
  type AgentHostExecutionEvidence,
  type ExecuteBlockCommand
} from "./agentHostStateRecords.js";
import {
  type AgentHostCancellation,
  type AgentHostResumption,
  type AgentHostStateLimits,
  type AgentHostStateRepository,
  DEFAULT_AGENT_HOST_STATE_LIMITS
} from "./agentHostStateContract.js";
import {
  AgentHostRemoteExecutionRecordStore,
  readLegacyRemoteExecutionRecords
} from "./remoteExecutionOutbox.js";
import { AgentHostEventOutbox } from "./agentHostEventOutbox.js";
import { createInterruptedEvent } from "./agentHostRecoveryEvidence.js";
import {
  AgentHostInteractionSettlements,
  type AgentHostInteractionIdentity
} from "./agentHostInteractionSettlements.js";
import { AgentHostTerminalCompactionRepository } from "./agentHostTerminalCompaction.js";
import { AgentHostRemoteRecordRelay } from "./agentHostRemoteRecordRelay.js";
import {
  inWriteTransaction,
  openAgentHostDatabase,
  type SqliteDatabase
} from "./sqliteDatabase.js";

export type {
  AgentHostExecution,
  AgentHostExecutionEvidence,
  AgentHostExecutionStatus
} from "./agentHostStateRecords.js";
export type {
  AgentHostCancellation,
  AgentHostResumption,
  AgentHostStateLimits,
  AgentHostStateRepository
} from "./agentHostStateContract.js";

type MailboxMessageEvent = Extract<ServerEvent, { type: "mailbox.message" }>;

function messageEvent(input: ServerEvent): MailboxMessageEvent {
  const parsed = parseAgentHostServerEvent(input);
  if (parsed.type !== "mailbox.message") throw new Error("mailbox_message_required");
  return parsed;
}

export class AgentHostState implements AgentHostStateRepository {
  private readonly limits: AgentHostStateLimits;
  private readonly executions: AgentHostExecutionRepository;
  private readonly events: AgentHostEventOutbox;
  private readonly remoteRecords: AgentHostRemoteExecutionRecordStore;
  private readonly remoteRelay: AgentHostRemoteRecordRelay;
  private readonly interactions: AgentHostInteractionSettlements;
  private readonly terminalCompaction: AgentHostTerminalCompactionRepository;

  constructor(
    private readonly database: SqliteDatabase,
    limits: Partial<AgentHostStateLimits> = {}
  ) {
    this.limits = Object.fromEntries(
      Object.entries(DEFAULT_AGENT_HOST_STATE_LIMITS).map(([name, fallback]) => [
        name,
        this.parseLimit(limits[name as keyof AgentHostStateLimits] ?? fallback, name)
      ])
    ) as AgentHostStateLimits;
    initializeAgentHostStateSchema(database);
    this.executions = new AgentHostExecutionRepository(database, {
      maxCapabilitiesBytes: this.limits.maxCapabilitiesBytes,
      maxActionsPerExecution: this.limits.maxActionsPerExecution,
      maxArtifactsPerExecution: this.limits.maxArtifactsPerExecution
    });
    this.events = new AgentHostEventOutbox(database, this.limits.maxPendingEvents);
    this.remoteRecords = new AgentHostRemoteExecutionRecordStore(database, {
      requireAuthoritativeExecution: true,
      retention: {
        maxRecordsPerExecution: this.limits.maxRemoteRecordsPerExecution,
        maxRecordBytes: this.limits.maxRemoteRecordBytes
      }
    });
    this.remoteRelay = new AgentHostRemoteRecordRelay(
      this.executions,
      this.events,
      this.remoteRecords
    );
    this.interactions = new AgentHostInteractionSettlements(this.executions, this.events);
    this.terminalCompaction = new AgentHostTerminalCompactionRepository(database);
    this.terminalCompaction.compact();
  }

  close(): void {
    this.database.close();
  }

  receive(input: ServerEvent): { stored: boolean; acknowledgement: HostEvent } {
    const event = messageEvent(input);
    switch (event.command.type) {
      case "execute_block":
      case "cancel_execution":
      case "resume_execution":
        break;
      case "interaction.permission_response":
      case "interaction.elicitation_response":
        break;
      case "interaction.authentication_action":
        break;
    }
    return inWriteTransaction(this.database, () => {
      const commandJson = JSON.stringify(event.command);
      const commandDigest = digestJson(event.command);
      const existing = this.database
        .prepare(
          `SELECT sequence,previous_sequence,message_id,command_digest
           FROM agent_host_inbox WHERE sequence=? OR message_id=?`
        )
        .get(event.sequence, event.messageId);
      let stored = false;
      if (existing) {
        if (
          Number(existing.sequence) !== event.sequence ||
          Number(existing.previous_sequence) !== event.previousSequence ||
          String(existing.message_id) !== event.messageId ||
          String(existing.command_digest) !== commandDigest
        ) {
          throw new Error("mailbox_message_conflict");
        }
      } else if (
        this.terminalCompaction.inspectMailboxReplay(event, commandDigest) === "compacted"
      ) {
        stored = false;
      } else {
        if (event.previousSequence !== this.terminalCompaction.receivedHighWater()) {
          throw new Error("mailbox_message_out_of_order");
        }
        if (this.pendingCommandCount() >= this.limits.maxPendingCommands) {
          throw new Error("agent_host_pending_command_capacity_exceeded");
        }
        const receivedAt = new Date().toISOString();
        this.database
          .prepare(
            `INSERT INTO agent_host_inbox(
              sequence,previous_sequence,message_id,command_json,command_digest,received_at
            ) VALUES(?,?,?,?,?,?)`
          )
          .run(
            event.sequence,
            event.previousSequence,
            event.messageId,
            commandJson,
            commandDigest,
            receivedAt
          );
        this.terminalCompaction.recordReceived(event.sequence);
        if (event.command.type === "execute_block") {
          if (!this.executions.insert(event.sequence, event.command, receivedAt)) {
            this.database
              .prepare("UPDATE agent_host_inbox SET processed_at=? WHERE sequence=?")
              .run(receivedAt, event.sequence);
          }
        }
        if (event.command.type === "resume_execution") {
          const execution = this.executions.findByAttempt(
            event.command.dispatchId,
            event.command.executionAttemptId
          );
          if (!execution) throw new Error("execution_resume_identity_not_found");
          this.executions.authorizeResume(
            execution.sequence,
            {
              leaseId: event.command.leaseId,
              leaseExpiresAt: event.command.leaseExpiresAt,
              priorRecovery: event.command.priorRecovery
            },
            receivedAt
          );
          this.database
            .prepare("UPDATE agent_host_inbox SET processed_at=? WHERE sequence=?")
            .run(receivedAt, event.sequence);
        }
        if (
          event.command.type === "interaction.permission_response" ||
          event.command.type === "interaction.elicitation_response" ||
          event.command.type === "interaction.authentication_action"
        ) {
          this.interactions.settle(event.command, receivedAt);
          this.database
            .prepare("UPDATE agent_host_inbox SET processed_at=? WHERE sequence=?")
            .run(receivedAt, event.sequence);
        }
        stored = true;
      }
      const acknowledgement = this.events.queue(
        `mailbox.ack:${event.sequence}`,
        parseAgentHostEvent({
          type: "mailbox.ack",
          protocolVersion: 1,
          messageId: randomUUID(),
          sequence: event.sequence
        })
      );
      return { stored, acknowledgement };
    });
  }

  lastAcknowledgedSequence(): number {
    return this.terminalCompaction.lastAcknowledgedSequence();
  }

  pendingEvents(limit = this.limits.maxPendingEvents): HostEvent[] {
    return this.events.pending(limit);
  }

  pendingEventCount(): number {
    return this.events.pendingCount();
  }

  queueHeartbeat(
    activeLeases: ReadonlyArray<AgentHostRemoteExecutionIdentity>,
    readiness?: HostReadinessObservation
  ): HostEvent {
    return inWriteTransaction(this.database, () =>
      this.events.queueHeartbeat(activeLeases, readiness)
    );
  }

  acknowledgeEvent(messageId: string): boolean {
    return inWriteTransaction(this.database, () => {
      const acknowledgement = this.events.acknowledge(messageId);
      if (!acknowledgement.found) return false;
      if (acknowledgement.alreadyAcknowledged) return true;
      if (acknowledgement.event.type === "mailbox.ack") {
        this.database
          .prepare(
            "UPDATE agent_host_inbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE sequence=?"
          )
          .run(acknowledgement.acknowledgedAt, acknowledgement.event.sequence);
        this.terminalCompaction.recordAcknowledged(acknowledgement.event.sequence);
      }
      this.executions.acknowledgeTerminalEvent(messageId, acknowledgement.acknowledgedAt);
      this.terminalCompaction.compactInCurrentTransaction();
      return true;
    });
  }

  recoverInterruptedExecutions(): number {
    return inWriteTransaction(this.database, () => {
      const ambiguous = this.executions.list([
        "accepted",
        "preparing",
        "running",
        "interaction_wait"
      ]);
      for (const execution of ambiguous) {
        this.executions.transition(execution.sequence, "interrupted", "host_restart");
        const evidence = this.executions.evidence(execution.sequence);
        if (!evidence) throw new Error("execution_evidence_not_found");
        this.events.queue(
          `dispatch.interrupted:${evidence.dispatchId}:${evidence.leaseId}:${evidence.executionAttemptId}`,
          createInterruptedEvent(evidence, "host_restart")
        );
      }
      return ambiguous.length;
    });
  }

  recoverableExecutionCount(): number {
    return this.executions.list([
      "accepted",
      "preparing",
      "running",
      "interaction_wait",
      "interrupted"
    ]).length;
  }

  pendingExecutions(limit: number): AgentHostExecution[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_execution_limit");
    return this.executions.list(["accepted"], limit);
  }

  executionEvidence(sequence: number): AgentHostExecutionEvidence | undefined {
    return this.executions.evidence(sequence);
  }

  activeLeases(): AgentHostRemoteExecutionIdentity[] {
    return this.executions
      .list(["accepted", "preparing", "running", "interaction_wait"])
      .map(({ command }) => ({
        dispatchId: command.dispatchId,
        leaseId: command.leaseId,
        executionAttemptId: command.executionAttemptId
      }));
  }

  renewLease(
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    leaseExpiresAt: string
  ): boolean {
    const parsedExpiry = z.string().datetime().parse(leaseExpiresAt);
    const execution = this.executions
      .list(["accepted", "preparing", "running", "interaction_wait"])
      .find(
        ({ command }) =>
          command.dispatchId === dispatchId &&
          command.leaseId === leaseId &&
          command.executionAttemptId === executionAttemptId
      );
    if (!execution) return false;
    this.executions.renewLease(execution.sequence, parsedExpiry);
    return true;
  }

  abandonExpiredExecutions(now: Date): AgentHostExecution[] {
    return inWriteTransaction(this.database, () => {
      const expired = this.executions
        .list(["accepted", "preparing", "running", "interaction_wait"])
        .filter(({ command }) => Date.parse(command.leaseExpiresAt) <= now.getTime());
      for (const execution of expired) {
        if (execution.status !== "accepted") {
          const priorIntent = this.executions.evidence(execution.sequence)?.recoveryIntent;
          this.executions.replaceRecoveryIntent(execution.sequence, {
            kind: "lease_lost",
            actionRequired: true,
            ...(priorIntent === undefined ? {} : { priorIntent })
          });
          this.executions.transition(execution.sequence, "interrupted", "lease_expired");
          const evidence = this.executions.evidence(execution.sequence);
          if (!evidence) throw new Error("execution_evidence_not_found");
          this.events.queue(
            `dispatch.interrupted:${evidence.dispatchId}:${evidence.leaseId}:${evidence.executionAttemptId}`,
            createInterruptedEvent(evidence, "lease_lost")
          );
          continue;
        }
        const failure = {
          code: "execution_lease_expired",
          message: "The execution lease expired before local execution started.",
          retryable: false
        } as const;
        this.finishExecution(
          execution.sequence,
          "failed",
          () => this.failedEvent(execution.command, failure),
          failure,
          false
        );
      }
      return expired;
    });
  }

  pendingCancellations(): AgentHostCancellation[] {
    return this.database
      .prepare(
        `SELECT sequence,message_id,command_json FROM agent_host_inbox
         WHERE processed_at IS NULL ORDER BY sequence ASC`
      )
      .all()
      .flatMap((raw) => {
        const command = parseAgentHostMailboxCommand(JSON.parse(String(raw.command_json)));
        return command.type === "cancel_execution"
          ? [{ sequence: Number(raw.sequence), messageId: String(raw.message_id), command }]
          : [];
      });
  }

  applyCancellation(sequence: number): { shouldAbort: boolean } {
    return inWriteTransaction(this.database, () => {
      const raw = this.database
        .prepare("SELECT command_json,processed_at FROM agent_host_inbox WHERE sequence=?")
        .get(sequence);
      if (!raw) throw new Error("mailbox_message_not_found");
      const cancellation = parseAgentHostMailboxCommand(JSON.parse(String(raw.command_json)));
      if (cancellation.type !== "cancel_execution") throw new Error("cancel_execution_required");
      if (raw.processed_at) return { shouldAbort: false };
      const execution = this.executions
        .list(["accepted", "preparing", "running", "interaction_wait", "interrupted"])
        .find(
          ({ command }) =>
            command.dispatchId === cancellation.dispatchId &&
            command.leaseId === cancellation.leaseId &&
            command.executionAttemptId === cancellation.executionAttemptId
        );
      this.database
        .prepare("UPDATE agent_host_inbox SET processed_at=? WHERE sequence=?")
        .run(new Date().toISOString(), sequence);
      if (!execution) return { shouldAbort: false };
      this.executions.setIntent(execution.sequence, "cancellation", {
        reason: cancellation.reason,
        commandSequence: sequence
      });
      if (execution.status === "accepted") {
        const failure = {
          code: "execution_cancelled",
          message: "The execution was cancelled by the coordinator.",
          retryable: false
        } as const;
        this.finishExecution(
          execution.sequence,
          "cancelled",
          () => this.failedEvent(execution.command, failure),
          failure,
          false
        );
        return { shouldAbort: false };
      }
      if (execution.status === "interrupted") {
        const failure = {
          code: "execution_cancelled",
          message: "The interrupted execution was cancelled by the coordinator.",
          retryable: false
        } as const;
        this.finishExecution(
          execution.sequence,
          "cancelled",
          () => this.failedEvent(execution.command, failure),
          failure,
          false
        );
        return { shouldAbort: false };
      }
      return {
        shouldAbort: new Set(["preparing", "running", "interaction_wait"]).has(execution.status)
      };
    });
  }

  pendingResumptions(limit: number): AgentHostExecution[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_execution_limit");
    return this.executions
      .list(["preparing"])
      .filter((execution) => {
        const intent = this.executions.evidence(execution.sequence)?.recoveryIntent;
        return (
          typeof intent === "object" &&
          intent !== null &&
          !Array.isArray(intent) &&
          intent.kind === "resume_same_session"
        );
      })
      .slice(0, limit);
  }

  startResumption(sequence: number): AgentHostResumption | undefined {
    return inWriteTransaction(this.database, () => {
      const current = this.executions.get(sequence);
      const evidence = this.executions.evidence(sequence);
      if (!current || !evidence) throw new Error("mailbox_message_not_found");
      if (current.status !== "preparing") return undefined;
      if (!evidence.acpSessionId) throw new Error("execution_resume_session_missing");
      const running = this.executions.transition(sequence, "running", "session_load_invoked");
      this.events.queue(
        `dispatch.accepted:${running.command.dispatchId}:${running.command.leaseId}:${running.command.executionAttemptId}`,
        parseAgentHostEvent({
          type: "dispatch.accepted",
          protocolVersion: 1,
          messageId: randomUUID(),
          dispatchId: running.command.dispatchId,
          leaseId: running.command.leaseId,
          executionAttemptId: running.command.executionAttemptId
        })
      );
      return { execution: running, sessionId: evidence.acpSessionId };
    });
  }

  failResumption(sequence: number): void {
    inWriteTransaction(this.database, () => {
      this.executions.markResumeFailed(sequence);
      const evidence = this.executions.evidence(sequence);
      if (!evidence) throw new Error("execution_evidence_not_found");
      this.events.queue(
        `dispatch.interrupted:${evidence.dispatchId}:${evidence.leaseId}:${evidence.executionAttemptId}`,
        createInterruptedEvent(evidence, "acp_session_lost", true)
      );
    });
  }

  startExecution(sequence: number): AgentHostExecution | undefined {
    return inWriteTransaction(this.database, () => {
      const current = this.executions.get(sequence);
      if (!current) throw new Error("mailbox_message_not_found");
      if (current.status !== "accepted") return undefined;
      this.executions.transition(sequence, "preparing", "worker_claimed");
      const running = this.executions.transition(sequence, "running", "executor_invoked");
      this.events.queue(
        `dispatch.accepted:${running.command.dispatchId}:${running.command.leaseId}:${running.command.executionAttemptId}`,
        parseAgentHostEvent({
          type: "dispatch.accepted",
          protocolVersion: 1,
          messageId: randomUUID(),
          dispatchId: running.command.dispatchId,
          leaseId: running.command.leaseId,
          executionAttemptId: running.command.executionAttemptId
        })
      );
      return running;
    });
  }

  completeExecution(sequence: number, result: ProtocolDispatchResult): void {
    this.finishExecution(
      sequence,
      "completed",
      (command) =>
        parseAgentHostEvent({
          type: "dispatch.completed",
          protocolVersion: 1,
          messageId: randomUUID(),
          dispatchId: command.dispatchId,
          leaseId: command.leaseId,
          executionAttemptId: command.executionAttemptId,
          result
        }),
      result
    );
  }

  failExecution(sequence: number, failure: ProtocolDispatchFailure): void {
    const evidence = this.executions.evidence(sequence);
    const status = evidence?.cancellationIntent === undefined ? "failed" : "cancelled";
    this.finishExecution(
      sequence,
      status,
      (command) => this.failedEvent(command, failure),
      failure
    );
  }

  recordSessionEvidence(sequence: number, input: unknown): AgentHostExecutionEvidence {
    return inWriteTransaction(this.database, () => this.executions.recordSession(sequence, input));
  }

  advanceEventCursor(sequence: number, afterCursor: number, cursor: number): number {
    return inWriteTransaction(this.database, () =>
      this.executions.advanceEventCursor(sequence, afterCursor, cursor)
    );
  }

  recordInteractionAction(sequence: number, input: unknown): boolean {
    return inWriteTransaction(this.database, () => this.executions.recordAction(sequence, input));
  }

  settleInteractionAction(
    sequence: number,
    input: { leaseId: string; sessionId: string; actionId: string; response: unknown }
  ): boolean {
    return inWriteTransaction(this.database, () => this.executions.settleAction(sequence, input));
  }

  recordArtifactTransfer(sequence: number, leaseId: string, input: unknown): boolean {
    return inWriteTransaction(this.database, () => {
      const evidence = this.executions.evidence(sequence);
      if (!evidence) throw new Error("execution_not_found");
      if (evidence.leaseId !== leaseId) throw new Error("execution_artifact_stale_lease");
      return this.executions.recordArtifact(sequence, input);
    });
  }

  append(record: AgentHostRemoteExecutionRecord): void {
    inWriteTransaction(this.database, () => {
      if (!this.remoteRecords.appendInCurrentTransaction(record)) return;
      this.remoteRelay.relay(record);
    });
  }

  records(identity: AgentHostRemoteExecutionIdentity): AgentHostRemoteExecutionRecord[] {
    return this.remoteRecords.records(identity);
  }

  interactionSettlement(command: InteractionSettlement): unknown | undefined {
    return this.interactions.get(command);
  }

  interactionSettlementByIdentity(
    identity: AgentHostInteractionIdentity
  ): InteractionSettlement | undefined {
    return this.interactions.get(identity);
  }

  async importLegacyRemoteExecutionStore(
    path: string
  ): Promise<{ imported: number; replayed: number; sourcePresent: boolean }> {
    const records = await readLegacyRemoteExecutionRecords(path);
    if (records === undefined) return { imported: 0, replayed: 0, sourcePresent: false };
    return inWriteTransaction(this.database, () => {
      let imported = 0;
      let replayed = 0;
      for (const record of records) {
        if (this.remoteRecords.appendInCurrentTransaction(record)) imported += 1;
        else replayed += 1;
      }
      return { imported, replayed, sourcePresent: true };
    });
  }

  private finishExecution(
    sequence: number,
    status: "completed" | "failed" | "cancelled",
    createEvent: (command: ExecuteBlockCommand) => HostEvent,
    payload: ProtocolDispatchResult | ProtocolDispatchFailure,
    transaction = true
  ): void {
    const finish = () => {
      const current = this.executions.get(sequence);
      if (!current) throw new Error("mailbox_message_not_found");
      const eventType = status === "completed" ? "dispatch.completed" : "dispatch.failed";
      const event = this.events.queue(
        `${eventType}:${current.command.dispatchId}:${current.command.leaseId}:${current.command.executionAttemptId}`,
        createEvent(current.command)
      );
      this.executions.finish(sequence, status, payload, event.messageId);
    };
    if (transaction) inWriteTransaction(this.database, finish);
    else finish();
  }

  private failedEvent(command: ExecuteBlockCommand, failure: ProtocolDispatchFailure): HostEvent {
    return parseAgentHostEvent({
      type: "dispatch.failed",
      protocolVersion: 1,
      messageId: randomUUID(),
      dispatchId: command.dispatchId,
      leaseId: command.leaseId,
      executionAttemptId: command.executionAttemptId,
      failure
    });
  }

  private pendingCommandCount(): number {
    const executions = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_host_executions
         WHERE status IN ('accepted','preparing','running','interaction_wait','interrupted')`
      )
      .get();
    const commands = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_host_inbox i
         WHERE i.processed_at IS NULL
           AND NOT EXISTS(SELECT 1 FROM agent_host_executions e WHERE e.inbox_sequence=i.sequence)`
      )
      .get();
    return Number(executions?.count ?? 0) + Number(commands?.count ?? 0);
  }

  private parseLimit(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`agent_host_${name}_limit_invalid`);
    }
    return value;
  }
}

export async function openAgentHostState(
  path: string,
  busyTimeoutMs = 5_000,
  limits: Partial<AgentHostStateLimits> = {}
): Promise<AgentHostState> {
  return new AgentHostState(await openAgentHostDatabase(path, busyTimeoutMs), limits);
}
