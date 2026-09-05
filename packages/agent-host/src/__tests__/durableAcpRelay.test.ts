import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exampleExecuteDelivery,
  exampleLegacyAcpEventBatchV1,
  exampleRunnerBodyFragments,
  hashExecutionEnvelope,
  mailboxDeliverySchema
} from "@planweave-ai/agent-host-protocol";
import { executeAcp } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAcpInteractionRelay } from "../execution/durableAcpRelay.js";
import { agentHostRemoteEngineEventSchema } from "../execution/remoteAcpPorts.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const mockAgentPath = fileURLToPath(
  new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(options: { negotiateEventProtocol?: boolean; seedEvidence?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-durable-acp-relay-"));
  directories.push(directory);
  const databasePath = join(directory, "state.sqlite");
  const state = await openAgentHostState(databasePath);
  if (options.negotiateEventProtocol !== false) {
    state.setRemoteRunnerEventProtocolVersion(2);
  }
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
  if (options.seedEvidence !== false) {
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
  }
  return { state, delivery, identity, databasePath };
}

function appendMessage(
  state: AgentHostState,
  identity: { dispatchId: string; leaseId: string; executionAttemptId: string },
  sequence: number,
  content: string
): void {
  state.append({
    kind: "engine_event",
    identity,
    event: {
      sequence,
      timestamp: new Date(Date.UTC(2026, 6, 23, 0, 0, sequence)).toISOString(),
      kind: "session_update",
      sessionId: "acp-session-relay-001",
      body: {
        kind: "message",
        role: "assistant",
        messageId: `message-${sequence}`,
        chunk: false,
        content,
        redaction: { classes: [], replaced: 0 }
      }
    }
  });
}

async function downgradeStateToVersionEight(
  state: AgentHostState,
  databasePath: string,
  eventCursor: number
): Promise<void> {
  states.splice(states.indexOf(state), 1);
  state.close();
  const database = await openAgentHostDatabase(databasePath, 5_000);
  database.exec(`
    ALTER TABLE agent_host_executions DROP COLUMN event_protocol_version;
    UPDATE agent_host_state_schema SET version = 8;
  `);
  database.prepare("UPDATE agent_host_executions SET event_cursor = ?").run(eventCursor);
  database.close();
}

describe("durable ACP relay", () => {
  it("requires explicit capability negotiation before writing live runner events", async () => {
    const { state, identity } = await setup({
      negotiateEventProtocol: false,
      seedEvidence: false
    });

    expect(() =>
      state.append({
        kind: "engine_event",
        identity,
        event: {
          sequence: 1,
          timestamp: "2026-07-23T00:00:00.000Z",
          kind: "capability_snapshot",
          snapshot: acpCapabilitySnapshotTestValue()
        }
      })
    ).toThrow("remote_runner_event_v2_required");
    expect(state.records(identity)).toEqual([]);
    expect(state.pendingEvents().filter((event) => event.type === "acp.events")).toEqual([]);
  });

  it("refuses to open state containing a persisted live v1 outbox event", async () => {
    const seeded = await setup({ seedEvidence: false });
    states.splice(states.indexOf(seeded.state), 1);
    seeded.state.close();
    const database = await openAgentHostDatabase(seeded.databasePath, 5_000);
    database
      .prepare(
        `INSERT INTO agent_host_outbox(message_id,event_key,event_json,created_at)
         VALUES(?,?,?,?)`
      )
      .run(
        exampleLegacyAcpEventBatchV1.messageId,
        "acp.events.v1:legacy-persisted",
        JSON.stringify(exampleLegacyAcpEventBatchV1),
        "2026-07-23T00:00:00.000Z"
      );
    database.close();

    await expect(openAgentHostState(seeded.databasePath)).rejects.toThrow(
      "remote_runner_event_v1_outbox_present"
    );

    const inspected = await openAgentHostDatabase(seeded.databasePath, 5_000);
    expect(
      inspected
        .prepare("SELECT event_json,acknowledged_at FROM agent_host_outbox WHERE event_key=?")
        .get("acp.events.v1:legacy-persisted")
    ).toMatchObject({
      event_json: JSON.stringify(exampleLegacyAcpEventBatchV1),
      acknowledged_at: null
    });
    expect(inspected.prepare("SELECT version FROM agent_host_state_schema").get()).toMatchObject({
      version: 10
    });
    inspected.close();
  });

  it("keeps migrated v1 attempts readable but refuses to write new live v1 events", async () => {
    const legacy = await setup({ seedEvidence: false });
    await downgradeStateToVersionEight(legacy.state, legacy.databasePath, 1);

    const migratedLegacy = await openAgentHostState(legacy.databasePath);
    states.push(migratedLegacy);
    expect(migratedLegacy.executionEvidence(legacy.delivery.sequence)?.eventProtocolVersion).toBe(
      1
    );
    migratedLegacy.setRemoteRunnerEventProtocolVersion(2);
    expect(() =>
      migratedLegacy.append({
        kind: "engine_event",
        identity: legacy.identity,
        event: {
          sequence: 1,
          timestamp: "2026-07-23T00:01:00.000Z",
          kind: "capability_snapshot",
          snapshot: acpCapabilitySnapshotTestValue()
        }
      })
    ).toThrow("remote_runner_event_v2_required");
    expect(migratedLegacy.pendingEvents().filter((event) => event.type === "acp.events")).toEqual(
      []
    );

    const fresh = await setup({ seedEvidence: false });
    await downgradeStateToVersionEight(fresh.state, fresh.databasePath, 0);
    const migratedFresh = await openAgentHostState(fresh.databasePath);
    states.push(migratedFresh);
    expect(
      migratedFresh.executionEvidence(fresh.delivery.sequence)?.eventProtocolVersion
    ).toBeUndefined();
    migratedFresh.setRemoteRunnerEventProtocolVersion(2);
    migratedFresh.append({
      kind: "engine_event",
      identity: fresh.identity,
      event: {
        sequence: 1,
        timestamp: "2026-07-23T00:02:00.000Z",
        kind: "capability_snapshot",
        snapshot: acpCapabilitySnapshotTestValue()
      }
    });
    migratedFresh.append({
      kind: "engine_event",
      identity: fresh.identity,
      event: {
        sequence: 2,
        timestamp: "2026-07-23T00:02:01.000Z",
        kind: "session_started",
        sessionId: "acp-session-relay-001",
        loaded: false
      }
    });
    expect(migratedFresh.executionEvidence(fresh.delivery.sequence)?.eventProtocolVersion).toBe(2);
    expect(
      migratedFresh
        .pendingEvents()
        .filter((candidate) => candidate.type === "acp.events")
        .every(
          (candidate) => "eventProtocolVersion" in candidate && candidate.eventProtocolVersion === 2
        )
    ).toBe(true);
  });

  it("pins v2 per attempt across restart", async () => {
    const { state, delivery, identity, databasePath } = await setup();
    appendMessage(state, identity, 3, "v2-first");
    expect(state.executionEvidence(delivery.sequence)?.eventProtocolVersion).toBe(2);
    const firstEvent = state
      .pendingEvents()
      .find((candidate) => candidate.type === "acp.events" && "eventProtocolVersion" in candidate);
    expect(firstEvent).toBeDefined();

    states.splice(states.indexOf(state), 1);
    state.close();
    const reopened = await openAgentHostState(databasePath);
    states.push(reopened);
    reopened.setRemoteRunnerEventProtocolVersion(2);
    appendMessage(reopened, identity, 4, "v2-after-restart");
    appendMessage(reopened, identity, 4, "v2-after-restart");
    expect(reopened.executionEvidence(delivery.sequence)?.eventProtocolVersion).toBe(2);
    const pending = reopened.pendingEvents().filter((candidate) => candidate.type === "acp.events");
    expect(pending).toHaveLength(4);
    expect(
      pending.every(
        (candidate) => "eventProtocolVersion" in candidate && candidate.eventProtocolVersion === 2
      )
    ).toBe(true);
    expect(reopened.acknowledgeEvent(firstEvent!.messageId)).toBe(true);
    expect(reopened.pendingEvents()).not.toContainEqual(firstEvent);
  });

  it("uses v2 for every new attempt", async () => {
    const { state, delivery, identity } = await setup();
    appendMessage(state, identity, 3, "first-attempt");
    expect(state.executionEvidence(delivery.sequence)?.eventProtocolVersion).toBe(2);
    if (delivery.command.type !== "execute_block") throw new Error("execute_block_required");

    state.setRemoteRunnerEventProtocolVersion(2);
    const envelope = {
      ...delivery.command.envelope,
      execution: { dispatchId: "dispatch-relay-002", attemptId: "attempt-relay-002" }
    };
    const nextDelivery = mailboxDeliverySchema.parse({
      ...delivery,
      sequence: 2,
      previousSequence: 1,
      messageId: "mailbox-relay-002",
      command: {
        ...delivery.command,
        dispatchId: envelope.execution.dispatchId,
        leaseId: "lease-relay-002",
        executionAttemptId: envelope.execution.attemptId,
        envelopeDigest: hashExecutionEnvelope(envelope),
        envelope
      }
    });
    state.receive(nextDelivery);
    state.startExecution(nextDelivery.sequence);
    const nextIdentity = {
      dispatchId: nextDelivery.command.dispatchId,
      leaseId: nextDelivery.command.leaseId,
      executionAttemptId: nextDelivery.command.executionAttemptId
    };
    state.append({
      kind: "engine_event",
      identity: nextIdentity,
      event: {
        sequence: 1,
        timestamp: "2026-07-23T00:01:00.000Z",
        kind: "capability_snapshot",
        snapshot: acpCapabilitySnapshotTestValue()
      }
    });
    state.append({
      kind: "engine_event",
      identity: nextIdentity,
      event: {
        sequence: 2,
        timestamp: "2026-07-23T00:01:01.000Z",
        kind: "session_started",
        sessionId: "acp-session-relay-001",
        loaded: false
      }
    });
    appendMessage(state, nextIdentity, 3, "v2-attempt");
    expect(state.executionEvidence(nextDelivery.sequence)?.eventProtocolVersion).toBe(2);
  });

  it("relays every shared Runner body leaf through the v2 durable outbox", async () => {
    const { state, identity } = await setup();
    for (const [index, body] of exampleRunnerBodyFragments.entries()) {
      state.append({
        kind: "engine_event",
        identity,
        event: {
          sequence: index + 3,
          timestamp: new Date(Date.UTC(2026, 6, 23, 0, 0, index + 2)).toISOString(),
          kind: "session_update",
          sessionId: "acp-session-relay-001",
          body
        }
      });
    }
    const relayedBodies = state
      .pendingEvents()
      .filter((event) => event.type === "acp.events" && "eventProtocolVersion" in event)
      .flatMap((event) => event.events)
      .flatMap((event) => (event.fragment.kind === "runner_body" ? [event.fragment.body] : []));
    expect(relayedBodies).toEqual(exampleRunnerBodyFragments);
  });

  it("rejects a v2 session update whose source session identity is stale", async () => {
    const { state, identity, delivery } = await setup();
    expect(() =>
      state.append({
        kind: "engine_event",
        identity,
        event: {
          sequence: 3,
          timestamp: "2026-07-23T00:00:02.000Z",
          kind: "session_update",
          sessionId: "stale-session",
          body: exampleRunnerBodyFragments[0]!
        }
      })
    ).toThrowError("remote_execution_session_identity_stale");
    expect(state.executionEvidence(delivery.sequence)?.eventCursor).toBe(2);
  });

  it("relays all durable engine evidence as v2 without converting terminal evidence", async () => {
    const { state, identity } = await setup();
    state.append({
      kind: "engine_event",
      identity,
      event: {
        sequence: 3,
        timestamp: "2026-07-23T00:00:02.000Z",
        kind: "usage",
        usage: {
          totalTokens: 5,
          inputTokens: 3,
          outputTokens: 2,
          thoughtTokens: null,
          cachedReadTokens: null,
          cachedWriteTokens: null
        }
      }
    });
    state.append({
      kind: "engine_event",
      identity,
      event: {
        sequence: 4,
        timestamp: "2026-07-23T00:00:03.000Z",
        kind: "terminal",
        terminal: { state: "succeeded", stopReason: "end_turn" }
      }
    });

    const v2 = state
      .pendingEvents()
      .filter((event) => event.type === "acp.events" && "eventProtocolVersion" in event);
    expect(v2).toHaveLength(4);
    expect(v2.map((event) => event.events[0]?.sourceSequence)).toEqual([1, 2, 3, 4]);
    expect(v2.at(-1)?.events[0]?.fragment).toEqual({
      kind: "engine_terminal",
      terminal: { state: "succeeded", stopReason: "end_turn" }
    });
  });

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
      eventCursor: 3,
      eventProtocolVersion: 2
    });
    expect(state.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "acp.events",
          acpSessionId: "acp-session-relay-001",
          eventProtocolVersion: 2,
          afterCursor: 2,
          cursor: 3,
          events: [
            expect.objectContaining({
              cursor: 3,
              sourceSequence: 3,
              fragment: expect.objectContaining({ kind: "runner_body" })
            })
          ]
        })
      ])
    );
  });

  it("persists and relays every Host engine evidence leaf through v2", async () => {
    const { state, delivery, identity } = await setup({ seedEvidence: false });
    const engineEvents: Array<ReturnType<typeof agentHostRemoteEngineEventSchema.parse>> = [];
    const result = await executeAcp({
      launch: { trusted: true, command: process.execPath, args: [mockAgentPath, "prompt-usage"] },
      workspace: { cwd: process.cwd() },
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      clientInfo: { name: "planweave-host-relay-characterization", version: "1.0.0" },
      shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
      capabilityPolicy: { required: [], optional: [] },
      prompt: "exercise Host engine relay evidence",
      sessionStart: { kind: "new" },
      limits: { operationTimeoutMs: 5_000, interactionTimeoutMs: 5_000 },
      eventSink: (event) => {
        if (event.kind !== "session_update") {
          engineEvents.push(agentHostRemoteEngineEventSchema.parse(event));
        }
      }
    });
    expect(result.terminal.state).toBe("succeeded");
    const nextSequence = Math.max(...engineEvents.map((event) => event.sequence)) + 1;
    engineEvents.push(
      agentHostRemoteEngineEventSchema.parse({
        sequence: nextSequence,
        timestamp: "2026-07-23T00:00:08.000Z",
        kind: "interaction",
        requestId: "permission-1",
        interaction: "permission",
        state: "requested"
      })
    );

    for (const event of engineEvents) {
      state.append({
        kind: "engine_event",
        identity,
        event
      });
    }

    expect(
      state
        .records(identity)
        .map((record) => (record.kind === "engine_event" ? record.event.kind : record.kind))
    ).toEqual([
      "lifecycle",
      "capability_snapshot",
      "capabilities",
      "session_started",
      "lifecycle",
      "usage",
      "lifecycle",
      "terminal",
      "interaction"
    ]);
    expect(state.executionEvidence(delivery.sequence)).toMatchObject({
      acpSessionId: expect.stringMatching(/^mock-session-/),
      acpCapabilitySnapshot: { missing: [] },
      eventCursor: engineEvents.length,
      eventProtocolVersion: 2
    });
    expect(state.pendingEvents().filter((event) => event.type === "acp.events")).toHaveLength(
      engineEvents.length
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
