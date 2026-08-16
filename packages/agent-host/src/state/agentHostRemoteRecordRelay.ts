import { randomUUID } from "node:crypto";
import type { NormalizedAcpEvent } from "@planweave-ai/agent-host-protocol";
import type { AgentHostRemoteExecutionRecord } from "../execution/remoteAcpPorts.js";
import { parseAgentHostEvent } from "../protocol.js";
import { AgentHostEventOutbox } from "./agentHostEventOutbox.js";
import { AgentHostExecutionRepository } from "./agentHostExecutionRepository.js";
import { digestJson } from "./agentHostStateMigrations.js";
import { AgentHostRemoteExecutionRecordStore } from "./remoteExecutionOutbox.js";

function boundedText(value: unknown, maxLength: number): string {
  return String(value ?? "").slice(0, maxLength);
}

function normalizedProtocolEvent(
  body: Record<string, unknown>,
  cursor: number
): NormalizedAcpEvent | undefined {
  switch (body.kind) {
    case "message":
      return body.role === "assistant"
        ? { cursor, kind: "agent_message", text: boundedText(body.content, 16_384) }
        : undefined;
    case "tool_call":
    case "tool_update": {
      const status =
        body.status === "in_progress"
          ? "running"
          : body.status === "completed" || body.status === "failed"
            ? body.status
            : body.status === "cancelled"
              ? "failed"
              : "pending";
      return {
        cursor,
        kind: "tool_call",
        ...(typeof body.callId === "string" && body.callId !== ""
          ? { callId: boundedText(body.callId, 256) }
          : {}),
        title: boundedText(body.title ?? body.callId ?? "ACP tool", 512) || "ACP tool",
        status
      };
    }
    case "plan_update":
      return { cursor, kind: "plan", text: boundedText(body.content, 16_384) };
    case "diagnostic":
      return {
        cursor,
        kind: "diagnostic",
        severity: "warning",
        message: boundedText(body.message, 16_384)
      };
    default:
      return undefined;
  }
}

export class AgentHostRemoteRecordRelay {
  constructor(
    private readonly executions: AgentHostExecutionRepository,
    private readonly events: AgentHostEventOutbox,
    private readonly remoteRecords: AgentHostRemoteExecutionRecordStore
  ) {}

  relay(record: AgentHostRemoteExecutionRecord): void {
    const execution = this.executions.findByIdentity(record.identity);
    if (!execution) throw new Error("remote_execution_identity_not_found");
    if (record.kind === "engine_event") {
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
        return;
      }
      if (record.event.kind === "interaction" && record.event.state === "resolved") {
        if (execution.status === "interaction_wait") {
          this.executions.transition(execution.sequence, "running", "interaction_delivered");
        }
        return;
      }
      if (record.event.kind !== "session_update") return;
      const evidence = this.executions.evidence(execution.sequence);
      if (!evidence?.acpSessionId || evidence.acpSessionId !== record.event.sessionId) {
        throw new Error("remote_execution_session_identity_stale");
      }
      const afterCursor = evidence.eventCursor;
      const event = normalizedProtocolEvent(record.event.body, afterCursor + 1);
      if (!event) return;
      this.executions.advanceEventCursor(execution.sequence, afterCursor, event.cursor);
      this.events.queue(
        `acp.events:${record.identity.dispatchId}:${record.identity.executionAttemptId}:${event.cursor}`,
        parseAgentHostEvent({
          type: "acp.events",
          protocolVersion: 1,
          messageId: randomUUID(),
          ...record.identity,
          acpSessionId: evidence.acpSessionId,
          afterCursor,
          cursor: event.cursor,
          events: [event]
        })
      );
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
