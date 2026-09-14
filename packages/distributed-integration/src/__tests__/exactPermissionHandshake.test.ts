import { startPlanweaveServer } from "../../../server/src/lifecycle.js";
import { AgentHostRepository } from "../../../server/src/hosts.js";
import { HostEventInbox } from "../../../server/src/hostEvents.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  EXACT_PERMISSION_OPTIONS_VERSION_HEADER,
  acpConversationPromptCommandSchema,
  exampleExecutionEnvelopeInput,
  exampleExecuteDelivery,
  executeBlockCommandSchema,
  hostEventSchema,
  mailboxDeliverySchema
} from "@planweave-ai/agent-host-protocol";
import { openAgentHostState } from "../../../agent-host/src/state/agentHostState.js";
import { AgentHostClient } from "../../../agent-host/src/transport/agentHostClient.js";
import { RemoteAcpConversationService } from "../../../agent-host/src/execution/remoteAcpConversationService.js";
import type { RemoteAcpExecutor } from "../../../agent-host/src/execution/remoteAcpExecutor.js";
import { acpCapabilitySnapshotTestValue } from "../../../agent-host/src/__tests__/support/acpCapabilitySnapshotTestValues.js";
import { remoteRunnerEventV2Request } from "../../../agent-host/src/__tests__/support/remoteRunnerEventCapabilityTestValues.js";

const exampleExecutionCommand = executeBlockCommandSchema.parse(
  mailboxDeliverySchema.parse(exampleExecuteDelivery).command
);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("exact permission connection compatibility", () => {
  it("recovers queued work only after a compatible welcome, once per explicit start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-permission-recover-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const state = await openAgentHostState(join(directory, "state.sqlite"));
    cleanups.push(() => state.close());
    const command = acpConversationPromptCommandSchema.parse({
      type: "acp_conversation.prompt",
      protocolVersion: 1,
      operationId: "queued-operation",
      turnId: "queued-turn",
      executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
      sessionId: "queued-session",
      text: "Persisted follow-up",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
    });
    state.receive(
      mailboxDeliverySchema.parse({
        type: "mailbox.message",
        protocolVersion: 1,
        messageId: "queued-message",
        previousSequence: 0,
        sequence: 1,
        command
      })
    );
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(
      async (_command, _broker, _sink, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", message: "cancelled" }),
            { once: true }
          );
        })
    );
    const conversations = new RemoteAcpConversationService(state.conversations, { converse });
    const recoverConversations = vi.spyOn(conversations, "recover");
    const canvasRuntime = {
      recover: vi.fn(),
      disconnect: vi.fn(),
      enabled: () => true,
      handle: vi.fn(),
      synchronizeServerTime: vi.fn(),
      updateCredentialToken: vi.fn()
    };
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("test_port_required");
    cleanups.push(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    let connections = 0;
    let helloCount = 0;
    let welcome: (() => void) | undefined;
    server.on("connection", (socket) => {
      const current = ++connections;
      socket.on("message", (data) => {
        if (JSON.parse(data.toString()).type !== "host.hello") return;
        helloCount += 1;
        welcome = () =>
          socket.send(
            JSON.stringify({
              type: "host.welcome",
              protocolVersion: 1,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: 60_000,
              leaseDurationMs: 60_000,
              ...(current === 1 ? {} : { exactPermissionOptionsVersion: 1 })
            })
          );
      });
    });
    let releaseDiscovery!: () => void;
    const discovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const request = vi.fn<typeof fetch>(async (input, init) => {
      await discovery;
      return remoteRunnerEventV2Request(input, init);
    });
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: "queued-host",
      token: "test-token",
      capabilities: [],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      state,
      executor: { execute: vi.fn() },
      conversations,
      canvasRuntime,
      request,
      allowInsecureTransport: true,
      reconnect: { initialDelayMs: 1, maxDelayMs: 1 }
    });
    cleanups.push(async () => {
      releaseDiscovery();
      await client.stop();
    });
    client.start();
    expect(request).toHaveBeenCalledTimes(1);
    expect(connections).toBe(0);
    expect(converse).not.toHaveBeenCalled();
    expect(canvasRuntime.recover).not.toHaveBeenCalled();
    releaseDiscovery();
    await vi.waitFor(() => expect(helloCount).toBe(1));
    expect(converse).not.toHaveBeenCalled();
    welcome?.();
    await vi.waitFor(() =>
      expect(client.status()).toEqual({
        state: "degraded",
        reason: "exact_permission_options_unsupported"
      })
    );
    expect(recoverConversations).not.toHaveBeenCalled();
    expect(canvasRuntime.recover).not.toHaveBeenCalled();
    expect(converse).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      client.start();
      expect(helloCount).toBe(2);
    });
    expect(converse).not.toHaveBeenCalled();
    welcome?.();
    await vi.waitFor(() => expect(converse).toHaveBeenCalledTimes(1));
    expect(recoverConversations).toHaveBeenCalledTimes(1);
    expect(canvasRuntime.recover).toHaveBeenCalledTimes(1);
    for (const socket of server.clients) socket.close(1012, "reconnect");
    await vi.waitFor(() => expect(helloCount).toBe(3));
    welcome?.();
    await vi.waitFor(() => expect(client.status().state).toBe("connected"));
    expect(recoverConversations).toHaveBeenCalledTimes(1);
    expect(canvasRuntime.recover).toHaveBeenCalledTimes(1);
    expect(converse).toHaveBeenCalledTimes(1);
    expect(conversations.isSessionActive(command.sessionId)).toBe(true);
    expect(
      state.pendingEvents().filter((event) => event.type === "acp_conversation.event")
    ).toEqual([
      expect.objectContaining({ payload: { kind: "status", status: "running", error: null } })
    ]);
    await client.stop();
    client.start();
    await vi.waitFor(() => expect(helloCount).toBe(4));
    welcome?.();
    await vi.waitFor(() => expect(recoverConversations).toHaveBeenCalledTimes(2));
    expect(canvasRuntime.recover).toHaveBeenCalledTimes(2);
    expect(converse).toHaveBeenCalledTimes(1);
  });
  it("retains the original event through lost ACK, old Server downgrade and upgraded reconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-permission-handshake-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const receiptServer = await startPlanweaveServer({
      dataDirectory: join(directory, "server"),
      databasePath: join(directory, "server.sqlite"),
      busyTimeoutMs: 5_000
    });
    cleanups.push(() => receiptServer.close());
    const host = new AgentHostRepository(receiptServer.database).register(
      "Permission handshake Host"
    ).host;
    const inbox = new HostEventInbox(receiptServer.database);
    const applyPermission = vi.fn();
    let receiptFingerprint: string | undefined;
    const state = await openAgentHostState(join(directory, "state.sqlite"));
    cleanups.push(() => state.close());
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("test_port_required");
    cleanups.push(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    const execute = mailboxDeliverySchema.parse({
      ...exampleExecuteDelivery,
      command: { ...exampleExecutionCommand, leaseExpiresAt: "2030-01-01T00:00:00.000Z" }
    });
    const permissionOptions = [
      { optionId: "always", label: "Always allow", kind: "allow_always" as const },
      { optionId: "once", label: "Allow once", kind: "allow_once" as const }
    ];
    let connection = 0;
    let receivedOriginal: string | undefined;
    let originalMessageId: string | undefined;
    let replayedOriginal: string | undefined;
    let downgradedEvents = 0;
    let aborted = false;
    const receive = vi.spyOn(state, "receive");
    server.on("connection", (socket, request) => {
      const current = ++connection;
      expect(request.headers[EXACT_PERMISSION_OPTIONS_VERSION_HEADER]).toBe("1");
      socket.on("message", (data) => {
        const raw = data.toString();
        const message = JSON.parse(raw);
        if (message.type === "host.hello") {
          socket.send(
            JSON.stringify({
              type: "host.welcome",
              protocolVersion: 1,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: 60_000,
              leaseDurationMs: 60_000,
              ...(current === 2 ? {} : { exactPermissionOptionsVersion: 1 })
            })
          );
          if (current === 1) socket.send(JSON.stringify(execute));
          if (current === 2) {
            socket.send(
              JSON.stringify({
                ...execute,
                sequence: 2,
                previousSequence: 1,
                messageId: "queued-old-command"
              })
            );
            socket.send(
              JSON.stringify({
                type: "protocol.error",
                protocolVersion: 1,
                code: "old_error",
                message: "Old error"
              })
            );
          }
          return;
        }
        if (current === 2) downgradedEvents += 1;
        const event = hostEventSchema.parse(message);
        if (event.type === "interaction.permission_requested") {
          expect(event.options).toEqual(permissionOptions);
          const applied = inbox.process(
            host.id,
            event.messageId,
            event.type,
            event,
            applyPermission
          );
          const receipt = receiptServer.database
            .prepare(
              "SELECT request_fingerprint FROM host_event_receipts WHERE host_id=? AND message_id=?"
            )
            .get(host.id, event.messageId);
          if (current === 1) {
            expect(applied).toBe(true);
            receiptFingerprint = String(receipt?.request_fingerprint);
            originalMessageId = event.messageId;
            receivedOriginal = raw;
            socket.close(1012, "lost acknowledgement");
            return;
          }
          if (current === 3) {
            expect(applied).toBe(false);
            expect(receipt?.request_fingerprint).toBe(receiptFingerprint);
            replayedOriginal = raw;
          }
        }
        socket.send(
          JSON.stringify({ type: "host.event_ack", protocolVersion: 1, messageId: event.messageId })
        );
      });
    });
    const executor = vi.fn(
      async (command: typeof exampleExecutionCommand, context: { signal: AbortSignal }) => {
        const identity = {
          dispatchId: command.dispatchId,
          leaseId: command.leaseId,
          executionAttemptId: command.executionAttemptId
        };
        state.append({
          kind: "engine_event",
          identity,
          event: {
            sequence: 1,
            timestamp: new Date().toISOString(),
            kind: "capability_snapshot",
            snapshot: acpCapabilitySnapshotTestValue()
          }
        });
        state.append({
          kind: "engine_event",
          identity,
          event: {
            sequence: 2,
            timestamp: new Date().toISOString(),
            kind: "session_started",
            sessionId: "permission-session",
            loaded: false
          }
        });
        state.append({
          kind: "permission_request",
          identity,
          deadline: "2030-01-01T00:00:00.000Z",
          request: {
            requestId: "permission-action",
            sessionId: "permission-session",
            toolCallId: "tool",
            summary: "Allow tool",
            options: permissionOptions
          }
        });
        await new Promise<void>((resolve) =>
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true }
          )
        );
        return {
          summary: "Aborted",
          reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
          artifactRefs: []
        };
      }
    );
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: host.id,
      token: "test-token",
      capabilities: [],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      state,
      executor: { execute: executor },
      request: remoteRunnerEventV2Request,
      allowInsecureTransport: true,
      reconnect: { initialDelayMs: 1, maxDelayMs: 1 },
      limits: { shutdownTimeoutMs: 100 },
      random: () => 0
    });
    cleanups.push(() => client.stop());
    client.start();
    await vi.waitFor(() =>
      expect(client.status()).toEqual({
        state: "degraded",
        reason: "exact_permission_options_unsupported"
      })
    );
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(connection).toBe(2);
    expect(downgradedEvents).toBe(0);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(state.pendingEvents().some((event) => event.messageId === originalMessageId)).toBe(true);
    await vi.waitFor(() => {
      client.start();
      expect(connection).toBe(3);
    });
    await vi.waitFor(() => expect(replayedOriginal).toBe(receivedOriginal));
    expect(originalMessageId).toBeDefined();
    expect(receivedOriginal).toBeDefined();
    expect(applyPermission).toHaveBeenCalledTimes(1);
    const original = hostEventSchema.parse(JSON.parse(receivedOriginal ?? "null"));
    if (original.type !== "interaction.permission_requested")
      throw new Error("permission_event_required");
    expect(() =>
      inbox.process(
        host.id,
        original.messageId,
        original.type,
        {
          ...original,
          options: [...original.options].reverse()
        },
        applyPermission
      )
    ).toThrow("host_event_message_id_reused");
    expect(applyPermission).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(state.pendingEvents().some((event) => event.messageId === originalMessageId)).toBe(
        false
      )
    );
    expect(executor).toHaveBeenCalledTimes(1);
  });
  it("keeps degraded status and blocks restart when compatibility shutdown times out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-permission-shutdown-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const state = await openAgentHostState(join(directory, "state.sqlite"));
    cleanups.push(() => state.close());
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("test_port_required");
    cleanups.push(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    let connections = 0;
    server.on("connection", (socket) => {
      const current = ++connections;
      socket.on("message", (data) => {
        if (JSON.parse(data.toString()).type !== "host.hello") return;
        socket.send(
          JSON.stringify({
            type: "host.welcome",
            protocolVersion: 1,
            serverTime: new Date().toISOString(),
            heartbeatIntervalMs: 60_000,
            leaseDurationMs: 60_000,
            ...(current === 1 ? {} : { exactPermissionOptionsVersion: 1 })
          })
        );
      });
    });
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logger = { log: vi.fn() };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: "permission-shutdown-host",
      token: "test-token",
      capabilities: [],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      state,
      executor: { execute: vi.fn() },
      request: remoteRunnerEventV2Request,
      conversations: {
        recover: vi.fn(),
        handle: vi.fn(),
        isSessionActive: () => true,
        stop: () => cleanup
      },
      logger,
      allowInsecureTransport: true,
      limits: { shutdownTimeoutMs: 10 }
    });
    cleanups.push(async () => {
      release();
      await client.stop();
    });
    client.start();
    await vi.waitFor(() =>
      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "host_permission_compatibility_shutdown_failed",
          reason: "agent_host_transport_shutdown_timeout"
        })
      )
    );
    expect(client.status()).toEqual({
      state: "degraded",
      reason: "exact_permission_options_unsupported"
    });
    client.start();
    expect(connections).toBe(1);
    release();
    await client.stop();
    client.start();
    await vi.waitFor(() => expect(client.status().state).toBe("connected"));
    expect(connections).toBe(2);
  });
});
