import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  CANVAS_LIVE_SYNC_MAX_FRAME_BYTES,
  CANVAS_LIVE_SYNC_PROTOCOL_VERSION
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasLiveSyncClientMessageSchema,
  canvasLiveSyncServerMessageSchema,
  type CanvasLiveSyncErrorCode,
  type CanvasLiveSyncServerMessage
} from "@planweave-ai/collaboration-protocol/canvas/live-sync";
import { type CanvasJournalEntry } from "@planweave-ai/collaboration-protocol/canvas/commands";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  authenticateCollaborationForProject,
  authenticateCollaborationForScope,
  humanTransportAllowed,
  type CollaborationAuthContext,
  type HumanIdentityRepository,
  type CollaborationScopeAuthority
} from "../identity/index.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import { isAllowedClientOrigin } from "../clientOrigin.js";
import type { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import { authorizeCanvasContent } from "./policy.js";
import type { CanvasCommandRepository, CanvasScopeKey } from "./repository.js";
import {
  AUTHORIZATION_SAFETY_CHECK_INTERVAL_MS,
  type AuthorizationChangeSignal
} from "../authorizationChangeSignal.js";

const LIVE_SYNC_PATH_PATTERN =
  /^\/api\/v1\/projects\/([^/]+)\/canvases\/([^/]+)\/human\/live(?:\?.*)?$/;

export type CanvasLiveSyncWebSocketOptions = {
  upgradeRouter: WebSocketUpgradeRouter;
  repository: CanvasCommandRepository;
  identityRepository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  authorizationChanges: AuthorizationChangeSignal;
  maxPayloadBytes: number;
  shutdownTimeoutMs: number;
  transportAdmission: TransportAdmissionPolicy;
  allowedClientOrigins?: readonly string[];
  clock?: () => Date;
  authCheckIntervalMs?: number;
};

export type CanvasLiveSyncWebSocketServer = {
  /** Called by CanvasCommandService after a durable accepted commit, never by a client frame. */
  publishAcceptedEntry(entry: CanvasJournalEntry): void;
  /** Forces active subscribers to refresh through HTTP reconnect after publication uncertainty. */
  invalidateScope(input: {
    scope: CanvasScopeKey;
    headRevision: number;
    headContentDigest: string;
  }): void;
  close(): Promise<void>;
};

type LiveRoute = { projectId: string; canvasId: string };
type AuthorizedLiveRoute = LiveRoute & { workspaceId: string; actor: CollaborationAuthContext };
type ReadAuthorization =
  | { ok: true; route: AuthorizedLiveRoute }
  | { ok: false; code: "unauthorized" | "forbidden" | "unknown_canvas" | "cross_scope" };
type Subscriber = {
  socket: WebSocket;
  lastRevision: number;
  ensureAuthorized(): boolean;
  requireCatchup(input: {
    reason: "revision_behind" | "revision_ahead" | "head_changed";
    headRevision: number;
    headContentDigest: string;
  }): void;
};

function routeFromUrl(url: string | undefined): LiveRoute | undefined {
  if (!url) return undefined;
  const match = LIVE_SYNC_PATH_PATTERN.exec(url);
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

function keyFor(scope: CanvasScopeKey): string {
  return `${scope.workspaceId}\0${scope.projectId}\0${scope.canvasId}`;
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function parseFrame(data: RawData): unknown {
  const text = data.toString();
  if (Buffer.byteLength(text, "utf8") > CANVAS_LIVE_SYNC_MAX_FRAME_BYTES) {
    throw new Error("frame_too_large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid_message");
  }
}

function send(socket: WebSocket, message: CanvasLiveSyncServerMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(canvasLiveSyncServerMessageSchema.parse(message)));
    return true;
  } catch {
    socket.terminate();
    return false;
  }
}

/**
 * Read-only accepted-operation stream. It has no mutation frames and delegates every read ACL
 * decision to the canvas policy; command write policy remains exclusively in CanvasCommandService.
 */
export function attachCanvasLiveSyncWebSocketServer(
  options: CanvasLiveSyncWebSocketOptions
): CanvasLiveSyncWebSocketServer {
  const maxPayloadBytes = Math.min(options.maxPayloadBytes, CANVAS_LIVE_SYNC_MAX_FRAME_BYTES);
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new Error("canvas_live_sync_websocket_payload_invalid");
  }
  if (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 100) {
    throw new Error("canvas_live_sync_websocket_shutdown_timeout_invalid");
  }
  const authCheckIntervalMs = options.authCheckIntervalMs ?? AUTHORIZATION_SAFETY_CHECK_INTERVAL_MS;
  if (!Number.isSafeInteger(authCheckIntervalMs) || authCheckIntervalMs < 25) {
    throw new Error("canvas_live_sync_websocket_auth_interval_invalid");
  }
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  const sessions = new Set<WebSocket>();
  const subscribers = new Map<string, Set<Subscriber>>();
  const clock = options.clock ?? (() => new Date());

  const authorizeRead = (
    authorization: string | string[] | undefined,
    route: LiveRoute
  ): ReadAuthorization => {
    const actor = authenticateCollaborationForProject(
      options.identityRepository,
      options.workspaceIdentity,
      authorization,
      route.projectId
    );
    if (!actor) return { ok: false, code: "unauthorized" };
    const read = authorizeCanvasContent({
      actor,
      projectId: route.projectId,
      canvasId: route.canvasId,
      access: options.projectAccess,
      workspaceIdentity: options.workspaceIdentity
    });
    if (!read.ok) return read;
    const authenticatedScope = authenticateCollaborationForScope(
      options.identityRepository,
      options.workspaceIdentity,
      options.collaborationScopeAuthority,
      authorization,
      route.projectId,
      route.canvasId
    );
    if (!authenticatedScope) return { ok: false, code: "unknown_canvas" };
    if (authenticatedScope.workspaceId !== read.scope.workspaceId) {
      return { ok: false, code: "cross_scope" };
    }
    return { ok: true, route: { ...read.scope, actor: authenticatedScope.actor } };
  };

  const publishAcceptedEntry = (entry: CanvasJournalEntry): void => {
    const message: CanvasLiveSyncServerMessage = {
      type: "canvas.live.accepted_entry",
      protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
      entry
    };
    const key = keyFor(entry.scope);
    const scopedSubscribers = subscribers.get(key);
    if (!scopedSubscribers) return;
    for (const subscriber of [...scopedSubscribers]) {
      if (!subscriber.ensureAuthorized()) {
        scopedSubscribers.delete(subscriber);
        continue;
      }
      if (entry.previousRevision !== subscriber.lastRevision) {
        subscriber.requireCatchup({
          reason: "head_changed",
          headRevision: entry.revision,
          headContentDigest: entry.contentDigest
        });
        scopedSubscribers.delete(subscriber);
        continue;
      }
      if (send(subscriber.socket, message)) {
        subscriber.lastRevision = entry.revision;
      } else {
        scopedSubscribers.delete(subscriber);
      }
    }
    if (scopedSubscribers.size === 0) subscribers.delete(key);
  };

  const invalidateScope = (input: {
    scope: CanvasScopeKey;
    headRevision: number;
    headContentDigest: string;
  }): void => {
    const scopedSubscribers = subscribers.get(keyFor(input.scope));
    if (!scopedSubscribers) return;
    for (const subscriber of [...scopedSubscribers]) {
      subscriber.requireCatchup({
        reason: "head_changed",
        headRevision: input.headRevision,
        headContentDigest: input.headContentDigest
      });
    }
    subscribers.delete(keyFor(input.scope));
  };

  const attachSubscriber = (scope: CanvasScopeKey, subscriber: Subscriber) => {
    const key = keyFor(scope);
    const scopedSubscribers = subscribers.get(key) ?? new Set<Subscriber>();
    scopedSubscribers.add(subscriber);
    subscribers.set(key, scopedSubscribers);
    return () => {
      scopedSubscribers.delete(subscriber);
      if (scopedSubscribers.size === 0) subscribers.delete(key);
    };
  };

  const handleConnection = (
    socket: WebSocket,
    route: AuthorizedLiveRoute,
    authorization: string | string[] | undefined
  ) => {
    sessions.add(socket);
    let initialized = false;
    let authorizationExpired = false;
    let unsubscribeSubscriber = () => {};
    let unsubscribeAuthorization = () => {};
    let cleanedUp = false;
    let helloTimer: ReturnType<typeof setTimeout> | undefined;
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    const actor = route.actor;
    const humanPrincipalId = actor.humanPrincipalId;
    const deviceSessionId =
      "deviceSessionId" in actor ? actor.deviceSessionId : actor.deviceCredentialId;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (helloTimer) clearTimeout(helloTimer);
      if (authTimer) clearTimeout(authTimer);
      unsubscribeSubscriber();
      unsubscribeAuthorization();
      sessions.delete(socket);
    };
    const currentAuthorization = (): ReadAuthorization => {
      const authorizationResult = authorizeRead(authorization, route);
      if (authorizationResult.ok) {
        const currentActor = authorizationResult.route.actor;
        const currentDeviceSessionId =
          "deviceSessionId" in currentActor
            ? currentActor.deviceSessionId
            : currentActor.deviceCredentialId;
        if (
          authorizationResult.route.workspaceId !== route.workspaceId ||
          currentActor.humanPrincipalId !== humanPrincipalId ||
          currentDeviceSessionId !== deviceSessionId
        ) {
          return { ok: false, code: "cross_scope" };
        }
      }
      return authorizationResult;
    };
    const failAuthorizationValidation = () => {
      send(socket, {
        type: "canvas.live.error",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        projectId: route.projectId,
        canvasId: route.canvasId,
        code: "server_error"
      });
      cleanup();
      socket.close(1011, "live sync authorization error");
    };
    const closeForCatchup = (input: {
      reason: "revision_behind" | "revision_ahead" | "head_changed";
      headRevision: number;
      headContentDigest: string;
    }) => {
      send(socket, {
        type: "canvas.live.catchup_required",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        projectId: route.projectId,
        canvasId: route.canvasId,
        reason: input.reason,
        recovery: "http_reconnect",
        headRevision: input.headRevision,
        headContentDigest: input.headContentDigest
      });
      cleanup();
      socket.close(4004, "live sync catchup required");
    };
    const expireAuthorization = (authorizationResult = currentAuthorization()) => {
      if (authorizationExpired) return;
      authorizationExpired = true;
      const code: Extract<
        CanvasLiveSyncErrorCode,
        "unauthorized" | "forbidden" | "unknown_canvas" | "cross_scope"
      > = authorizationResult.ok ? "unauthorized" : authorizationResult.code;
      send(socket, {
        type: "canvas.live.auth_expired",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        projectId: route.projectId,
        canvasId: route.canvasId,
        code
      });
      cleanup();
      socket.close(code === "unauthorized" ? 4001 : 4003, "live sync authorization expired");
    };
    const validateAuthorization = () => {
      try {
        const authorizationResult = currentAuthorization();
        if (authorizationResult.ok) return true;
        expireAuthorization(authorizationResult);
      } catch {
        failAuthorizationValidation();
      }
      return false;
    };
    const scheduleAuthorizationSafetyCheck = () => {
      authTimer = setTimeout(() => {
        authTimer = undefined;
        if (validateAuthorization()) scheduleAuthorizationSafetyCheck();
      }, authCheckIntervalMs);
    };
    helloTimer = setTimeout(() => {
      cleanup();
      socket.close(4002, "live sync hello required");
    }, 10_000);
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
      if (isBinary) {
        send(socket, {
          type: "canvas.live.error",
          protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
          projectId: route.projectId,
          canvasId: route.canvasId,
          code: "frame_too_large"
        });
        socket.close(1009, "binary live sync frame");
        return;
      }
      if (!validateAuthorization()) return;
      let raw: unknown;
      try {
        raw = parseFrame(data);
      } catch (error) {
        send(socket, {
          type: "canvas.live.error",
          protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
          projectId: route.projectId,
          canvasId: route.canvasId,
          code:
            error instanceof Error && error.message === "frame_too_large"
              ? "frame_too_large"
              : "invalid_message"
        });
        socket.close(
          error instanceof Error && error.message === "frame_too_large" ? 1009 : 4000,
          "live sync protocol error"
        );
        return;
      }
      const parsed = canvasLiveSyncClientMessageSchema.safeParse(raw);
      if (!parsed.success) {
        send(socket, {
          type: "canvas.live.error",
          protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
          projectId: route.projectId,
          canvasId: route.canvasId,
          code: "invalid_message"
        });
        socket.close(4000, "live sync protocol error");
        return;
      }
      const message = parsed.data;
      if (message.type === "canvas.live.ping") {
        if (!initialized) {
          send(socket, {
            type: "canvas.live.error",
            protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
            projectId: route.projectId,
            canvasId: route.canvasId,
            code: "invalid_message"
          });
          socket.close(4000, "live sync hello required");
          return;
        }
        send(socket, {
          type: "canvas.live.pong",
          protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
          serverTime: clock().toISOString()
        });
        return;
      }
      if (
        initialized ||
        message.projectId !== route.projectId ||
        message.canvasId !== route.canvasId
      ) {
        send(socket, {
          type: "canvas.live.error",
          protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
          projectId: route.projectId,
          canvasId: route.canvasId,
          code: initialized ? "invalid_message" : "cross_scope"
        });
        socket.close(4003, "live sync scope mismatch");
        return;
      }

      const firstHead = options.repository.head(route);
      if (message.lastRevision !== firstHead.revision) {
        initialized = true;
        clearTimeout(helloTimer);
        send(socket, {
          type: "canvas.live.welcome",
          protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
          projectId: route.projectId,
          canvasId: route.canvasId,
          serverTime: clock().toISOString(),
          headRevision: firstHead.revision,
          headContentDigest: firstHead.contentDigest
        });
        closeForCatchup({
          reason: message.lastRevision < firstHead.revision ? "revision_behind" : "revision_ahead",
          headRevision: firstHead.revision,
          headContentDigest: firstHead.contentDigest
        });
        return;
      }

      unsubscribeSubscriber = attachSubscriber(route, {
        socket,
        lastRevision: message.lastRevision,
        ensureAuthorized: validateAuthorization,
        requireCatchup: closeForCatchup
      });
      const secondHead = options.repository.head(route);
      if (secondHead.revision !== message.lastRevision) {
        unsubscribeSubscriber();
        initialized = true;
        clearTimeout(helloTimer);
        send(socket, {
          type: "canvas.live.welcome",
          protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
          projectId: route.projectId,
          canvasId: route.canvasId,
          serverTime: clock().toISOString(),
          headRevision: secondHead.revision,
          headContentDigest: secondHead.contentDigest
        });
        closeForCatchup({
          reason: "head_changed",
          headRevision: secondHead.revision,
          headContentDigest: secondHead.contentDigest
        });
        return;
      }
      initialized = true;
      clearTimeout(helloTimer);
      send(socket, {
        type: "canvas.live.welcome",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        projectId: route.projectId,
        canvasId: route.canvasId,
        serverTime: clock().toISOString(),
        headRevision: secondHead.revision,
        headContentDigest: secondHead.contentDigest
      });
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
      const authorization = authorizeRead(request.headers.authorization, route);
      if (!authorization.ok) {
        reject(
          socket,
          authorization.code === "unauthorized" ? 401 : 403,
          authorization.code === "unauthorized" ? "Unauthorized" : "Forbidden"
        );
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
        handleConnection(webSocket, authorization.route, request.headers.authorization)
      );
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    publishAcceptedEntry,
    invalidateScope,
    close() {
      closePromise ??= (async () => {
        unregister();
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
      })();
      return closePromise;
    }
  };
}

export { routeFromUrl as canvasLiveSyncRouteFromUrl };
