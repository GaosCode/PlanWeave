import {
  historicalPermissionMailboxReplaySchema,
  exampleExecuteDelivery,
  executeBlockCommandSchema,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  mailboxDeliverySchema,
  cancelExecutionCommandSchema
} from "@planweave-ai/agent-host-protocol";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { parseHistoricalAgentHostMailboxCommand } from "../../../../agent-host/src/protocol.js";
import { digestJson } from "../../../../agent-host/src/state/agentHostStateMigrations.js";
import { DurableAcpInteractionRelay } from "../../../../agent-host/src/execution/durableAcpRelay.js";
import type { AgentHostExecutor } from "../../../../agent-host/src/execution/agentHostExecutor.js";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { AgentHostClient } from "../../../../agent-host/src/transport/agentHostClient.js";
import { openAgentHostState } from "../../../../agent-host/src/state/agentHostState.js";
import { openAgentHostDatabase } from "../../../../agent-host/src/state/sqliteDatabase.js";
import { remoteRunnerEventV2Request } from "../../../../agent-host/src/__tests__/support/remoteRunnerEventCapabilityTestValues.js";
import { RemoteAcpEventRepository } from "../../../../server/src/remoteAcpEvents.js";
import { RemoteInteractionService } from "../../../../server/src/remoteInteractions.js";
import { RemoteExecutionActionRepository } from "../../../../server/src/remoteExecutionActions.js";
import { attachAgentHostWebSocketServer } from "../../../../server/src/wsServer.js";
import { createTestDispatchCoordination } from "../../../../server/src/__tests__/support/testDispatchCoordination.js";
import { loopbackHttpTransportAdmission } from "../../../../server/src/__tests__/support/transportAdmission.js";
import {
  cleanupRemoteObservationsFixture,
  setupRemoteObservationsFixture
} from "../../../../server/src/__tests__/support/remoteObservationsFixture.js";

const cleanups: Array<() => void | Promise<void>> = [];
export async function cleanupHistoricalPermissionReplay() {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  await cleanupRemoteObservationsFixture();
}

export async function setup() {
  const fixture = await setupRemoteObservationsFixture();
  const database = fixture.server.database;
  const token = `pw_host_${"H".repeat(43)}`;
  database
    .prepare("UPDATE agent_hosts SET credential_hash=? WHERE id=?")
    .run(createHash("sha256").update(token).digest("hex"), fixture.host.id);
  const coordination = createTestDispatchCoordination(database, {
    leaseDurationMs: 60_000,
    hostOfflineAfterMs: 60_000,
    writeback: { complete: async () => {}, fail: async () => {} }
  });
  expect(coordination.hosts.authenticate(fixture.host.id, token)?.id).toBe(fixture.host.id);
  const interactions = new RemoteInteractionService(database, {
    authorization: { canRespond: () => true },
    publisher: coordination.mailbox,
    clock: fixture.clock
  });
  const http = createServer();
  const ws = attachAgentHostWebSocketServer({
    server: http,
    ...coordination,
    interactions,
    acpEvents: new RemoteAcpEventRepository(database),
    actions: new RemoteExecutionActionRepository(database),
    heartbeatIntervalMs: 60_000,
    leaseDurationMs: 60_000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("test_port_required");
  cleanups.push(async () => {
    await ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const path = join(fixture.directory, "host.sqlite");
  const initialized = await openAgentHostState(path);
  initialized.close();
  const request = {
    type: "interaction.permission_requested",
    protocolVersion: 1,
    messageId: "historical-event",
    dispatchId: fixture.operation.dispatchId,
    leaseId: fixture.reservation.leaseId,
    executionAttemptId: fixture.operation.executionAttemptId,
    acpSessionId: "historical-session",
    actionId: "historical-action",
    expiresAt: "2030-01-01T00:00:30.000Z",
    title: "Old permission",
    description: "No options recorded"
  };
  const response = {
    type: "interaction.permission_response",
    dispatchId: request.dispatchId,
    leaseId: request.leaseId,
    executionAttemptId: request.executionAttemptId,
    acpSessionId: request.acpSessionId,
    actionId: request.actionId,
    decision: "allow_once"
  };
  const start = async (
    execute: AgentHostExecutor["execute"] = vi.fn(),
    expectedStopFailure?: string
  ) => {
    const state = await openAgentHostState(path);
    const relay = new DurableAcpInteractionRelay(state);
    vi.spyOn(relay, "accept");
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: fixture.host.id,
      token,
      capabilities: [],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [] },
      state,
      executor: { execute },
      interactionRelay: relay,
      allowInsecureTransport: true,
      request: remoteRunnerEventV2Request,
      reconnect: { initialDelayMs: 10_000, maxDelayMs: 10_000 }
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try {
        if (expectedStopFailure) await expect(client.stop()).rejects.toThrow(expectedStopFailure);
        else await client.stop();
      } finally {
        state.close();
      }
    };
    cleanups.push(stop);
    client.start();
    return { state, client, relay, stop };
  };
  return {
    ...fixture,
    ...coordination,
    interactions,
    path,
    request,
    response,
    start,
    ws,
    url: `ws://127.0.0.1:${address.port}/agent-hosts/${fixture.host.id}/connect`,
    token
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
export const digest = (value: unknown) => digestJson(parseHistoricalAgentHostMailboxCommand(value));
export function frameFrom(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("wire_object_required");
  return parsed as Record<string, unknown>;
}
export function captureWrites(
  drop?: (frame: Record<string, unknown>, socket: WebSocket) => boolean
) {
  const frames: Record<string, unknown>[] = [];
  const send = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, ...args) {
    const frame = frameFrom(String(args[0]));
    frames.push(frame);
    if (drop?.(frame, this)) return;
    send.apply(this, args);
  });
  return frames;
}
export async function insertOutbox(fixture: Fixture, event = fixture.request) {
  const eventJson = JSON.stringify(event, null, 2);
  const database = await openAgentHostDatabase(fixture.path, 5_000);
  try {
    database
      .prepare(
        "INSERT INTO agent_host_outbox(message_id,event_key,event_json,created_at) VALUES(?,?,?,?)"
      )
      .run(event.messageId, `history:${event.messageId}`, eventJson, "2026-07-01T00:00:00.000Z");
  } finally {
    database.close();
  }
  return eventJson;
}
export function insertMailbox(fixture: Fixture, previousSequence = 0, response = fixture.response) {
  const commandJson = JSON.stringify(response, null, 2);
  const result = fixture.server.database
    .prepare(
      "INSERT INTO mailbox_messages(message_id,host_id,previous_sequence,command_json,created_at) VALUES(?,?,?,?,?)"
    )
    .run(
      "historical-mailbox",
      fixture.host.id,
      previousSequence,
      commandJson,
      "2026-07-01T00:00:00.000Z"
    );
  return { commandJson, sequence: Number(result.lastInsertRowid) };
}
export function nextCancellation(fixture: Fixture) {
  return fixture.mailbox.enqueue(
    fixture.host.id,
    cancelExecutionCommandSchema.parse({
      type: "cancel_execution",
      protocolVersion: 1,
      dispatchId: fixture.request.dispatchId,
      leaseId: fixture.request.leaseId,
      executionAttemptId: fixture.request.executionAttemptId,
      reason: "Stop old execution"
    })
  );
}
export async function hostRow(fixture: Fixture, sql: string, value: string | number) {
  const database = await openAgentHostDatabase(fixture.path, 5_000);
  try {
    return database.prepare(sql).get(value);
  } finally {
    database.close();
  }
}

export async function connectRaw(fixture: Fixture, headers: Record<string, string>) {
  const socket = new WebSocket(fixture.url, {
    headers: { Authorization: `Bearer ${fixture.token}`, ...headers }
  });
  cleanups.push(() => {
    socket.terminate();
  });
  const frames: Record<string, unknown>[] = [];
  socket.on("message", (data) => frames.push(frameFrom(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "host.hello",
      protocolVersion: 1,
      supportedExecutionEnvelopeVersions: [1, 2],
      lastAcknowledgedSequence: 0,
      capabilities: [],
      capacity: 1
    })
  );
  await vi.waitFor(() =>
    expect(frames).toContainEqual(expect.objectContaining({ type: "host.welcome" }))
  );
  return { socket, frames };
}

export function queueExecution(fixture: Fixture) {
  const example = executeBlockCommandSchema.parse(
    mailboxDeliverySchema.parse(exampleExecuteDelivery).command
  );
  const envelope = executionEnvelopeSchema.parse({
    ...example.envelope,
    execution: {
      dispatchId: fixture.request.dispatchId,
      attemptId: fixture.request.executionAttemptId
    }
  });
  return fixture.mailbox.enqueue(
    fixture.host.id,
    executeBlockCommandSchema.parse({
      ...example,
      dispatchId: fixture.request.dispatchId,
      executionAttemptId: fixture.request.executionAttemptId,
      leaseId: fixture.request.leaseId,
      leaseExpiresAt: fixture.reservation.leaseExpiresAt,
      envelope,
      envelopeDigest: hashExecutionEnvelope(envelope)
    })
  );
}
export async function updateHost(
  fixture: Fixture,
  sql: string,
  ...values: Array<string | number | null>
) {
  const database = await openAgentHostDatabase(fixture.path, 5_000);
  try {
    database.prepare(sql).run(...values);
  } finally {
    database.close();
  }
}
export async function seedHistoricalInbox(fixture: Fixture, processed: boolean) {
  const execution = queueExecution(fixture);
  const historical = insertMailbox(fixture, execution.sequence);
  const state = await openAgentHostState(fixture.path);
  try {
    state.receive(
      mailboxDeliverySchema.parse({
        type: "mailbox.message",
        protocolVersion: 1,
        sequence: execution.sequence,
        previousSequence: 0,
        messageId: execution.messageId,
        command: execution.command
      })
    );
    state.receive(
      historicalPermissionMailboxReplaySchema.parse({
        type: "mailbox.permission_history",
        protocolVersion: 1,
        sequence: historical.sequence,
        previousSequence: execution.sequence,
        messageId: "historical-mailbox",
        commandJson: historical.commandJson
      })
    );
  } finally {
    state.close();
  }
  await updateHost(
    fixture,
    "UPDATE agent_host_inbox SET processed_at=? WHERE sequence=?",
    processed ? "2026-07-01T00:00:01.000Z" : null,
    historical.sequence
  );
  return { execution, historical };
}
