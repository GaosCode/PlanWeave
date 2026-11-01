import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES,
  acpConversationEventSchema,
  hostEventPayloadBytes,
  acpConversationPromptCommandSchema,
  type AcpConversationEvent,
  exampleExecutionEnvelopeInput
} from "@planweave-ai/agent-host-protocol";
import { ACP_CONVERSATION_RESPONSE_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { RemoteAcpConversationService } from "../execution/remoteAcpConversationService.js";

const fixtures: { directory: string; state: AgentHostState }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.state.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "conversation-budget-host-"));
  const state = await openAgentHostState(join(directory, "state.sqlite"));
  fixtures.push({ directory, state });
  const command = acpConversationPromptCommandSchema.parse({
    type: "acp_conversation.prompt",
    protocolVersion: 1,
    operationId: "operation-budget",
    turnId: "turn-budget",
    executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
    sessionId: "original-session",
    text: "Continue",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceEnvelope: exampleExecutionEnvelopeInput
  });
  state.conversations.accept(command);
  return { state, command };
}

describe("Host conversation single-event wire admission", () => {
  it("derives the minimum budget from the largest generated identities and bounded failure frame", () => {
    const terminal = acpConversationEventSchema.parse({
      type: "acp_conversation.event",
      protocolVersion: 1,
      operationId: "\u0000".repeat(256),
      turnId: "\u0000".repeat(256),
      executionAttemptId: "\u0000".repeat(256),
      sessionId: "\u0000".repeat(1024),
      messageId: "00000000-0000-0000-0000-000000000000",
      sequence: Number.MAX_SAFE_INTEGER,
      timestamp: "9999-12-31T23:59:59.999Z",
      payload: { kind: "status", status: "failed", error: "acp_conversation_" + "x".repeat(111) }
    });
    expect(Buffer.byteLength(JSON.stringify(terminal))).toBe(
      ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES
    );
    expect(() =>
      hostEventPayloadBytes(
        JSON.stringify(terminal),
        ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES - 1
      )
    ).toThrow("agent_host_outbound_payload_too_large");
    expect(
      hostEventPayloadBytes(JSON.stringify(terminal), ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES)
    ).toBe(Buffer.byteLength(JSON.stringify(terminal)));
    terminal.payload = { kind: "status", status: "running", error: null };
    expect(
      hostEventPayloadBytes(JSON.stringify(terminal), ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES)
    ).toBeLessThan(ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES);
  });

  it.each([-1, 0, 1])("uses actual escaped UTF-8 frame bytes at 256KiB %+i", async (delta) => {
    const f = await setup();
    const prefix = '中"\\\n\u0000';
    const event: AcpConversationEvent = {
      type: "acp_conversation.event",
      protocolVersion: 1,
      operationId: f.command.operationId,
      turnId: f.command.turnId,
      executionAttemptId: f.command.executionAttemptId,
      sessionId: f.command.sessionId,
      messageId: "00000000-0000-0000-0000-000000000000",
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: {
        kind: "interaction",
        request: {
          kind: "elicitation",
          requestId: "boundary",
          message: "Input",
          deadline: f.command.expiresAt,
          requestedSchema: { description: prefix }
        }
      }
    };
    const target = 256 * 1024 + delta;
    if (event.payload.kind !== "interaction" || event.payload.request.kind !== "elicitation")
      throw new Error("expected_elicitation");
    event.payload.request.requestedSchema.description =
      prefix + "x".repeat(target - Buffer.byteLength(JSON.stringify(event)));
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(target);
    if (delta > 0) {
      expect(() => f.state.conversations.append(f.command.turnId, event.payload)).toThrow(
        "acp_conversation_event_too_large"
      );
      expect(f.state.pendingEvents()).toEqual([]);
      f.state.conversations.append(f.command.turnId, {
        kind: "status",
        status: "failed",
        error: "acp_conversation_event_too_large"
      });
      expect(f.state.pendingEvents()[0]).toMatchObject({ sequence: 1 });
    } else {
      f.state.conversations.append(f.command.turnId, event.payload);
      const persisted = f.state.pendingEvents()[0];
      expect(Buffer.byteLength(JSON.stringify(persisted))).toBe(target);
    }
  });

  it.each([
    "permission",
    "elicitation"
  ] as const)("rejects an oversized %s before outbox/sequence publication, then publishes a readable failure", async (kind) => {
    const f = await setup();
    let rejection: unknown;
    const service = new RemoteAcpConversationService(f.state.conversations, {
      converse: async (_command, broker, _sink, signal) => {
        try {
          if (kind === "elicitation")
            await broker.requestElicitation(
              {
                requestId: "huge",
                message: "Large schema",
                requestedSchema: { description: "x".repeat(300 * 1024) }
              },
              { signal, deadline: new Date(f.command.expiresAt) }
            );
          else
            await broker.requestPermission(
              {
                requestId: "huge",
                sessionId: f.command.sessionId,
                toolCallId: "tool",
                summary: "Many options",
                options: Array.from({ length: 64 }, (_, index) => ({
                  optionId: `option-${index}`,
                  label: "x".repeat(64 * 1024),
                  kind: "allow_once" as const
                }))
              },
              { signal, deadline: new Date(f.command.expiresAt) }
            );
        } catch (error) {
          rejection = error;
          throw error;
        }
        return {
          terminal: { state: "succeeded", stopReason: "end_turn" },
          cleanup: { attempted: true, completed: true }
        };
      }
    });
    service.handle(f.command);
    await service.stop();
    expect(rejection).toMatchObject({ message: "acp_conversation_event_too_large" });
    const events = f.state
      .pendingEvents()
      .filter((event) => event.type === "acp_conversation.event");
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.payload)).toEqual([
      { kind: "status", status: "running", error: null },
      { kind: "status", status: "failed", error: "acp_conversation_cleanup_failed" }
    ]);
    expect(events.every((event) => Buffer.byteLength(JSON.stringify(event)) < 16 * 1024)).toBe(
      true
    );
    expect(service.isSessionActive(f.command.sessionId)).toBe(true);
    for (const event of events) f.state.acknowledgeEvent(event.messageId);
    expect(f.state.pendingEvents()).toEqual([]);
  });

  it("keeps the sequence available after a pre-outbox rejection for a subsequent explicit terminal", async () => {
    const f = await setup();
    f.state.setHostEventMaxPayloadBytes(8 * 1024 * 1024);
    const request = {
      kind: "elicitation" as const,
      requestId: "huge",
      message: "Oversize",
      deadline: f.command.expiresAt,
      requestedSchema: { description: "x".repeat(ACP_CONVERSATION_RESPONSE_MAX_BYTES) }
    };
    expect(() =>
      f.state.conversations.append(f.command.turnId, { kind: "interaction", request })
    ).toThrow("acp_conversation_event_too_large");
    expect(f.state.pendingEvents()).toEqual([]);
    f.state.conversations.append(f.command.turnId, {
      kind: "status",
      status: "failed",
      error: "acp_conversation_event_too_large"
    });
    expect(f.state.pendingEvents()).toEqual([
      expect.objectContaining({
        sequence: 1,
        payload: { kind: "status", status: "failed", error: "acp_conversation_event_too_large" }
      })
    ]);
  });
});
