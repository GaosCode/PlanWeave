import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { CANVAS_PRESENCE_MAX_FRAME_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasPresenceClientMessageSchema,
  canvasPresenceServerMessageSchema,
  type CanvasPresenceErrorCode,
  type CanvasPresenceServerMessage
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

function send(socket: WebSocket, message: CanvasPresenceServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(canvasPresenceServerMessageSchema.parse(message)));
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
    authenticated: AuthenticatedCollaborationScope
  ) => {
    sessions.add(socket);
    let initialized = false;
    let sessionId: Parameters<CanvasPresenceHub["leave"]>[0] | undefined;
    let authorizationExpired = false;
    let closedByHub = false;
    let alive = true;
    let cleanedUp = false;
    let unsubscribeAuthorization = () => {};
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    const helloTimer = setTimeout(() => socket.close(4002, "presence hello required"), 10_000);
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
      send(socket, {
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
      clearTimeout(helloTimer);
      if (authTimer) clearTimeout(authTimer);
      clearInterval(heartbeatTimer);
      unsubscribeAuthorization();
      sessions.delete(socket);
      if (sessionId && !closedByHub) hub.leave(sessionId, removalReason);
    };

    const expireAuthorization = () => {
      if (authorizationExpired) return;
      authorizationExpired = true;
      sendError("unauthorized");
      cleanup("revoked");
      socket.close(4001, "presence authorization expired");
    };
    const validateAuthorization = () => {
      try {
        if (stillAuthorized()) return true;
        expireAuthorization();
      } catch {
        sendError("server_error");
        cleanup();
        socket.close(1011, "presence authorization error");
      }
      return false;
    };
    const scheduleAuthorizationSafetyCheck = () => {
      authTimer = setTimeout(() => {
        authTimer = undefined;
        if (validateAuthorization()) scheduleAuthorizationSafetyCheck();
      }, authCheckIntervalMs);
    };
    const heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        if (sessionId) hub.leave(sessionId, "expired");
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
          socket.terminate();
        }
      }
    });

    const onRemoved = (reason: CanvasPresenceRemovalReason) => {
      closedByHub = true;
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
      try {
        if (isBinary) {
          sendError("frame_too_large");
          socket.close(1009, "binary presence frame");
          return;
        }
        if (!validateAuthorization()) return;
        let raw: unknown;
        try {
          raw = parseFrame(data);
        } catch (error) {
          const frameError = error instanceof Error ? error.message : "invalid_message";
          sendError(frameError === "frame_too_large" ? "frame_too_large" : "invalid_message");
          socket.close(frameError === "frame_too_large" ? 1009 : 4000, "presence protocol error");
          return;
        }
        const parsed = canvasPresenceClientMessageSchema.safeParse(raw);
        if (!parsed.success) {
          const protocolVersion =
            typeof raw === "object" && raw !== null && "protocolVersion" in raw
              ? (raw as { protocolVersion?: unknown }).protocolVersion
              : undefined;
          sendError(protocolVersion !== 1 ? "unsupported_version" : "invalid_message");
          socket.close(4000, "presence protocol error");
          return;
        }
        const message = parsed.data;
        if (message.projectId !== route.projectId || message.canvasId !== route.canvasId) {
          sendError("cross_scope");
          socket.close(4003, "presence scope mismatch");
          return;
        }
        if (!initialized) {
          if (message.type !== "canvas.presence.hello") {
            sendError("invalid_message");
            socket.close(4000, "presence hello required");
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
              if (validateAuthorization()) send(socket, outbound);
            },
            onRemoved
          });
          sessionId = connected.session.identity.sessionId;
          initialized = true;
          clearTimeout(helloTimer);
          send(socket, {
            type: "canvas.presence.snapshot",
            protocolVersion: 1,
            projectId: route.projectId,
            canvasId: route.canvasId,
            sessions: connected.snapshot
          });
          return;
        }
        if (message.type !== "canvas.presence.update" || !sessionId) {
          sendError("invalid_message");
          socket.close(4000, "presence protocol error");
          return;
        }
        try {
          hub.update(sessionId, route, message.pointer, message.selectionIds);
        } catch (error) {
          if (error instanceof CanvasPresenceHubError) {
            sendError(error.code === "server_error" ? "server_error" : error.code);
            if (error.code === "server_error" || error.code === "cross_scope") {
              socket.close(4003, "presence update rejected");
            }
            return;
          }
          sendError("server_error");
          socket.close(1011, "presence server error");
        }
      } catch {
        sendError("server_error");
        socket.close(1011, "presence server error");
      }
    });
    socket.on("close", () => {
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
          authenticated
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
        hub.close();
        for (const socket of sessions) socket.close(1001, "server shutdown");
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
