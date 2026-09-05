import { remoteAcpEngineFragment } from "../execution/remoteAcpEngineFragment.js";
import { randomUUID } from "node:crypto";
import type { AgentHostRemoteExecutionRecord } from "../execution/remoteAcpPorts.js";
import { parseAgentHostEvent } from "../protocol.js";
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
    const records = this.remoteRecords.records({
      dispatchId: evidence.dispatchId,
      leaseId: evidence.leaseId,
      executionAttemptId: evidence.executionAttemptId
    });
    const engineRecords = records.filter(
      (candidate): candidate is Extract<AgentHostRemoteExecutionRecord, { kind: "engine_event" }> =>
        candidate.kind === "engine_event"
    );
    const pending = engineRecords.slice(evidence.eventCursor);
    for (const record of pending) {
      const current = this.executions.evidence(execution.sequence);
      if (!current?.acpSessionId) throw new Error("remote_execution_session_identity_stale");
      const afterCursor = current.eventCursor;
      const cursor = afterCursor + 1;
      this.executions.advanceEventCursor(execution.sequence, afterCursor, cursor);
      this.events.queue(
        `acp.events.v2:${record.identity.dispatchId}:${record.identity.executionAttemptId}:${cursor}`,
        parseAgentHostEvent({
          type: "acp.events",
          protocolVersion: 1,
          eventProtocolVersion: 2,
          messageId: randomUUID(),
          ...record.identity,
          acpSessionId: current.acpSessionId,
          afterCursor,
          cursor,
          events: [
            {
              eventVersion: 2,
              cursor,
              sourceSequence: record.event.sequence,
              timestamp: record.event.timestamp,
              fragment: remoteAcpEngineFragment(record.event)
            }
          ]
        })
      );
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
        const capabilitySnapshot = this.remoteRecords
          .records(record.identity)
          .find(
            (candidate) =>
              candidate.kind === "engine_event" && candidate.event.kind === "capability_snapshot"
          );
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
            description: boundedText(record.request.summary, 16_384)
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
