import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DispatchService } from "./dispatches.js";
import { AgentHostRepository } from "./hosts.js";
import { authenticateAgentHostRequest } from "./hostTransportAuth.js";
import { DurableMailbox, type MailboxMessage } from "./mailbox.js";
import { RemoteAcpEventRepository } from "./remoteAcpEvents.js";
import type { AcpConversationService } from "./acpConversationService.js";
import { RemoteInteractionService } from "./remoteInteractions.js";
import { RemoteExecutionActionRepository } from "./remoteExecutionActions.js";
import {
  agentHostProtocolVersion,
  executionEnvelopeProtocolVersion,
  hostEventSchema,
  hostHelloSchema,
  serverEventSchema,
  type HostEvent
} from "./protocol.js";
import type { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";
import { logHostProtocolRejection, publicHostProtocolRejection } from "./hostProtocolRejection.js";
import type { CanvasRuntimeRpcBroker } from "./canvas/runtimeRpcBroker.js";

const requiredExecutionEnvelopeVersions = [1, executionEnvelopeProtocolVersion] as const;

export type AgentHostWebSocketOptions = {
  server: HttpServer;
  hosts: AgentHostRepository;
  mailbox: DurableMailbox;
  dispatches: DispatchService;
  acpEvents: RemoteAcpEventRepository;
  conversations?: AcpConversationService;
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

function logDeferredWritebackFailure(input: {
  hostId: string;
  dispatchId: string;
  error: unknown;
}): void {
  console.error(
    JSON.stringify({
      scope: "agent-host-ws",
      event: "terminal_writeback_failed",
      hostId: input.hostId,
      dispatchId: input.dispatchId,
      error: input.error instanceof Error ? input.error.message : String(input.error)
    })
  );
}

function logDeferredHostAvailabilityFailure(input: { hostId: string; error: unknown }): void {
  console.error(
    JSON.stringify({
      scope: "agent-host-ws",
      event: "host_availability_reentry_failed",
      hostId: input.hostId,
      error: input.error instanceof Error ? input.error.message : String(input.error)
    })
  );
}

export function attachAgentHostWebSocketServer(
  options: AgentHostWebSocketOptions
): AgentHostWebSocketServer {
  options.hosts.requireProtocolReauthentication();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 256 * 1024
  });
  type HostSession = {
    socket: WebSocket;
    initialized: boolean;
    processing: Promise<void>;
  };
  const sessions = new Map<string, HostSession>();
  const openSessions = new Set<HostSession>();
  const pendingWritebacks = new Map<string, Promise<void>>();
  const pendingHostAvailabilities = new Map<string, Promise<void>>();
  const rerunHostAvailabilities = new Set<string>();
  let acceptingWritebacks = true;
  let acceptingHostAvailabilities = true;
  const continueWriteback = (hostId: string, dispatchId: string): void => {
    if (!acceptingWritebacks || pendingWritebacks.has(dispatchId)) return;
    const pending = options.dispatches
      .continuePendingWriteback(dispatchId)
      .then(() => undefined)
      .catch((error: unknown) => {
        logDeferredWritebackFailure({ hostId, dispatchId, error });
      })
      .finally(() => {
        if (pendingWritebacks.get(dispatchId) === pending) pendingWritebacks.delete(dispatchId);
      });
    pendingWritebacks.set(dispatchId, pending);
  };
  const continueHostAvailability = (hostId: string): void => {
    if (!acceptingHostAvailabilities || !options.onHostAvailable) return;
    if (pendingHostAvailabilities.has(hostId)) {
      rerunHostAvailabilities.add(hostId);
      return;
    }
    const run = async () => {
      do {
        rerunHostAvailabilities.delete(hostId);
        try {
          await options.onHostAvailable?.(hostId);
        } catch (error) {
          logDeferredHostAvailabilityFailure({ hostId, error });
        }
      } while (acceptingHostAvailabilities && rerunHostAvailabilities.has(hostId));
    };
    const pending = run().finally(() => {
      if (pendingHostAvailabilities.get(hostId) === pending) {
        pendingHostAvailabilities.delete(hostId);
      }
      rerunHostAvailabilities.delete(hostId);
    });
    pendingHostAvailabilities.set(hostId, pending);
  };
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
  let closing = false;

  const handleConnection = (socket: WebSocket, hostId: string) => {
    const prior = sessions.get(hostId);
    if (prior && prior.socket.readyState === WebSocket.OPEN) {
      options.runtimeRpc?.detachHost(hostId, "superseded");
      prior.socket.close(4001, "superseded");
    }
    const session = { socket, initialized: false, processing: Promise.resolve() };
    sessions.set(hostId, session);
    openSessions.add(session);

    let initialized = false;
    let alive = true;
    let unsubscribe = () => {};
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
      let deferredWriteback: { dispatchId: string } | undefined;
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
          continueHostAvailability(hostId);
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
          {
            const recorded = options.dispatches.recordCompleted(
              hostId,
              event.messageId,
              event.dispatchId,
              event.leaseId,
              event.executionAttemptId,
              event.result
            );
            deferredWriteback =
              recorded.writebackRequired && recorded.dispatch?.status === "awaiting_writeback"
                ? { dispatchId: event.dispatchId }
                : undefined;
          }
          options.actions.settleAttemptCommands({
            dispatchId: event.dispatchId,
            executionAttemptId: event.executionAttemptId,
            kinds: ["cancel"]
          });
          break;
        case "dispatch.failed":
          {
            const recorded = options.dispatches.recordFailed(
              hostId,
              event.messageId,
              event.dispatchId,
              event.leaseId,
              event.executionAttemptId,
              event.failure
            );
            deferredWriteback =
              recorded.writebackRequired && recorded.dispatch?.status === "awaiting_writeback"
                ? { dispatchId: event.dispatchId }
                : undefined;
          }
          options.actions.settleAttemptCommands({
            dispatchId: event.dispatchId,
            executionAttemptId: event.executionAttemptId,
            kinds: ["cancel"]
          });
          break;
        case "lease.renew":
          throw new Error(`host_event_unsupported:${event.type}`);
        case "acp_conversation.event":
          if (!options.conversations) throw new Error("acp_conversation_unavailable");
          options.conversations.ingest(hostId, event);
          break;
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
      if (deferredWriteback) continueWriteback(hostId, deferredWriteback.dispatchId);
    };

    socket.on("message", (data, isBinary) => {
      if (closing) return;
      session.processing = session.processing
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
            if (
              !hello.supportedExecutionEnvelopeVersions ||
              requiredExecutionEnvelopeVersions.some(
                (version) => !hello.supportedExecutionEnvelopeVersions?.includes(version)
              )
            ) {
              options.hosts.reportProtocolIncompatible(hostId);
              throw new Error("execution_envelope_version_incompatible");
            }
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
            continueHostAvailability(hostId);
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
      openSessions.delete(session);
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
        closing = true;
        acceptingHostAvailabilities = false;
        rerunHostAvailabilities.clear();
        unregisterUpgrade();
        const shutdownDeadline = Date.now() + shutdownTimeoutMs;
        const waitWithinShutdownBudget = async (work: Promise<unknown>): Promise<boolean> => {
          const remainingMs = shutdownDeadline - Date.now();
          if (remainingMs <= 0) return false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const outcome = await Promise.race([
            work.then(() => "settled" as const),
            new Promise<"timed_out">((resolve) => {
              timer = setTimeout(() => resolve("timed_out"), remainingMs);
            })
          ]);
          if (timer) clearTimeout(timer);
          return outcome === "settled";
        };
        const closingSessions = [...openSessions];
        const processingDrained = await waitWithinShutdownBudget(
          Promise.allSettled(closingSessions.map(({ processing }) => processing))
        );
        if (!processingDrained) acceptingWritebacks = false;
        for (const { socket } of closingSessions) socket.close(1001, "server shutdown");
        let closeError: Error | undefined;
        const graceful = new Promise<void>((resolve) => {
          webSocketServer.close((error) => {
            closeError = error;
            resolve();
          });
        });
        const socketsClosed = await waitWithinShutdownBudget(graceful);
        if (!socketsClosed) for (const { socket } of closingSessions) socket.terminate();
        const drainPendingWritebacks = async (): Promise<void> => {
          while (pendingWritebacks.size > 0) {
            await Promise.allSettled([...pendingWritebacks.values()]);
          }
        };
        await waitWithinShutdownBudget(drainPendingWritebacks());
        acceptingWritebacks = false;
        await waitWithinShutdownBudget(Promise.allSettled([...pendingHostAvailabilities.values()]));
        if (closeError) throw closeError;
      })();
      return closePromise;
    }
  };
}
