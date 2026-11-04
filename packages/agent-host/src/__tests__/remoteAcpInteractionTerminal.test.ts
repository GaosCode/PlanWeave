import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function delivery(sequence: number) {
  const envelope = executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    session: {},
    inputArtifacts: [],
    requiredCapabilities: [],
    renderedPrompt:
      sequence === 1 ? "held-success" : sequence === 2 ? "large-permission" : "success",
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

describe("real ACP permission failure through the Host wire", () => {
  it("fails a swallowed oversized permission and keeps concurrent and subsequent executions live", async () => {
    const budget = 256 * 1024;
    const serverBudget = budget;
    const directory = await mkdtemp(join(tmpdir(), "planweave-wire-permission-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "host.sqlite");
    const state = await openAgentHostState(databasePath);
    cleanups.push(() => state.close());
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
                  lastAcknowledgedSequence: 0,
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
    const records: unknown[] = [];
    let permissionError: unknown;
    const upload = vi.fn(async () => `artifact:sha256:${"a".repeat(64)}` as const);
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: directory }) },
      runtimeWorkspaceResolver: { resolve: () => ({ cwd: directory }) },
      profileResolver: {
        resolve: () => ({
          agentId: exampleExecutionEnvelopeInput.agentId,
          capabilityPolicy: { required: [], optional: [] },
          launch: {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL(
                  "../../../runtime/src/__tests__/support/acpInteractionTerminalAgent.mjs",
                  import.meta.url
                )
              ),
              directory
            ]
          },
          env: {},
          shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 1000 }
        })
      },
      outbox: {
        append(record) {
          const before = {
            records: state.records(record.identity),
            evidence: state.executionEvidence(2),
            events: state.pendingEvents()
          };
          try {
            state.append(record);
          } catch (error) {
            permissionError = error;
            expect(record.kind).toBe("permission_request");
            expect({
              records: state.records(record.identity),
              evidence: state.executionEvidence(2),
              events: state.pendingEvents()
            }).toEqual(before);
            throw error;
          }
          records.push(record);
        }
      },
      hostCapabilities: [],
      limits: { operationTimeoutMs: 5000, interactionTimeoutMs: 1000 }
    });
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

      executor: {
        execute: (command, context) =>
          executor.execute(command, {
            ...context,
            artifacts: {
              download: async () => ({ bytes: new Uint8Array(), mediaType: "text/plain" }),
              upload
            }
          })
      }
    });
    cleanups.push(async () => {
      await writeFile(join(directory, "release-other"), "released");
      await client.stop();
    });
    client.start();
    await vi.waitFor(() => expect(client.status().state).toBe("connected"));
    if (!peer) throw new Error("expected_connected_peer");
    peer.send(JSON.stringify(delivery(1)));
    await vi.waitFor(async () =>
      expect(await readFile(join(directory, "other-started"), "utf8")).toBe("started")
    );
    peer.send(JSON.stringify(delivery(2)));
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "dispatch.failed",
          dispatchId: "wire-dispatch-2",
          failure: expect.objectContaining({ code: "acp_interaction_failed" })
        })
      )
    );
    expect(permissionError).toBeInstanceOf(Error);
    expect(String(permissionError)).toContain("agent_host_outbound_payload_too_large");
    expect(upload).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: "engine_event",
        event: expect.objectContaining({
          kind: "terminal",
          terminal: expect.objectContaining({ state: "failed", reason: "interaction_failed" })
        })
      })
    );
    expect(
      received.some(
        (event) => event.type === "dispatch.completed" && event.dispatchId === "wire-dispatch-2"
      )
    ).toBe(false);
    await vi.waitFor(() => expect(state.pendingEventCount()).toBe(0));
    expect(state.executionEvidence(1)?.status).toBe("running");
    expect(client.status().state).toBe("connected");
    await writeFile(join(directory, "release-other"), "released");
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
