import { PresenceTransportDiagnostics } from "./presenceTransportDiagnostics.js";
import { PresenceOutboundQueue, PRESENCE_OUTBOUND_LIMITS } from "./presenceOutboundQueue.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { CANVAS_PRESENCE_MAX_FRAME_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  PRESENCE_DIAGNOSTICS_HEADER,
  PRESENCE_TRANSPORT_DIAGNOSTICS_HEADER,
  canvasPresenceClientMessageSchema,
  canvasPresenceServerMessageSchema,
  type CanvasPresenceErrorCode,
  type CanvasPresenceTransportReport
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  authenticateCollaborationForScope,
  authenticateCollaborationForProject,
  humanTransportAllowed,
  type AuthenticatedCollaborationScope,
  type HumanIdentityRepository,
  type CollaborationScopeAuthority
} from "./identity/index.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";
import type { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import {
  CanvasPresenceHub,
  CanvasPresenceHubError,
  type CanvasPresenceRemovalReason
} from "./presenceHub.js";
import { isAllowedClientOrigin } from "./clientOrigin.js";
import type { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";
import {
  AUTHORIZATION_SAFETY_CHECK_INTERVAL_MS,
  type AuthorizationChangeSignal
} from "./authorizationChangeSignal.js";

export type CanvasPresenceProjectAuthority = CollaborationScopeAuthority;

const serverClockId = randomUUID();

const PRESENCE_PATH_PATTERN =
  /^\/api\/v1\/projects\/([^/]+)\/canvases\/([^/]+)\/human\/presence(?:\?.*)?$/;

export type CanvasPresenceWebSocketOptions = {
  upgradeRouter: WebSocketUpgradeRouter;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  collaborationScopeAuthority: CanvasPresenceProjectAuthority;
  authorizationChanges: AuthorizationChangeSignal;
  maxPayloadBytes: number;
  shutdownTimeoutMs: number;
  transportAdmission: TransportAdmissionPolicy;
  allowedClientOrigins?: readonly string[];
  clock?: () => Date;
  authCheckIntervalMs?: number;
  heartbeatIntervalMs?: number;
  hub?: CanvasPresenceHub;
};

export type CanvasPresenceWebSocketServer = {
  hub: CanvasPresenceHub;
  close(): Promise<void>;
};

type PresenceRoute = {
  projectId: string;
  canvasId: string;
};
type ScopedPresenceRoute = PresenceRoute & { workspaceId: string };

function routeFromUrl(url: string | undefined): PresenceRoute | undefined {
  if (!url) return undefined;
  const match = PRESENCE_PATH_PATTERN.exec(url);
  if (!match) return undefined;
  try {
    return {
      projectId: decodeURIComponent(match[1] ?? ""),
      canvasId: decodeURIComponent(match[2] ?? "")
    };
  } catch {
    return undefined;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function closeCodeForRemoval(reason: CanvasPresenceRemovalReason): number {
  switch (reason) {
    case "revoked":
      return 4001;
    case "expired":
      return 4003;
    case "shutdown":
      return 1001;
    default:
      return 1000;
  }
}

function parseFrame(data: RawData): unknown {
  const text = data.toString();
  if (Buffer.byteLength(text, "utf8") > CANVAS_PRESENCE_MAX_FRAME_BYTES) {
    throw new Error("frame_too_large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid_message");
  }
}

export function attachCanvasPresenceWebSocketServer(
  options: CanvasPresenceWebSocketOptions
): CanvasPresenceWebSocketServer {
  const maxPayloadBytes = Math.min(options.maxPayloadBytes, CANVAS_PRESENCE_MAX_FRAME_BYTES);
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new Error("canvas_presence_websocket_payload_invalid");
  }
  if (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 100) {
    throw new Error("canvas_presence_websocket_shutdown_timeout_invalid");
  }
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  const hub =
    options.hub ??
    new CanvasPresenceHub({ clock: () => (options.clock ?? (() => new Date()))().getTime() });
  const ownsHub = options.hub === undefined;
  const sessions = new Set<WebSocket>();
  const queues = new Map<WebSocket, PresenceOutboundQueue>();
  const authCheckIntervalMs = options.authCheckIntervalMs ?? AUTHORIZATION_SAFETY_CHECK_INTERVAL_MS;
  if (!Number.isSafeInteger(authCheckIntervalMs) || authCheckIntervalMs < 25) {
    throw new Error("canvas_presence_auth_interval_invalid");
  }
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 100) {
    throw new Error("canvas_presence_heartbeat_interval_invalid");
  }

  const handleConnection = (
    socket: WebSocket,
    route: ScopedPresenceRoute,
    authorization: string | string[] | undefined,
    authenticated: AuthenticatedCollaborationScope,
    diagnostics: boolean,
    transportDiagnostics: boolean,
    connection?: CanvasPresenceTransportReport["connection"]
  ) => {
    const telemetry = new PresenceTransportDiagnostics();
    sessions.add(socket);
    let initialized = false;
    let sessionId: Parameters<CanvasPresenceHub["leave"]>[0] | undefined;
    let authorizationExpired = false;
    let closedByHub = false;
    let alive = true;
    let cleanedUp = false;
    let unsubscribeAuthorization = () => {};
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    const helloTimer = setTimeout(() => closeConnection(4002, "presence hello required"), 10_000);
    const actor = authenticated.actor;
    const humanPrincipalId = actor.humanPrincipalId;
    const deviceSessionId =
      "deviceSessionId" in actor ? actor.deviceSessionId : actor.deviceCredentialId;
    const stillAuthorized = () => {
      const current = authenticateCollaborationForScope(
        options.repository,
        options.workspaceIdentity,
        options.collaborationScopeAuthority,
        authorization,
        route.projectId,
        route.canvasId
      );
      if (!current || current.workspaceId !== route.workspaceId) return false;
      const currentActor = current.actor;
      return (
        currentActor.humanPrincipalId === humanPrincipalId &&
        ("deviceSessionId" in currentActor
          ? currentActor.deviceSessionId
          : currentActor.deviceCredentialId) === deviceSessionId
      );
    };

    const sendError = (code: CanvasPresenceErrorCode) => {
      queue.enqueue({
        type: "canvas.presence.error",
        protocolVersion: 1,
        projectId: route.projectId,
        canvasId: route.canvasId,
        code
      });
    };

    const cleanup = (removalReason: CanvasPresenceRemovalReason = "disconnect") => {
      if (cleanedUp) return;
      cleanedUp = true;
      queue.dispose();
      queues.delete(socket);
      telemetry.close();
      clearTimeout(helloTimer);
      if (authTimer) clearTimeout(authTimer);
      clearInterval(heartbeatTimer);
      unsubscribeAuthorization();
      if (sessionId && !closedByHub) hub.leave(sessionId, removalReason);
    };

    const closeConnection = (code: number, reason: string) => {
      cleanup();
      socket.close(code, reason);
    };
    const sendAuthorizationError = (code: CanvasPresenceErrorCode) => {
      const busy = queue.statistics.inFlight;
      queue.dispose();
      if (busy || socket.readyState !== WebSocket.OPEN) return;
      const text = JSON.stringify(
        canvasPresenceServerMessageSchema.parse({
          type: "canvas.presence.error",
          protocolVersion: 1,
          projectId: route.projectId,
          canvasId: route.canvasId,
          code
        })
      );
      if (
        socket.bufferedAmount + Buffer.byteLength(text, "utf8") >
        PRESENCE_OUTBOUND_LIMITS.maxBufferedBytes
      )
        return;
      try {
        socket.send(text, (error) => {
          if (error) socket.terminate();
        });
      } catch {
        socket.terminate();
      }
    };
    const expireAuthorization = () => {
      if (authorizationExpired) return;
      authorizationExpired = true;
      sendAuthorizationError("unauthorized");
      cleanup("revoked");
      socket.close(4001, "presence authorization expired");
    };
    const validateAuthorization = () => {
      try {
        if (stillAuthorized()) return true;
        expireAuthorization();
      } catch {
        sendAuthorizationError("server_error");
        closeConnection(1011, "presence authorization error");
      }
      return false;
    };
    const queue = new PresenceOutboundQueue({
      socket,
      authorize: validateAuthorization,
      onFatal: () => {
        cleanup();
        socket.terminate();
      },
      onSend: (message, bufferedBytes) =>
        transportDiagnostics &&
        (message.type === "canvas.presence.update" || message.type === "canvas.presence.leave")
          ? telemetry.beginWrite(
              bufferedBytes,
              message.type === "canvas.presence.update" ? message.trace : undefined
            )
          : undefined
    });
    queues.set(socket, queue);
    const scheduleAuthorizationSafetyCheck = () => {
      authTimer = setTimeout(() => {
        authTimer = undefined;
        if (validateAuthorization()) scheduleAuthorizationSafetyCheck();
      }, authCheckIntervalMs);
    };
    const heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        cleanup("expired");
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, heartbeatIntervalMs);
    socket.on("pong", () => {
      alive = true;
      if (sessionId) {
        try {
          hub.touch(sessionId);
        } catch {
          cleanup();
          socket.terminate();
        }
      }
    });

    const onRemoved = (reason: CanvasPresenceRemovalReason) => {
      if (cleanedUp) return;
      closedByHub = true;
      cleanup();
      socket.close(closeCodeForRemoval(reason), `presence ${reason}`);
    };

    unsubscribeAuthorization = options.authorizationChanges.subscribe(
      {
        workspaceId: route.workspaceId,
        projectId: route.projectId,
        humanPrincipalId,
        deviceSessionId
      },
      () => {
        validateAuthorization();
      }
    );
    scheduleAuthorizationSafetyCheck();

    socket.on("message", (data, isBinary) => {
      const receivedMs = performance.now();
      try {
        if (isBinary) {
          sendError("frame_too_large");
          closeConnection(1009, "binary presence frame");
          return;
        }
        if (!validateAuthorization()) return;
        let raw: unknown;
        try {
          raw = parseFrame(data);
        } catch (error) {
          const frameError = error instanceof Error ? error.message : "invalid_message";
          sendError(frameError === "frame_too_large" ? "frame_too_large" : "invalid_message");
          closeConnection(
            frameError === "frame_too_large" ? 1009 : 4000,
            "presence protocol error"
          );
          return;
        }
        const parsed = canvasPresenceClientMessageSchema.safeParse(raw);
        if (!parsed.success) {
          const protocolVersion =
            typeof raw === "object" && raw !== null && "protocolVersion" in raw
              ? (raw as { protocolVersion?: unknown }).protocolVersion
              : undefined;
          sendError(protocolVersion !== 1 ? "unsupported_version" : "invalid_message");
          closeConnection(4000, "presence protocol error");
          return;
        }
        const message = parsed.data;
        if (message.projectId !== route.projectId || message.canvasId !== route.canvasId) {
          sendError("cross_scope");
          closeConnection(4003, "presence scope mismatch");
          return;
        }
        if (!initialized) {
          if (message.type !== "canvas.presence.hello") {
            sendError("invalid_message");
            closeConnection(4000, "presence hello required");
            return;
          }
          const authenticated = authenticateCollaborationForScope(
            options.repository,
            options.workspaceIdentity,
            options.collaborationScopeAuthority,
            authorization,
            route.projectId,
            route.canvasId
          );
          if (!authenticated) {
            expireAuthorization();
            return;
          }
          const connected = hub.connect({
            scope: route,
            humanPrincipalId: authenticated.actor.humanPrincipalId,
            displayName: authenticated.actor.displayName,
            send: (outbound) => {
              if (outbound.type === "canvas.presence.update" && outbound.trace && !diagnostics) {
                const { trace: _trace, ...ordinary } = outbound;
                queue.enqueue(ordinary);
              } else queue.enqueue(outbound);
            },
            onRemoved
          });
          sessionId = connected.session.identity.sessionId;
          initialized = true;
          clearTimeout(helloTimer);
          queue.enqueue({
            type: "canvas.presence.snapshot",
            protocolVersion: 1,
            projectId: route.projectId,
            canvasId: route.canvasId,
            ...(diagnostics ? { diagnosticsVersion: 1 } : {}),
            ...(transportDiagnostics ? { transportDiagnosticsVersion: 1 } : {}),
            sessions: connected.snapshot
          });
          return;
        }
        if (message.type === "canvas.presence.probe" && transportDiagnostics && sessionId) {
          const report = telemetry.probe(
            message.probeId,
            message.captureToken,
            serverClockId,
            receivedMs,
            socket.bufferedAmount
          );
          if (report)
            queue.enqueue({
              type: "canvas.presence.probe_result",
              protocolVersion: 1,
              projectId: route.projectId,
              canvasId: route.canvasId,
              report: { ...report, ...(connection ? { connection } : {}) }
            });
          else
            queue.enqueue({
              type: "canvas.presence.probe_error",
              protocolVersion: 1,
              projectId: route.projectId,
              canvasId: route.canvasId,
              probeId: message.probeId,
              code: "rate_limited"
            });
          return;
        }
        if (message.type !== "canvas.presence.update" || !sessionId) {
          sendError("invalid_message");
          closeConnection(4000, "presence protocol error");
          return;
        }
        try {
          if (message.trace && !diagnostics) {
            sendError("invalid_message");
            return;
          }
          hub.update(
            sessionId,
            route,
            message.pointer,
            message.selectionIds,
            message.trace
              ? {
                  ...message.trace,
                  serverClockId,
                  serverReceivedMs: receivedMs,
                  serverForwardedMs: receivedMs
                }
              : undefined
          );
        } catch (error) {
          if (error instanceof CanvasPresenceHubError) {
            sendError(error.code === "server_error" ? "server_error" : error.code);
            if (error.code === "server_error" || error.code === "cross_scope") {
              closeConnection(4003, "presence update rejected");
            }
            return;
          }
          sendError("server_error");
          closeConnection(1011, "presence server error");
        }
      } catch {
        sendError("server_error");
        closeConnection(1011, "presence server error");
      }
    });
    socket.on("close", () => {
      sessions.delete(socket);
      cleanup();
    });
    socket.on("error", () => {
      cleanup();
    });
  };

  const unregister = options.upgradeRouter.register({
    matches: (request) => routeFromUrl(request.url) !== undefined,
    handle: (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const route = routeFromUrl(request.url);
      if (!route) {
        reject(socket, 403, "Forbidden");
        return;
      }
      if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
        reject(socket, 426, "Upgrade Required");
        return;
      }
      if (!isAllowedClientOrigin(request.headers, options.allowedClientOrigins)) {
        reject(socket, 403, "Forbidden");
        return;
      }
      const authenticated = authenticateCollaborationForScope(
        options.repository,
        options.workspaceIdentity,
        options.collaborationScopeAuthority,
        request.headers.authorization,
        route.projectId,
        route.canvasId
      );
      if (!authenticated) {
        const credentialActor = authenticateCollaborationForProject(
          options.repository,
          options.workspaceIdentity,
          request.headers.authorization,
          route.projectId
        );
        reject(socket, credentialActor ? 403 : 401, credentialActor ? "Forbidden" : "Unauthorized");
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
        handleConnection(
          webSocket,
          { ...route, workspaceId: authenticated.workspaceId },
          request.headers.authorization,
          authenticated,
          request.headers[PRESENCE_DIAGNOSTICS_HEADER] === "1",
          request.headers[PRESENCE_TRANSPORT_DIAGNOSTICS_HEADER] === "1",
          request.socket.localPort && request.socket.remotePort
            ? { serverPort: request.socket.localPort, clientPort: request.socket.remotePort }
            : undefined
        )
      );
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    hub,
    close() {
      closePromise ??= (async () => {
        unregister();
        for (const queue of queues.values()) queue.dispose();
        hub.close();
        for (const socket of sessions) {
          socket.close(1001, "server shutdown");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const graceful = new Promise<void>((resolve, rejectClose) => {
          webSocketServer.close((error) => (error ? rejectClose(error) : resolve()));
        });
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            for (const socket of sessions) socket.terminate();
            resolve();
          }, options.shutdownTimeoutMs);
        });
        await Promise.race([graceful, timeout]);
        if (timer) clearTimeout(timer);
        for (const socket of sessions) socket.terminate();
        await graceful;
        if (ownsHub) hub.close();
      })();
      return closePromise;
    }
  };
}

export { routeFromUrl as canvasPresenceRouteFromUrl };
