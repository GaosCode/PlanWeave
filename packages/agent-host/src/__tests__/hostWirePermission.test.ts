import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_EVENT_MAX_PAYLOAD_BYTES_HEADER,
  HOST_EVENT_PAYLOAD_BUDGET_VERSION_HEADER,
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  hostEventSchema,
  hostHelloSchema,
  mailboxDeliverySchema,
  serverEventSchema,
  type HostEvent
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { agentHostRemoteExecutionRecordSchema } from "../execution/remoteExecutionRecordSchema.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { openReadonlyAgentHostDatabase } from "../state/sqliteDatabase.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delivery(sequence: number) {
  const envelope = executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    execution: { dispatchId: `wire-dispatch-${sequence}`, attemptId: `wire-attempt-${sequence}` }
  });
  return mailboxDeliverySchema.parse({
    type: "mailbox.message",
    protocolVersion: agentHostProtocolVersion,
    sequence,
    previousSequence: sequence - 1,
    messageId: `wire-mailbox-${sequence}`,
    command: {
      type: "execute_block",
      protocolVersion: agentHostProtocolVersion,
      dispatchId: envelope.execution.dispatchId,
      executionAttemptId: envelope.execution.attemptId,
      leaseId: `wire-lease-${sequence}`,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      envelopeDigest: hashExecutionEnvelope(envelope),
      envelope
    }
  });
}

describe("ordinary permission wire admission", () => {
  it.each([
    {
      name: "default 256 KiB",
      budget: 256 * 1024,
      serverBudget: 256 * 1024,
      summaryLength: 16_384
    },
    { name: "server 64 KiB", budget: 64 * 1024, serverBudget: 64 * 1024, summaryLength: 512 },
    {
      name: "local 64 KiB",
      budget: 64 * 1024,
      serverBudget: 256 * 1024,
      localBudget: 64 * 1024,
      summaryLength: 512
    }
  ])("rolls back an oversized legal permission at $name and keeps other executions live", async ({
    budget,
    serverBudget,
    localBudget,
    summaryLength
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-wire-permission-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "host.sqlite");
    const state = await openAgentHostState(databasePath);
    cleanups.push(() => state.close());
    const database = openReadonlyAgentHostDatabase(databasePath, 5_000);
    cleanups.push(() => database.close());
    const http = createServer();
    cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
    const server = new WebSocketServer({ server: http, maxPayload: serverBudget });
    cleanups.push(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.on("headers", (headers, request) => {
      if (request.headers[HOST_EVENT_PAYLOAD_BUDGET_VERSION_HEADER] === "1")
        headers.push(`${HOST_EVENT_MAX_PAYLOAD_BYTES_HEADER}: ${serverBudget}`);
    });
    const received: HostEvent[] = [];
    const protocolErrors: unknown[] = [];
    const peerErrors: Error[] = [];
    let connections = 0;
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => {
      peer = socket;
      connections += 1;
      socket.on("error", (error) => peerErrors.push(error));
      socket.on("message", (data) => {
        try {
          const raw = JSON.parse(data.toString());
          if (raw.type === "host.hello") {
            hostHelloSchema.parse(raw);
            socket.send(
              JSON.stringify(
                serverEventSchema.parse({
                  type: "host.welcome",
                  protocolVersion: agentHostProtocolVersion,
                  exactPermissionOptionsVersion: 1,
                  serverTime: new Date().toISOString(),
                  heartbeatIntervalMs: 60_000,
                  leaseDurationMs: 60_000
                })
              )
            );
            return;
          }
          const event = hostEventSchema.parse(raw);
          received.push(event);
          socket.send(
            JSON.stringify({
              type: "host.event_ack",
              protocolVersion: agentHostProtocolVersion,
              messageId: event.messageId
            })
          );
        } catch (error) {
          protocolErrors.push(error);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("expected_http_port");
    const releaseOther = deferred();
    const otherStarted = deferred();
    const attempted = deferred();
    let otherAborted = false;
    let rejection: unknown;
    let before: unknown;
    let after: unknown;
    let candidateBytes = 0;
    const snapshot = () => ({
      records: state.records({
        dispatchId: "wire-dispatch-2",
        leaseId: "wire-lease-2",
        executionAttemptId: "wire-attempt-2"
      }),
      events: state.pendingEvents(),
      evidence: state.executionEvidence(2),
      sequences: database.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all(),
      actions: database.prepare("SELECT * FROM agent_host_execution_actions").all(),
      transitions: database
        .prepare(
          "SELECT * FROM agent_host_execution_transitions WHERE inbox_sequence=2 ORDER BY sequence"
        )
        .all()
    });
    const result = {
      summary: "Other execution completed",
      reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
      artifactRefs: []
    };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: "wire-permission-host",
      token: "wire-permission-token",
      capabilities: ["test"],
      capacity: 2,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      state,
      request: remoteRunnerEventV2Request,
      allowInsecureTransport: true,
      limits: localBudget === undefined ? undefined : { maxPayloadBytes: localBudget },
      executor: {
        async execute(command, context) {
          if (command.dispatchId === "wire-dispatch-1") {
            context.signal.addEventListener(
              "abort",
              () => {
                otherAborted = true;
                releaseOther.resolve();
              },
              { once: true }
            );
            otherStarted.resolve();
            await releaseOther.promise;
            return result;
          }
          if (command.dispatchId !== "wire-dispatch-2") return result;
          state.recordSessionEvidence(2, {
            sessionId: "wire-session",
            capabilitySnapshot: acpCapabilitySnapshotTestValue()
          });
          const record = agentHostRemoteExecutionRecordSchema.parse({
            kind: "permission_request",
            identity: {
              dispatchId: command.dispatchId,
              leaseId: command.leaseId,
              executionAttemptId: command.executionAttemptId
            },
            deadline: new Date(Date.now() + 60_000).toISOString(),
            request: {
              requestId: "wire-permission",
              sessionId: "wire-session",
              toolCallId: "wire-tool",
              summary: "\u0000".repeat(summaryLength),
              options: Array.from({ length: 64 }, (_, index) => ({
                optionId: `option-${index}`,
                label: "\u0000".repeat(512),
                kind: "allow_once"
              }))
            }
          });
          if (record.kind !== "permission_request") throw new Error("expected_permission");
          const candidate = hostEventSchema.parse({
            type: "interaction.permission_requested",
            protocolVersion: agentHostProtocolVersion,
            messageId: "00000000-0000-0000-0000-000000000000",
            ...record.identity,
            acpSessionId: "wire-session",
            actionId: record.request.requestId,
            expiresAt: record.deadline,
            title: record.request.summary.slice(0, 512),
            description: record.request.summary,
            options: record.request.options
          });
          candidateBytes = Buffer.byteLength(JSON.stringify(candidate));
          before = snapshot();
          try {
            state.append(record);
          } catch (error) {
            rejection = error;
          }
          after = snapshot();
          attempted.resolve();
          throw rejection ?? new Error("oversized_permission_was_committed");
        }
      }
    });
    cleanups.push(async () => {
      releaseOther.resolve();
      await client.stop();
    });
    client.start();
    await vi.waitFor(() => expect(client.status().state).toBe("connected"));
    if (!peer) throw new Error("expected_connected_peer");
    peer.send(JSON.stringify(delivery(1)));
    await otherStarted.promise;
    peer.send(JSON.stringify(delivery(2)));
    await attempted.promise;
    expect(candidateBytes).toBeGreaterThan(budget);
    if (budget < 256 * 1024) expect(candidateBytes).toBeLessThan(256 * 1024);
    expect(
      rejection,
      `legal ${candidateBytes}-byte permission must reject before persistence`
    ).toBeInstanceOf(Error);
    expect(after).toEqual(before);
    expect(state.executionEvidence(2)).toMatchObject({ eventCursor: 0, actionCursor: 0 });
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "dispatch.failed",
          dispatchId: "wire-dispatch-2"
        })
      )
    );
    await vi.waitFor(() => expect(state.pendingEventCount()).toBe(0));
    expect(otherAborted).toBe(false);
    expect(state.executionEvidence(1)?.status).toBe("running");
    expect(client.status().state).toBe("connected");
    releaseOther.resolve();
    peer.send(JSON.stringify(delivery(3)));
    await vi.waitFor(() =>
      expect(
        received
          .filter((event) => event.type === "dispatch.completed")
          .map((event) => event.dispatchId)
          .sort()
      ).toEqual(["wire-dispatch-1", "wire-dispatch-3"])
    );
    await vi.waitFor(() => expect(state.pendingEventCount()).toBe(0));
    expect(received.some((event) => event.type === "interaction.permission_requested")).toBe(false);
    expect(state.activeLeases()).toEqual([]);
    expect(client.status().state).toBe("connected");
    expect(connections).toBe(1);
    expect(protocolErrors).toEqual([]);
    expect(peerErrors).toEqual([]);
    expect(received.every((event) => Buffer.byteLength(JSON.stringify(event)) <= budget)).toBe(
      true
    );
  });
});
