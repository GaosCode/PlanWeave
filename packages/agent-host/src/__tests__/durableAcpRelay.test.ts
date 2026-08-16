import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleExecuteDelivery, mailboxDeliverySchema } from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAcpInteractionRelay } from "../execution/durableAcpRelay.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";

const directories: string[] = [];
const states: AgentHostState[] = [];

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-durable-acp-relay-"));
  directories.push(directory);
  const state = await openAgentHostState(join(directory, "state.sqlite"));
  states.push(state);
  const delivery = mailboxDeliverySchema.parse({
    ...exampleExecuteDelivery,
    command: {
      ...exampleExecuteDelivery.command,
      leaseId: "lease-relay-001",
      leaseExpiresAt: "2030-01-01T00:00:00.000Z"
    }
  });
  state.receive(delivery);
  state.startExecution(delivery.sequence);
  const identity = {
    dispatchId: delivery.command.dispatchId,
    leaseId: delivery.command.leaseId,
    executionAttemptId: delivery.command.executionAttemptId
  };
  state.append({
    kind: "engine_event",
    identity,
    event: {
      sequence: 1,
      timestamp: "2026-07-23T00:00:00.000Z",
      kind: "capability_snapshot",
      snapshot: acpCapabilitySnapshotTestValue()
    }
  });
  state.append({
    kind: "engine_event",
    identity,
    event: {
      sequence: 2,
      timestamp: "2026-07-23T00:00:01.000Z",
      kind: "session_started",
      sessionId: "acp-session-relay-001",
      loaded: false
    }
  });
  return { state, delivery, identity };
}

describe("durable ACP relay", () => {
  it("persists session and cursor evidence before queueing normalized ACP events", async () => {
    const { state, delivery, identity } = await setup();
    state.append({
      kind: "engine_event",
      identity,
      event: {
        sequence: 3,
        timestamp: "2026-07-23T00:00:02.000Z",
        kind: "session_update",
        sessionId: "acp-session-relay-001",
        body: {
          kind: "message",
          role: "assistant",
          messageId: "message-1",
          chunk: true,
          content: "durably relayed",
          redaction: { classes: [], replaced: 0 }
        }
      }
    });

    expect(state.executionEvidence(delivery.sequence)).toMatchObject({
      acpSessionId: "acp-session-relay-001",
      acpCapabilitySnapshot: {
        negotiated: expect.arrayContaining(["history-load"]),
        missing: []
      },
      eventCursor: 1
    });
    expect(state.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "acp.events",
          acpSessionId: "acp-session-relay-001",
          afterCursor: 0,
          cursor: 1,
          events: [{ cursor: 1, kind: "agent_message", text: "durably relayed" }]
        })
      ])
    );
  });

  it("settles permission exactly once after the mailbox response is durable", async () => {
    const { state, delivery, identity } = await setup();
    const request = {
      requestId: "permission:1",
      sessionId: "acp-session-relay-001",
      toolCallId: "tool-1",
      summary: "Allow test tool",
      options: [
        { optionId: "allow", label: "Allow once", decision: "approve" as const },
        { optionId: "deny", label: "Deny", decision: "deny" as const }
      ]
    };
    state.append({
      kind: "permission_request",
      identity,
      request,
      deadline: "2030-01-01T00:00:00.000Z"
    });
    expect(state.executionEvidence(delivery.sequence)).toMatchObject({
      status: "interaction_wait",
      actionCursor: 1
    });
    expect(state.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "interaction.permission_requested",
          actionId: "permission:1",
          acpSessionId: "acp-session-relay-001"
        })
      ])
    );

    const relay = new DurableAcpInteractionRelay(state);
    const response = relay.requestPermission(identity, request, {
      signal: new AbortController().signal,
      deadline: new Date("2030-01-01T00:00:00.000Z")
    });
    const settlement = mailboxDeliverySchema.parse({
      type: "mailbox.message",
      protocolVersion: 1,
      sequence: delivery.sequence + 1,
      previousSequence: delivery.sequence,
      messageId: "mailbox-permission-response-001",
      command: {
        type: "interaction.permission_response",
        ...identity,
        acpSessionId: "acp-session-relay-001",
        actionId: "permission:1",
        decision: "allow_once"
      }
    });
    state.receive(settlement);
    relay.accept(settlement.command);

    await expect(response).resolves.toEqual({ kind: "select", optionId: "allow" });
    expect(state.executionEvidence(delivery.sequence)?.status).toBe("interaction_wait");
    state.append({
      kind: "engine_event",
      identity,
      event: {
        sequence: 3,
        timestamp: "2026-07-23T00:00:02.000Z",
        kind: "interaction",
        requestId: "permission:1",
        interaction: "permission",
        state: "resolved",
        outcome: "selected"
      }
    });
    expect(state.executionEvidence(delivery.sequence)?.status).toBe("running");

    const conflict = {
      ...settlement,
      sequence: settlement.sequence + 1,
      previousSequence: settlement.sequence,
      messageId: "mailbox-permission-response-conflict",
      command: { ...settlement.command, decision: "deny" as const }
    };
    expect(() => state.receive(conflict)).toThrow("execution_action_response_conflict");
    expect(state.pendingEvents()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mailbox.ack", sequence: conflict.sequence })
      ])
    );
  });

  it("rejects stale session and expired interaction settlements", async () => {
    const { state, delivery, identity } = await setup();
    state.append({
      kind: "permission_request",
      identity,
      request: {
        requestId: "permission:expired",
        sessionId: "acp-session-relay-001",
        toolCallId: "tool-expired",
        summary: "Expired",
        options: [{ optionId: "deny", label: "Deny", decision: "deny" }]
      },
      deadline: "2020-01-01T00:00:00.000Z"
    });
    const settlement = {
      type: "mailbox.message" as const,
      protocolVersion: 1 as const,
      sequence: delivery.sequence + 1,
      previousSequence: delivery.sequence,
      messageId: "mailbox-expired-response",
      command: {
        type: "interaction.permission_response" as const,
        ...identity,
        acpSessionId: "acp-session-relay-001",
        actionId: "permission:expired",
        decision: "deny" as const
      }
    };
    expect(() =>
      state.receive({
        ...settlement,
        command: { ...settlement.command, decision: "allow_once" }
      })
    ).toThrow("execution_action_expired");
    expect(() => state.receive(settlement)).not.toThrow();
    expect(() =>
      state.receive({
        ...settlement,
        sequence: settlement.sequence + 1,
        previousSequence: settlement.sequence,
        messageId: "mailbox-stale-session-response",
        command: { ...settlement.command, acpSessionId: "acp-session-stale" }
      })
    ).toThrow("execution_action_stale_session");
  });

  it("recovers a durable settlement before waiter registration and accepts exact mailbox replay", async () => {
    const { state, delivery, identity } = await setup();
    const request = {
      requestId: "permission:recovered",
      sessionId: "acp-session-relay-001",
      toolCallId: "tool-recovered",
      summary: "Recovered response",
      options: [{ optionId: "deny", label: "Deny", decision: "deny" as const }]
    };
    state.append({
      kind: "permission_request",
      identity,
      request,
      deadline: "2030-01-01T00:00:00.000Z"
    });
    const settlement = mailboxDeliverySchema.parse({
      type: "mailbox.message",
      protocolVersion: 1,
      sequence: delivery.sequence + 1,
      previousSequence: delivery.sequence,
      messageId: "mailbox-recovered-response",
      command: {
        type: "interaction.permission_response",
        ...identity,
        acpSessionId: "acp-session-relay-001",
        actionId: "permission:recovered",
        decision: "deny"
      }
    });
    state.receive(settlement);
    const path = join(directories.at(-1) ?? "", "state.sqlite");
    state.close();
    states.pop();
    const reopened = await openAgentHostState(path);
    states.push(reopened);
    const relay = new DurableAcpInteractionRelay(reopened);

    await expect(
      relay.requestPermission(identity, request, {
        signal: new AbortController().signal,
        deadline: new Date("2030-01-01T00:00:00.000Z")
      })
    ).resolves.toEqual({ kind: "select", optionId: "deny" });

    expect(() =>
      reopened.receive({
        ...settlement,
        sequence: settlement.sequence + 1,
        previousSequence: settlement.sequence,
        messageId: "mailbox-recovered-response-replay"
      })
    ).not.toThrow();
    expect(reopened.executionEvidence(delivery.sequence)?.status).toBe("interaction_wait");
    expect(reopened.recoverInterruptedExecutions()).toBe(1);
    expect(reopened.executionEvidence(delivery.sequence)?.status).toBe("interrupted");
  });

  it("maps accepted and cancelled elicitation settlements without treating cancellation as input", async () => {
    const acceptedSetup = await setup();
    const request = {
      requestId: "elicitation:accepted",
      sessionId: "acp-session-relay-001",
      message: "Provide form input",
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"]
      }
    };
    acceptedSetup.state.append({
      kind: "elicitation_request",
      identity: acceptedSetup.identity,
      request,
      deadline: "2030-01-01T00:00:00.000Z"
    });
    const acceptedRelay = new DurableAcpInteractionRelay(acceptedSetup.state);
    const accepted = acceptedRelay.requestElicitation(acceptedSetup.identity, request, {
      signal: new AbortController().signal,
      deadline: new Date("2030-01-01T00:00:00.000Z")
    });
    const acceptedDelivery = mailboxDeliverySchema.parse({
      type: "mailbox.message",
      protocolVersion: 1,
      sequence: acceptedSetup.delivery.sequence + 1,
      previousSequence: acceptedSetup.delivery.sequence,
      messageId: "mailbox-elicitation-accepted",
      command: {
        type: "interaction.elicitation_response",
        ...acceptedSetup.identity,
        acpSessionId: "acp-session-relay-001",
        actionId: "elicitation:accepted",
        outcome: "accepted",
        response: '{"answer":"yes"}'
      }
    });
    acceptedSetup.state.receive(acceptedDelivery);
    acceptedRelay.accept(acceptedDelivery.command);
    await expect(accepted).resolves.toEqual({ action: "accept", content: { answer: "yes" } });

    const cancelledSetup = await setup();
    const cancelledRequest = { ...request, requestId: "elicitation:cancelled" };
    cancelledSetup.state.append({
      kind: "elicitation_request",
      identity: cancelledSetup.identity,
      request: cancelledRequest,
      deadline: "2020-01-01T00:00:00.000Z"
    });
    const cancelledRelay = new DurableAcpInteractionRelay(cancelledSetup.state);
    const cancelled = cancelledRelay.requestElicitation(cancelledSetup.identity, cancelledRequest, {
      signal: new AbortController().signal,
      deadline: new Date("2030-01-01T00:00:00.000Z")
    });
    const cancelledDelivery = mailboxDeliverySchema.parse({
      type: "mailbox.message",
      protocolVersion: 1,
      sequence: cancelledSetup.delivery.sequence + 1,
      previousSequence: cancelledSetup.delivery.sequence,
      messageId: "mailbox-elicitation-cancelled",
      command: {
        type: "interaction.elicitation_response",
        ...cancelledSetup.identity,
        acpSessionId: "acp-session-relay-001",
        actionId: "elicitation:cancelled",
        outcome: "cancelled"
      }
    });
    cancelledSetup.state.receive(cancelledDelivery);
    cancelledRelay.accept(cancelledDelivery.command);
    await expect(cancelled).resolves.toEqual({ action: "cancel" });
  });

  it("consumes authentication cancel and terminates unsupported retry without replay", async () => {
    const { state, delivery, identity } = await setup();
    state.recordInteractionAction(delivery.sequence, {
      leaseId: identity.leaseId,
      sessionId: "acp-session-relay-001",
      actionId: "authentication:1",
      kind: "authentication",
      deadline: "2020-01-01T00:00:00.000Z",
      requestDigest: `sha256:${"a".repeat(64)}`,
      afterCursor: 0,
      cursor: 1
    });
    const base = {
      type: "mailbox.message" as const,
      protocolVersion: 1 as const,
      sequence: delivery.sequence + 1,
      previousSequence: delivery.sequence,
      messageId: "mailbox-auth-action",
      command: {
        type: "interaction.authentication_action" as const,
        ...identity,
        acpSessionId: "acp-session-relay-001",
        actionId: "authentication:1"
      }
    };
    const retry = {
      ...base,
      command: { ...base.command, action: "retry_after_host_login" as const }
    };
    expect(() => state.receive(retry)).not.toThrow();
    expect(new DurableAcpInteractionRelay(state).accept(retry.command)).toBeUndefined();
    expect(state.executionEvidence(delivery.sequence)?.status).toBe("failed");
    expect(state.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mailbox.ack", sequence: base.sequence }),
        expect.objectContaining({
          type: "dispatch.failed",
          failure: expect.objectContaining({
            code: "agent_host_authentication_retry_unsupported"
          })
        })
      ])
    );

    const cancelledSetup = await setup();
    cancelledSetup.state.recordInteractionAction(cancelledSetup.delivery.sequence, {
      leaseId: cancelledSetup.identity.leaseId,
      sessionId: "acp-session-relay-001",
      actionId: "authentication:cancel",
      kind: "authentication",
      deadline: "2020-01-01T00:00:00.000Z",
      requestDigest: `sha256:${"b".repeat(64)}`,
      afterCursor: 0,
      cursor: 1
    });
    const cancelled = {
      ...base,
      command: {
        ...base.command,
        ...cancelledSetup.identity,
        actionId: "authentication:cancel",
        action: "cancel" as const
      }
    };
    cancelledSetup.state.receive(cancelled);
    const relay = new DurableAcpInteractionRelay(cancelledSetup.state);
    expect(relay.accept(cancelled.command)).toEqual(identity);
    expect(
      cancelledSetup.state.executionEvidence(cancelledSetup.delivery.sequence)?.cancellationIntent
    ).toEqual({
      kind: "authentication_cancelled",
      actionId: "authentication:cancel"
    });
  });
});
