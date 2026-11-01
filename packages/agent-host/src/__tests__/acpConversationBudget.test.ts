import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acpConversationPromptCommandSchema,
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
                requestedSchema: { description: "x".repeat(ACP_CONVERSATION_RESPONSE_MAX_BYTES) }
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
