import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DispatchService } from "./dispatches.js";
import { AgentHostRepository } from "./hosts.js";
import { authenticateAgentHostRequest } from "./hostTransportAuth.js";
import { DurableMailbox, type MailboxMessage } from "./mailbox.js";
import { RemoteAcpEventRepository } from "./remoteAcpEvents.js";
import { RemoteInteractionService } from "./remoteInteractions.js";
import { RemoteExecutionActionRepository } from "./remoteExecutionActions.js";
import {
  agentHostProtocolVersion,
  hostEventSchema,
  hostHelloSchema,
  serverEventSchema,
  type HostEvent
} from "./protocol.js";
import type { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";
import { logHostProtocolRejection, publicHostProtocolRejection } from "./hostProtocolRejection.js";
import type { CanvasRuntimeRpcBroker } from "./canvas/runtimeRpcBroker.js";

export type AgentHostWebSocketOptions = {
  server: HttpServer;
  hosts: AgentHostRepository;
  mailbox: DurableMailbox;
  dispatches: DispatchService;
  acpEvents: RemoteAcpEventRepository;
  interactions: RemoteInteractionService;
  actions: RemoteExecutionActionRepository;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  maxPayloadBytes?: number;
  shutdownTimeoutMs?: number;
  transportAdmission: TransportAdmissionPolicy;
  upgradeRouter?: WebSocketUpgradeRouter;
  onHostAvailable?: (hostId: string) => Promise<void>;
  runtimeRpc?: CanvasRuntimeRpcBroker;
};

export type AgentHostWebSocketServer = {
  disconnectHost(hostId: string): void;
  close(): Promise<void>;
};

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function hostIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^\/agent-hosts\/([^/]+)\/connect(?:\?.*)?$/.exec(url);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function sendEvent(socket: WebSocket, event: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(serverEventSchema.parse(event)));
}

function sendMailboxMessage(socket: WebSocket, message: MailboxMessage): void {
  sendEvent(socket, {
    type: "mailbox.message",
    protocolVersion: agentHostProtocolVersion,
    sequence: message.sequence,
    previousSequence: message.previousSequence,
    messageId: message.messageId,
    command: message.command
  });
}

export function attachAgentHostWebSocketServer(
  options: AgentHostWebSocketOptions
): AgentHostWebSocketServer {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 256 * 1024
  });
  const sessions = new Map<string, { socket: WebSocket; initialized: boolean }>();
  options.runtimeRpc?.attachSessionLookup({
    isActive(hostId) {
      const session = sessions.get(hostId);
      return session?.initialized === true && session.socket.readyState === WebSocket.OPEN;
    }
  });
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100) {
    throw new Error("agent_host_websocket_shutdown_timeout_invalid");
  }

  const handleConnection = (socket: WebSocket, hostId: string) => {
    const prior = sessions.get(hostId);
    if (prior && prior.socket.readyState === WebSocket.OPEN) {
      options.runtimeRpc?.detachHost(hostId, "superseded");
      prior.socket.close(4001, "superseded");
    }
    const session = { socket, initialized: false };
    sessions.set(hostId, session);

    let initialized = false;
    let alive = true;
    let unsubscribe = () => {};
    let processing = Promise.resolve();
    const helloTimeout = setTimeout(() => socket.close(4002, "host.hello required"), 10_000);
    const pingTimer = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, options.heartbeatIntervalMs);

    socket.on("pong", () => {
      alive = true;
    });

    const handleHostEvent = async (event: HostEvent): Promise<void> => {
      switch (event.type) {
        case "mailbox.ack":
          options.actions.acknowledgeMailbox(
            options.mailbox.acknowledge(hostId, event.messageId, event.sequence).messageId
          );
          break;
        case "host.heartbeat": {
          options.interactions.expireDue();
          const renewed = options.dispatches.heartbeat(
            hostId,
            event.messageId,
            event.activeLeases,
            event.readiness
          );
          for (const lease of renewed)
            sendEvent(socket, {
              type: "lease.renewed",
              protocolVersion: agentHostProtocolVersion,
              ...lease
            });
          await options.onHostAvailable?.(hostId);
          break;
        }
        case "dispatch.accepted":
          options.dispatches.accept(
            hostId,
            event.messageId,
            event.dispatchId,
            event.leaseId,
            event.executionAttemptId
          );
          options.actions.settleAttemptCommands({
            dispatchId: event.dispatchId,
            executionAttemptId: event.executionAttemptId,
            kinds: ["resume_same_session"]
          });
          break;
        case "dispatch.progress":
          options.dispatches.recordProgress(hostId, event.messageId, event);
          break;
        case "dispatch.interrupted":
          options.dispatches.interrupt(hostId, event.messageId, event);
          break;
        case "dispatch.completed":
          await options.dispatches.complete(
            hostId,
            event.messageId,
            event.dispatchId,
            event.leaseId,
            event.executionAttemptId,
            event.result
          );
          options.actions.settleAttemptCommands({
            dispatchId: event.dispatchId,
            executionAttemptId: event.executionAttemptId,
            kinds: ["cancel"]
          });
          break;
        case "dispatch.failed":
          await options.dispatches.fail(
            hostId,
            event.messageId,
            event.dispatchId,
            event.leaseId,
            event.executionAttemptId,
            event.failure
          );
          options.actions.settleAttemptCommands({
            dispatchId: event.dispatchId,
            executionAttemptId: event.executionAttemptId,
            kinds: ["cancel"]
          });
          break;
        case "lease.renew":
          throw new Error(`host_event_unsupported:${event.type}`);
        case "acp.events": {
          const { protocolVersion: _protocolVersion, messageId: _messageId, ...batch } = event;
          const ingested = options.acpEvents.ingest(hostId, event.messageId, batch);
          // Soft-dropped stale batches (old lease / terminal attempt) are acked without renew.
          if (ingested.accepted) {
            const renewed = options.dispatches.renewLeaseForActivity(hostId, event);
            if (renewed) {
              sendEvent(socket, {
                type: "lease.renewed",
                protocolVersion: agentHostProtocolVersion,
                ...renewed
              });
            }
          }
          break;
        }
        case "interaction.permission_requested":
        case "interaction.elicitation_requested":
        case "interaction.authentication_required": {
          const { protocolVersion: _protocolVersion, messageId: _messageId, ...request } = event;
          options.interactions.recordRequest(hostId, event.messageId, request);
          break;
        }
        case "canvas_runtime.response":
          options.runtimeRpc?.handleResponse(hostId, event);
          break;
      }
      sendEvent(socket, {
        type: "host.event_ack",
        protocolVersion: agentHostProtocolVersion,
        messageId: event.messageId
      });
    };

    socket.on("message", (data, isBinary) => {
      processing = processing
        .then(async () => {
          if (isBinary) throw new Error("binary_messages_not_supported");
          let input: unknown;
          try {
            input = JSON.parse(data.toString());
          } catch {
            throw new Error("invalid_json");
          }
          if (!initialized) {
            const hello = hostHelloSchema.parse(input);
            const storedHost = options.hosts.getRequired(hostId);
            if (hello.lastAcknowledgedSequence > storedHost.lastAcknowledgedSequence) {
              throw new Error("mailbox_cursor_not_acknowledged");
            }
            options.hosts.reportOnline(hostId, hello.capabilities, hello.capacity, hello.readiness);
            initialized = true;
            session.initialized = true;
            clearTimeout(helloTimeout);
            unsubscribe = options.mailbox.subscribe(hostId, (message) =>
              sendMailboxMessage(socket, message)
            );
            sendEvent(socket, {
              type: "host.welcome",
              protocolVersion: agentHostProtocolVersion,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: options.heartbeatIntervalMs,
              leaseDurationMs: options.leaseDurationMs
            });
            for (const message of options.mailbox.listAfter(
              hostId,
              hello.lastAcknowledgedSequence
            )) {
              sendMailboxMessage(socket, message);
            }
            await options.onHostAvailable?.(hostId);
            return;
          }
          await handleHostEvent(hostEventSchema.parse(input));
        })
        .catch((error: unknown) => {
          const phase = initialized ? "event" : "hello";
          const publicRejection = publicHostProtocolRejection(error);
          logHostProtocolRejection({ hostId, phase, error, publicRejection });
          sendEvent(socket, {
            type: "protocol.error",
            protocolVersion: agentHostProtocolVersion,
            code: publicRejection.code,
            message: publicRejection.message
          });
        });
    });

    socket.on("close", () => {
      clearTimeout(helloTimeout);
      clearInterval(pingTimer);
      unsubscribe();
      if (sessions.get(hostId) === session) {
        sessions.delete(hostId);
        options.runtimeRpc?.detachHost(hostId, "disconnected");
      }
    });
  };

  const upgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const hostId = hostIdFromUrl(request.url);
    if (!hostId) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const authentication = authenticateAgentHostRequest(
      request,
      options.hosts,
      hostId,
      options.transportAdmission
    );
    if (!authentication.ok) {
      rejectUpgrade(socket, authentication.status, authentication.message);
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      handleConnection(webSocket, hostId);
    });
  };

  const unregisterUpgrade = options.upgradeRouter
    ? options.upgradeRouter.register({
        matches: (request) => hostIdFromUrl(request.url) !== undefined,
        handle: upgradeListener
      })
    : (() => {
        options.server.on("upgrade", upgradeListener);
        return () => options.server.off("upgrade", upgradeListener);
      })();

  let closePromise: Promise<void> | undefined;
  return {
    disconnectHost(hostId) {
      const session = sessions.get(hostId);
      if (session) session.initialized = false;
      options.runtimeRpc?.detachHost(hostId, "revoked");
      session?.socket.close(4003, "host revoked");
    },
    close: () => {
      closePromise ??= (async () => {
        unregisterUpgrade();
        for (const { socket } of sessions.values()) socket.close(1001, "server shutdown");
        let closeError: Error | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const graceful = new Promise<void>((resolve) => {
          webSocketServer.close((error) => {
            closeError = error;
            resolve();
          });
        });
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            for (const { socket } of sessions.values()) socket.terminate();
            resolve();
          }, shutdownTimeoutMs);
        });
        await Promise.race([graceful, timeout]);
        if (timer) clearTimeout(timer);
        if (sessions.size > 0) {
          for (const { socket } of sessions.values()) socket.terminate();
        }
        await graceful;
        if (closeError) throw closeError;
      })();
      return closePromise;
    }
  };
}
