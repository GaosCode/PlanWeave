import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acpConversationPromptCommandSchema,
  acpConversationEventSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeResponsePayloadSchema,
  exampleExecuteDelivery,
  exampleExecutionEnvelopeInput,
  hostEventSchema
} from "@planweave-ai/agent-host-protocol";
import { encodeHistoricalAgentHostEvent, parseHistoricalAgentHostEvent } from "../protocol.js";
import { AgentHostEventOutbox } from "../state/agentHostEventOutbox.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { assertHostOutboundControlBudget } from "../transport/hostOutboundControlBudget.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";

const fixtures: { directory: string; state: AgentHostState }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.state.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup(bytes = 64 * 1024) {
  const directory = await mkdtemp(join(tmpdir(), "host-wire-budget-"));
  const path = join(directory, "host.sqlite");
  const state = await openAgentHostState(path);
  fixtures.push({ directory, state });
  state.setHostEventMaxPayloadBytes(bytes);
  const delivery = {
    ...exampleExecuteDelivery,
    command: { ...exampleExecuteDelivery.command, leaseExpiresAt: "2099-01-01T00:00:00.000Z" }
  };
  state.receive(delivery);
  state.startExecution(delivery.sequence);
  const { dispatchId, leaseId, executionAttemptId } = delivery.command;
  return {
    state,
    path,
    directory,
    identity: { dispatchId, leaseId, executionAttemptId },
    delivery
  };
}
async function seed(bytes = 64 * 1024) {
  const f = await setup(bytes);
  f.state.setRemoteRunnerEventProtocolVersion(2);
  f.state.append({
    kind: "engine_event",
    identity: f.identity,
    event: {
      kind: "capability_snapshot",
      sequence: 1,
      timestamp: new Date().toISOString(),
      snapshot: acpCapabilitySnapshotTestValue()
    }
  });
  f.state.append({
    kind: "engine_event",
    identity: f.identity,
    event: {
      kind: "session_started",
      sequence: 2,
      timestamp: new Date().toISOString(),
      sessionId: "wire-session",
      loaded: false
    }
  });
  return f;
}
const emptyReadiness = { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] };
const artifact = `artifact:sha256:${"a".repeat(64)}`;

describe("Host complete wire frame admission", () => {
  it.each([
    -1, 0, 1
  ])("admits public outbox only through the actual UTF-8 budget boundary %+i", async (delta) => {
    const f = await setup();
    const database = await openAgentHostDatabase(f.path, 5000);
    try {
      const outbox = new AgentHostEventOutbox(database, 100);
      const event = hostEventSchema.parse({
        type: "dispatch.failed",
        protocolVersion: 1,
        messageId: "m".repeat(128),
        dispatchId: "d".repeat(128),
        leaseId: "l".repeat(128),
        executionAttemptId: "e".repeat(128),
        failure: { code: "boundary", message: `中"\\\n\u0000${"x".repeat(100)}`, retryable: false }
      });
      const bytes = Buffer.byteLength(JSON.stringify(event));
      outbox.setMaxPayloadBytes(bytes + delta);
      if (delta < 0) {
        expect(() => outbox.queue("boundary", event)).toThrow(
          "agent_host_outbound_payload_too_large"
        );
        expect(outbox.pending().some((entry) => entry.messageId === event.messageId)).toBe(false);
      } else {
        expect(outbox.queue("boundary", event)).toEqual(event);
        expect(outbox.pending().find((entry) => entry.messageId === event.messageId)).toEqual(
          event
        );
      }
    } finally {
      database.close();
    }
  });

  it.each([
    "completed",
    "failed"
  ] as const)("converges oversized execution %s to an ACKable failure", async (kind) => {
    const f = await setup();
    if (kind === "completed")
      f.state.completeExecution(f.delivery.sequence, f.identity, {
        summary: "\u0000".repeat(16384),
        reportArtifactRef: artifact,
        artifactRefs: []
      });
    else
      f.state.failExecution(f.delivery.sequence, f.identity, {
        code: "executor_failed",
        message: "\u0000".repeat(16384),
        retryable: false
      });
    const event = f.state.pendingEvents().find((entry) => entry.type === "dispatch.failed");
    expect(event).toMatchObject({ failure: { code: "agent_host_outbound_payload_too_large" } });
    expect(f.state.executionEvidence(f.delivery.sequence)?.status).toBe("failed");
    for (const pending of f.state.pendingEvents()) f.state.acknowledgeEvent(pending.messageId);
    expect(f.state.pendingEvents()).toEqual([]);
  });

  it.each([
    "elicitation",
    "snapshot",
    "terminal"
  ] as const)("rolls back the entire source record and cursors for indivisible %s", async (kind) => {
    const f = await seed();
    const beforeRecords = f.state.records(f.identity);
    const beforeEvidence = f.state.executionEvidence(f.delivery.sequence);
    const beforeEvents = f.state.pendingEvents();
    const record =
      kind === "elicitation"
        ? {
            kind: "elicitation_request" as const,
            identity: f.identity,
            deadline: "2099-01-01T00:00:00.000Z",
            request: {
              requestId: "huge",
              sessionId: "wire-session",
              message: "\u0000".repeat(16384),
              requestedSchema: {}
            }
          }
        : {
            kind: "engine_event" as const,
            identity: f.identity,
            event:
              kind === "terminal"
                ? {
                    kind: "terminal" as const,
                    sequence: 3,
                    timestamp: new Date().toISOString(),
                    terminal: {
                      state: "failed" as const,
                      reason: "protocol_error" as const,
                      message: "\u0000".repeat(20000)
                    }
                  }
                : {
                    kind: "session_update" as const,
                    sessionId: "wire-session",
                    sequence: 3,
                    timestamp: new Date().toISOString(),
                    body: {
                      kind: "message" as const,
                      role: "assistant" as const,
                      messageId: "existing-message",
                      chunk: false,
                      content: "\u0000".repeat(20000),
                      redaction: { classes: [], replaced: 0 }
                    }
                  }
          };
    expect(() => f.state.append(record)).toThrow("agent_host_outbound_payload_too_large");
    expect(f.state.records(f.identity)).toEqual(beforeRecords);
    expect(f.state.executionEvidence(f.delivery.sequence)).toEqual(beforeEvidence);
    expect(f.state.pendingEvents()).toEqual(beforeEvents);
    f.state.failExecution(f.delivery.sequence, f.identity, {
      code: "event_failed",
      message: "Wire admission failed.",
      retryable: false
    });
    expect(f.state.pendingEvents().at(-1)).toMatchObject({ type: "dispatch.failed" });
  });

  it.each([
    "output",
    "terminal_output",
    "message"
  ] as const)("persists ordered lossless %s chunks and replays remaining chunks after partial ACK/restart", async (kind) => {
    const f = await seed();
    const prefix = '中😀"\\\n\u0000'.repeat(100);
    let content = prefix;
    const body =
      kind === "message"
        ? {
            kind,
            role: "assistant" as const,
            messageId: "same-id",
            chunk: true,
            content,
            redaction: { classes: [], replaced: 0 }
          }
        : kind === "terminal_output"
          ? { kind, terminalId: "terminal", content, redaction: { classes: [], replaced: 0 } }
          : { kind, stream: "stdout" as const, content, redaction: { classes: [], replaced: 0 } };
    const source = {
      kind: "engine_event" as const,
      identity: f.identity,
      event: {
        kind: "session_update" as const,
        sessionId: "wire-session",
        sequence: 3,
        timestamp: new Date().toISOString(),
        body
      }
    };
    const previous = f.state
      .pendingEvents()
      .slice()
      .reverse()
      .find((event) => event.type === "acp.events");
    if (!previous || previous.type !== "acp.events") throw new Error("expected_acp_events");
    const probe = {
      ...previous,
      afterCursor: 2,
      cursor: 3,
      events: [
        {
          eventVersion: 2,
          cursor: 3,
          sourceSequence: 3,
          timestamp: source.event.timestamp,
          fragment: { kind: "runner_body", body }
        }
      ]
    };
    content += `${"a".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(probe)) - 1)}xtoken=value`;
    body.content = content;
    expect(hostEventSchema.safeParse(probe).success).toBe(true);
    f.state.append(source);
    const chunks = f.state
      .pendingEvents()
      .filter((entry) => entry.type === "acp.events" && entry.events[0]?.sourceSequence === 3);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((event) => hostEventSchema.safeParse(event).success)).toBe(true);
    expect(
      chunks
        .flatMap((entry) => entry.events)
        .map((entry) =>
          entry.fragment.kind === "runner_body" && "content" in entry.fragment.body
            ? entry.fragment.body.content
            : ""
        )
        .join("")
    ).toBe(content);
    expect(chunks.map((entry) => entry.cursor)).toEqual(
      chunks.map((_, index) => chunks[0]!.cursor + index)
    );
    expect(chunks.every((entry) => Buffer.byteLength(JSON.stringify(entry)) <= 64 * 1024)).toBe(
      true
    );
    expect(
      f.state
        .records(f.identity)
        .filter((entry) => entry.kind === "engine_event" && entry.event.sequence === 3)
    ).toEqual([source]);
    const first = chunks[0]!;
    f.state.acknowledgeEvent(first.messageId);
    const remaining = f.state.pendingEvents();
    f.state.close();
    fixtures.splice(
      fixtures.findIndex((entry) => entry.state === f.state),
      1
    );
    const reopened = await openAgentHostState(f.path);
    fixtures.push({ directory: f.directory, state: reopened });
    reopened.setHostEventMaxPayloadBytes(64 * 1024);
    expect(reopened.pendingEvents()).toEqual(remaining);
    reopened.append(source);
    expect(reopened.pendingEvents()).toEqual(remaining);
    reopened.append({
      kind: "engine_event",
      identity: f.identity,
      event: {
        kind: "lifecycle",
        sequence: 4,
        timestamp: new Date().toISOString(),
        state: "running"
      }
    });
    expect(reopened.pendingEvents().at(-1)).toMatchObject({
      type: "acp.events",
      afterCursor: chunks.at(-1)!.cursor
    });
    for (const event of reopened.pendingEvents()) reopened.acknowledgeEvent(event.messageId);
    expect(reopened.pendingEvents()).toEqual([]);
  });

  it("splits heartbeat lease lists without dropping readiness or identities", async () => {
    const f = await setup(1024);
    const activeLeases = Array.from({ length: 9 }, (_, i) => ({
      dispatchId: `d${i}${"x".repeat(120)}`,
      leaseId: "l".repeat(128),
      executionAttemptId: "e".repeat(128)
    }));
    f.state.queueHeartbeat(activeLeases, emptyReadiness);
    const events = f.state.pendingEvents().filter((entry) => entry.type === "host.heartbeat");
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((event) => hostEventSchema.safeParse(event).success)).toBe(true);
    expect(events.flatMap((entry) => entry.activeLeases)).toEqual(activeLeases);
    expect(events[0]?.readiness).toEqual(emptyReadiness);
    expect(events.every((entry) => Buffer.byteLength(JSON.stringify(entry)) <= 1024)).toBe(true);
    const before = f.state.pendingEvents();
    f.state.setHostEventMaxPayloadBytes(100);
    expect(() => f.state.queueHeartbeat(activeLeases, emptyReadiness)).toThrow(
      "agent_host_outbound_payload_too_large"
    );
    expect(f.state.pendingEvents()).toEqual(before);
  });

  it("budgets the historical replay wrapper and preserves the original event JSON", () => {
    const event = parseHistoricalAgentHostEvent({
      type: "interaction.permission_requested",
      protocolVersion: 1,
      messageId: "legacy",
      dispatchId: "dispatch",
      leaseId: "lease",
      executionAttemptId: "attempt",
      acpSessionId: "session",
      actionId: "action",
      expiresAt: "2099-01-01T00:00:00.000Z",
      title: "Legacy",
      description: "中\u0000"
    });
    const raw = JSON.stringify(event, null, 2);
    const encoded = encodeHistoricalAgentHostEvent(event, 64 * 1024, raw);
    expect(JSON.parse(encoded.payload).eventJson).toBe(raw);
    expect(encoded.bytes).toBeGreaterThan(Buffer.byteLength(raw));
    expect(() => encodeHistoricalAgentHostEvent(event, encoded.bytes - 1, raw)).toThrow(
      "agent_host_outbound_payload_too_large"
    );
    expect(encodeHistoricalAgentHostEvent(event, encoded.bytes, raw)).toEqual(encoded);
  });

  it("keeps a nearly full readiness snapshot in its own heartbeat before renewing every lease", async () => {
    const f = await setup();
    const readiness = {
      workspaceMappings: [],
      acpProfiles: [
        {
          profileId: "profile",
          agentId: "agent",
          displayName: "Profile",
          status: "ready" as const,
          capabilities: Array.from({ length: 8 }, (_, index) => `cap-${index}-${"x".repeat(100)}`)
        }
      ]
    };
    const empty = hostEventSchema.parse({
      type: "host.heartbeat",
      protocolVersion: 1,
      messageId: "00000000-0000-0000-0000-000000000000",
      activeLeases: [],
      readiness
    });
    const bytes = Buffer.byteLength(JSON.stringify(empty));
    f.state.setHostEventMaxPayloadBytes(bytes);
    const leases = Array.from({ length: 5 }, (_, index) => ({
      dispatchId: `dispatch-${index}`,
      leaseId: "l".repeat(128),
      executionAttemptId: "e".repeat(128)
    }));
    f.state.queueHeartbeat(leases, readiness);
    const events = f.state.pendingEvents().filter((entry) => entry.type === "host.heartbeat");
    expect(events[0]).toMatchObject({ activeLeases: [], readiness });
    expect(events.slice(1).flatMap((entry) => entry.activeLeases)).toEqual(leases);
    expect(events.every((entry) => Buffer.byteLength(JSON.stringify(entry)) <= bytes)).toBe(true);
  });

  it("rejects an unrepresentable readiness configuration before accepting work", () => {
    const readiness = {
      workspaceMappings: [],
      acpProfiles: [
        {
          profileId: "profile",
          agentId: "agent",
          displayName: "Profile",
          status: "ready" as const,
          capabilities: Array.from({ length: 128 }, (_, index) => `cap-${index}-${"x".repeat(110)}`)
        }
      ]
    };
    assertHostOutboundControlBudget(64 * 1024, [], 1, readiness);
    expect(() => assertHostOutboundControlBudget(1024, [], 1, readiness)).toThrow(
      "agent_host_control_payload_budget_too_small"
    );
  });

  it.each([
    "query",
    "complete",
    "reconcile"
  ] as const)("records a small explicit %s response failure instead of leaving an RPC running", async (operation) => {
    const f = await setup();
    const command = canvasRuntimeRequestCommandSchema.parse({
      type: "canvas_runtime.request",
      protocolVersion: 1,
      requestId: "rpc-large",
      scope: { workspaceId: "workspace", projectId: "project", canvasId: "default" },
      deadline: "2099-01-01T00:00:00.000Z",
      operation:
        operation === "complete"
          ? {
              operation,
              runtimeLeaseId: "runtime-lease",
              evidence: {
                operationId: "operation",
                sourceRevision: `snapshot:${"a".repeat(64)}`,
                graphFingerprint: `pkg-${"b".repeat(64)}`
              },
              input: { operationId: "operation" }
            }
          : {
              operation,
              runtimeLeaseId: "runtime-lease",
              operationId: "operation",
              input: { operationId: "operation" }
            }
    });
    f.state.canvasRuntime.accept(command, 2);
    f.state.canvasRuntime.begin(command.requestId);
    f.state.canvasRuntime.complete(
      command.requestId,
      canvasRuntimeResponsePayloadSchema.parse({
        type: "canvas_runtime.response",
        protocolVersion: 1,
        requestId: command.requestId,
        response: { outcome: "success", operation, result: { text: "\u0000".repeat(16384) } }
      })
    );
    const event = f.state.pendingEvents().find((entry) => entry.type === "canvas_runtime.response");
    expect(event).toMatchObject({
      response: { outcome: "error", error: { code: "agent_host_outbound_payload_too_large" } }
    });
    if (operation !== "query")
      expect(event).toMatchObject({ response: { error: { reconcileRequired: true } } });
    expect(f.state.canvasRuntime.incomplete()).toEqual([]);
    for (const entry of f.state.pendingEvents()) f.state.acknowledgeEvent(entry.messageId);
    expect(f.state.pendingEvents()).toEqual([]);
  });

  it.each([
    "output",
    "terminal_output",
    "message"
  ] as const)("preserves schema-sensitive %s conversation text through complete-frame splitting", async (kind) => {
    const f = await setup();
    const command = acpConversationPromptCommandSchema.parse({
      type: "acp_conversation.prompt",
      protocolVersion: 1,
      operationId: "op",
      turnId: "turn",
      executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
      sessionId: "session",
      text: "Continue",
      expiresAt: "2099-01-01T00:00:00.000Z",
      sourceEnvelope: exampleExecutionEnvelopeInput
    });
    f.state.conversations.accept(command);
    const event = {
      type: "acp_conversation.event" as const,
      protocolVersion: 1 as const,
      operationId: command.operationId,
      turnId: command.turnId,
      executionAttemptId: command.executionAttemptId,
      sessionId: command.sessionId,
      messageId: "00000000-0000-0000-0000-000000000000",
      sequence: 1,
      timestamp: "2030-01-01T00:00:00.000Z",
      payload: {
        kind: "runner" as const,
        fragment: {
          kind: "runner_body" as const,
          body:
            kind === "message"
              ? {
                  kind,
                  role: "assistant" as const,
                  messageId: "message",
                  chunk: true,
                  content: "",
                  redaction: { classes: [], replaced: 0 }
                }
              : kind === "terminal_output"
                ? {
                    kind,
                    terminalId: "terminal",
                    content: "",
                    redaction: { classes: [], replaced: 0 }
                  }
                : {
                    kind,
                    stream: "stdout" as const,
                    content: "",
                    redaction: { classes: [], replaced: 0 }
                  }
        }
      }
    };
    const prefix = '\u0000😀"\\\n';
    const content =
      prefix +
      "a".repeat(
        64 * 1024 -
          Buffer.byteLength(JSON.stringify(event)) -
          Buffer.byteLength(JSON.stringify(prefix)) +
          1
      ) +
      "xtoken=value";
    event.payload.fragment.body.content = content;
    expect(acpConversationEventSchema.safeParse(event).success).toBe(true);
    f.state.conversations.append(command.turnId, event.payload);
    const events = f.state
      .pendingEvents()
      .filter((entry) => entry.type === "acp_conversation.event");
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((event) => hostEventSchema.safeParse(event).success)).toBe(true);
    expect(
      events
        .map((entry) =>
          entry.payload.kind === "runner" &&
          entry.payload.fragment.kind === "runner_body" &&
          "content" in entry.payload.fragment.body
            ? entry.payload.fragment.body.content
            : ""
        )
        .join("")
    ).toBe(content);
    expect(events.every((entry) => Buffer.byteLength(JSON.stringify(entry)) <= 64 * 1024)).toBe(
      true
    );
  });
});
