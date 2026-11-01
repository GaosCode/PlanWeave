import { remoteAcpEngineFragment } from "../execution/remoteAcpEngineFragment.js";
import { remoteRunnerWireChunks } from "../execution/remoteRunnerWireChunks.js";
import {
  remoteRunnerEventBatchV2Schema,
  dispatchLifecycleIdentitySchema,
  mailboxMessageIdSchema,
  type RemoteRunnerEventFragment
} from "@planweave-ai/agent-host-protocol";
import { randomUUID } from "node:crypto";
import type { AgentHostRemoteExecutionRecord } from "../execution/remoteAcpPorts.js";
import { parseAgentHostEvent, isHostEventPayloadTooLarge, type HostEvent } from "../protocol.js";
import { AgentHostEventOutbox } from "./agentHostEventOutbox.js";
import { AgentHostExecutionRepository } from "./agentHostExecutionRepository.js";
import { digestJson } from "./agentHostStateMigrations.js";
import { AgentHostRemoteExecutionRecordStore } from "./remoteExecutionOutbox.js";

function boundedText(value: unknown, maxLength: number): string {
  return String(value ?? "").slice(0, maxLength);
}

export class AgentHostRemoteRecordRelay {
  private eventProtocolVersion?: 2;

  constructor(
    private readonly executions: AgentHostExecutionRepository,
    private readonly events: AgentHostEventOutbox,
    private readonly remoteRecords: AgentHostRemoteExecutionRecordStore
  ) {}

  setEventProtocolVersion(version: 2): void {
    this.eventProtocolVersion = version;
  }

  private protocolVersionFor(
    execution: NonNullable<ReturnType<AgentHostExecutionRepository["findByIdentity"]>>
  ): 1 | 2 | undefined {
    return (
      this.executions.evidence(execution.sequence)?.eventProtocolVersion ??
      this.eventProtocolVersion
    );
  }

  private relayV2(execution: ReturnType<AgentHostExecutionRepository["findByIdentity"]>): void {
    if (!execution) throw new Error("remote_execution_identity_not_found");
    const evidence = this.executions.evidence(execution.sequence);
    if (!evidence?.acpSessionId) return;
    if (this.executions.pinEventProtocolVersion(execution.sequence, 2) !== 2) {
      throw new Error("execution_event_protocol_version_conflict");
    }
    const identity = {
      dispatchId: evidence.dispatchId,
      leaseId: evidence.leaseId,
      executionAttemptId: evidence.executionAttemptId
    };
    // The cursor and its durable wire event commit together; ACK keeps that event
    // until terminal compaction removes the execution and its source records.
    const checkpoint = this.events.remoteEngineCheckpoint(identity, evidence.eventCursor);
    let afterSequence = checkpoint
      ? this.remoteRecords.storageSequence(checkpoint.identity, checkpoint.sourceSequence)
      : 0;
    const upperSequence = this.remoteRecords.upperStorageSequence(identity);
    while (afterSequence < upperSequence) {
      const pending = this.remoteRecords.engineRecordsBetween(
        identity,
        afterSequence,
        upperSequence,
        256
      );
      if (pending.length === 0) break;
      for (const { storageSequence, record } of pending) {
        const current = this.executions.evidence(execution.sequence);
        if (!current?.acpSessionId) throw new Error("remote_execution_session_identity_stale");
        const acpSessionId = current.acpSessionId;
        const createEvent = (fragment: RemoteRunnerEventFragment, index: number): HostEvent => {
          const afterCursor = current.eventCursor + index;
          const cursor = afterCursor + 1;
          return {
            type: "acp.events",
            protocolVersion: 1,
            eventProtocolVersion: 2,
            messageId: mailboxMessageIdSchema.parse(randomUUID()),
            ...dispatchLifecycleIdentitySchema.parse(record.identity),
            acpSessionId,
            afterCursor,
            cursor,
            events: [
              {
                eventVersion: 2,
                cursor,
                sourceSequence: record.event.sequence,
                timestamp: record.event.timestamp,
                fragment
              }
            ]
          };
        };
        const chunks = remoteRunnerWireChunks(
          remoteAcpEngineFragment(record.event),
          (fragment, index) => {
            const event = createEvent(fragment, index);
            if (
              !remoteRunnerEventBatchV2Schema.safeParse(
                event.type === "acp.events"
                  ? {
                      type: event.type,
                      eventProtocolVersion: event.eventProtocolVersion,
                      dispatchId: event.dispatchId,
                      leaseId: event.leaseId,
                      executionAttemptId: event.executionAttemptId,
                      acpSessionId: event.acpSessionId,
                      afterCursor: event.afterCursor,
                      cursor: event.cursor,
                      events: event.events
                    }
                  : event
              ).success
            )
              return false;
            try {
              this.events.encode(event);
              return true;
            } catch (error) {
              if (isHostEventPayloadTooLarge(error)) return false;
              throw error;
            }
          }
        );
        chunks.forEach((fragment, index) => {
          const event = createEvent(fragment, index);
          if (event.type !== "acp.events") throw new Error("remote_runner_event_required");
          this.events.queue(
            `acp.events.v2:${record.identity.dispatchId}:${record.identity.executionAttemptId}:${event.cursor}`,
            event
          );
          this.executions.advanceEventCursor(execution.sequence, event.afterCursor, event.cursor);
        });
        afterSequence = storageSequence;
      }
    }
  }

  relay(record: AgentHostRemoteExecutionRecord): void {
    const execution = this.executions.findByIdentity(record.identity);
    if (!execution) throw new Error("remote_execution_identity_not_found");
    if (record.kind === "engine_event") {
      if (this.protocolVersionFor(execution) !== 2) {
        throw new Error("remote_runner_event_v2_required");
      }
      if (record.event.kind === "session_started") {
        const capabilitySnapshot = this.remoteRecords.capabilitySnapshot(record.identity);
        if (
          !capabilitySnapshot ||
          capabilitySnapshot.kind !== "engine_event" ||
          capabilitySnapshot.event.kind !== "capability_snapshot"
        ) {
          throw new Error("remote_execution_capability_snapshot_missing");
        }
        this.executions.recordSession(execution.sequence, {
          sessionId: record.event.sessionId,
          capabilitySnapshot: capabilitySnapshot.event.snapshot,
          recoveryId: `recovery:${digestJson({
            dispatchId: record.identity.dispatchId,
            executionAttemptId: record.identity.executionAttemptId,
            acpSessionId: record.event.sessionId
          }).slice("sha256:".length)}`
        });
        this.relayV2(execution);
        return;
      }
      if (record.event.kind === "interaction" && record.event.state === "resolved") {
        if (execution.status === "interaction_wait") {
          this.executions.transition(execution.sequence, "running", "interaction_delivered");
        }
      }
      if (record.event.kind === "session_update") {
        const evidence = this.executions.evidence(execution.sequence);
        if (!evidence?.acpSessionId || evidence.acpSessionId !== record.event.sessionId) {
          throw new Error("remote_execution_session_identity_stale");
        }
      }
      this.relayV2(execution);
      return;
    }

    const sessionId = record.request.sessionId;
    if (!sessionId) throw new Error("remote_interaction_session_required");
    const evidence = this.executions.evidence(execution.sequence);
    if (!evidence?.acpSessionId || evidence.acpSessionId !== sessionId) {
      throw new Error("remote_interaction_session_identity_stale");
    }
    const actionKind = record.kind === "permission_request" ? "permission" : "elicitation";
    const actionId = record.request.requestId;
    this.executions.recordAction(execution.sequence, {
      leaseId: record.identity.leaseId,
      sessionId,
      actionId,
      kind: actionKind,
      deadline: record.deadline,
      requestDigest: digestJson(record.request),
      afterCursor: evidence.actionCursor,
      cursor: evidence.actionCursor + 1
    });
    if (execution.status === "running") {
      this.executions.transition(execution.sequence, "interaction_wait", "interaction_requested");
    }
    const common = {
      protocolVersion: 1 as const,
      messageId: randomUUID(),
      ...record.identity,
      acpSessionId: sessionId,
      actionId,
      expiresAt: record.deadline
    };
    const event =
      record.kind === "permission_request"
        ? parseAgentHostEvent({
            ...common,
            type: "interaction.permission_requested",
            title: boundedText(record.request.summary, 512) || "ACP permission requested",
            description: boundedText(record.request.summary, 16_384),
            options: record.request.options
          })
        : parseAgentHostEvent({
            ...common,
            type: "interaction.elicitation_requested",
            prompt: boundedText(record.request.message, 16_384) || "ACP input requested",
            options: []
          });
    this.events.queue(
      `${event.type}:${record.identity.dispatchId}:${record.identity.executionAttemptId}:${actionId}`,
      event
    );
  }
}
