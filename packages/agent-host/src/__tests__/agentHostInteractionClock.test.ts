import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleExecuteDelivery, mailboxDeliverySchema } from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { attachHostEventPayloadBudget } from "./support/hostTransportSocketHarness.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { CalibratedServerClock } from "../transport/calibratedServerClock.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";
import { FakeHostTransportClock } from "./support/hostTransportTestClock.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const clients: AgentHostClient[] = [];
const httpServers: HttpServer[] = [];
const webSocketServers: WebSocketServer[] = [];
const serverStart = Date.parse("2026-09-26T00:00:00.000Z");
const minute = 60_000;

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  for (const state of states.splice(0)) state.close();
  await Promise.all(webSocketServers.splice(0).map((server) => closeWebSocketServer(server)));
  await Promise.all(httpServers.splice(0).map((server) => closeHttpServer(server)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("execute interaction settlement clock domain", () => {
  it.each(
    [-10, 0, 10].flatMap((offset) =>
      ["permission", "elicitation"].flatMap((kind) =>
        [6, 16].map((elapsed) => ({ offset, kind, elapsed }))
      )
    )
  )("settles $kind after $elapsed minutes with Host offset $offset minutes", async ({
    offset,
    kind,
    elapsed
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-interaction-clock-"));
    directories.push(directory);
    const state = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(state);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(serverStart + offset * minute);
    const serverClock = new CalibratedServerClock();
    serverClock.synchronize(new Date(serverStart).toISOString());
    const command = {
      ...exampleExecuteDelivery.command,
      leaseExpiresAt: new Date(serverStart + 60 * minute).toISOString()
    };
    const identity = {
      dispatchId: command.dispatchId,
      leaseId: command.leaseId,
      executionAttemptId: command.executionAttemptId
    };
    state.receive({ ...exampleExecuteDelivery, command });
    expect(state.startExecution(exampleExecuteDelivery.sequence, serverClock.now())).toBeDefined();
    state.recordSessionEvidence(exampleExecuteDelivery.sequence, {
      sessionId: "clock-session",
      capabilitySnapshot: acpCapabilitySnapshotTestValue()
    });
    const deadline = serverClock.serverDeadline(new Date(Date.now() + 15 * minute)).toISOString();
    state.append(
      kind === "permission"
        ? {
            kind: "permission_request",
            identity,
            deadline,
            request: {
              requestId: "clock-action",
              sessionId: "clock-session",
              toolCallId: "clock-tool",
              summary: "Allow operation",
              options: [{ optionId: "allow", label: "Allow", kind: "allow_once" }]
            }
          }
        : {
            kind: "elicitation_request",
            identity,
            deadline,
            request: {
              requestId: "clock-action",
              sessionId: "clock-session",
              message: "Answer",
              requestedSchema: {}
            }
          }
    );
    expect(state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        type: `interaction.${kind}_requested`,
        expiresAt: "2026-09-26T00:15:00.000Z"
      })
    );
    vi.setSystemTime(serverStart + (offset + elapsed) * minute);
    const response = mailboxDeliverySchema.parse({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      sequence: exampleExecuteDelivery.sequence + 1,
      previousSequence: exampleExecuteDelivery.sequence,
      messageId: "clock-response",
      command: {
        ...identity,
        acpSessionId: "clock-session",
        actionId: "clock-action",
        ...(kind === "permission"
          ? {
              type: "interaction.permission_response",
              decision: "select_option",
              optionId: "allow"
            }
          : { type: "interaction.elicitation_response", outcome: "accepted", response: "yes" })
      }
    });
    const receive = () => state.receive(response, serverClock.now());
    if (elapsed < 15) {
      expect(receive).not.toThrow();
      expect(
        state.interactionSettlementByIdentity({
          ...identity,
          acpSessionId: "clock-session",
          actionId: "clock-action"
        })
      ).toEqual(response.command);
    } else {
      expect(receive).toThrow("execution_action_expired");
      expect(
        state.interactionSettlementByIdentity({
          ...identity,
          acpSessionId: "clock-session",
          actionId: "clock-action"
        })
      ).toBeUndefined();
    }
  });

  it("accepts a delayed in-budget response through the Host transport when the Host clock is fast", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(serverStart + 16 * minute);
    const directory = await mkdtemp(join(tmpdir(), "planweave-interaction-clock-client-"));
    directories.push(directory);
    const state = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(state);
    const command = {
      ...exampleExecuteDelivery.command,
      leaseExpiresAt: new Date(serverStart + 60 * minute).toISOString()
    };
    const identity = {
      dispatchId: command.dispatchId,
      leaseId: command.leaseId,
      executionAttemptId: command.executionAttemptId
    };
    state.receive({ ...exampleExecuteDelivery, command });
    expect(
      state.startExecution(exampleExecuteDelivery.sequence, new Date(serverStart))
    ).toBeDefined();
    state.recordSessionEvidence(exampleExecuteDelivery.sequence, {
      sessionId: "clock-session",
      capabilitySnapshot: acpCapabilitySnapshotTestValue()
    });
    state.append({
      kind: "permission_request",
      identity,
      deadline: new Date(serverStart + 15 * minute).toISOString(),
      request: {
        requestId: "clock-action",
        sessionId: "clock-session",
        toolCallId: "clock-tool",
        summary: "Allow operation",
        options: [{ optionId: "allow", label: "Allow", kind: "allow_once" }]
      }
    });
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    attachHostEventPayloadBudget(webSocketServer);
    webSocketServers.push(webSocketServer);
    let socket: import("ws").WebSocket | undefined;
    webSocketServer.on("connection", (connected) => {
      socket = connected;
      connected.once("message", () => {
        connected.send(
          JSON.stringify({
            type: "host.welcome",
            exactPermissionOptionsVersion: 1,
            protocolVersion: agentHostProtocolVersion,
            serverTime: new Date(serverStart + 6 * minute).toISOString(),
            heartbeatIntervalMs: 60_000,
            leaseDurationMs: 60_000,
            historicalPermissionReplayVersion: 1
          })
        );
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("expected_http_port");
    const clock = new FakeHostTransportClock(new Date(serverStart + 16 * minute));
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: "host-clock-001",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      state,
      executor: { execute: vi.fn() },
      request: remoteRunnerEventV2Request,
      clock,
      allowInsecureTransport: true
    });
    clients.push(client);
    client.start();
    await vi.waitFor(() => expect(client.status().state).toBe("connected"));
    const response = mailboxDeliverySchema.parse({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      sequence: exampleExecuteDelivery.sequence + 1,
      previousSequence: exampleExecuteDelivery.sequence,
      messageId: "clock-client-response",
      command: {
        ...identity,
        acpSessionId: "clock-session",
        actionId: "clock-action",
        type: "interaction.permission_response",
        decision: "select_option",
        optionId: "allow"
      }
    });
    socket?.send(JSON.stringify(response));
    await vi.waitFor(() =>
      expect(
        state.interactionSettlementByIdentity({
          ...identity,
          acpSessionId: "clock-session",
          actionId: "clock-action"
        })
      ).toEqual(response.command)
    );
    expect(client.status().state).toBe("connected");
  });
});
