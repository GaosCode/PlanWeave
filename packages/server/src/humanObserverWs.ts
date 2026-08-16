import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  humanObserverClientMessageSchema,
  humanObserverServerMessageSchema
} from "@planweave-ai/collaboration-protocol/activity/observer";
import { WebSocket, WebSocketServer } from "ws";
import {
  authenticateCollaborationForProject,
  authenticateCollaborationForScope,
  hasAuthenticatedCollaborationDevice,
  humanTransportAllowed,
  type AuthenticatedCollaborationScope,
  type HumanIdentityRepository,
  type HumanProjectAuthority
} from "./identity/index.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";
import { isAllowedClientOrigin } from "./clientOrigin.js";
import type { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import {
  HUMAN_OBSERVER_REPLAY_LIMITS,
  type HumanObserverJournal,
  type HumanObserverReplayLimits,
  type HumanObserverScope
} from "./humanObserverJournal.js";
import type { ProjectAccessRepository } from "./projectAccessRepository.js";
import type { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";
import {
  AUTHORIZATION_SAFETY_CHECK_INTERVAL_MS,
  type AuthorizationChangeSignal
} from "./authorizationChangeSignal.js";

export type HumanObserverWebSocketOptions = {
  upgradeRouter: WebSocketUpgradeRouter;
  journal: HumanObserverJournal;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  projectAuthority: HumanProjectAuthority;
  authorizationChanges: AuthorizationChangeSignal;
  maxPayloadBytes: number;
  shutdownTimeoutMs: number;
  transportAdmission: TransportAdmissionPolicy;
  allowedClientOrigins?: readonly string[];
  clock?: () => Date;
  deliveryLimits?: HumanObserverDeliveryLimits;
  authorizationSafetyCheckIntervalMs?: number;
};

export const HUMAN_OBSERVER_AUTHORIZATION_SAFETY_INTERVAL_MS =
  AUTHORIZATION_SAFETY_CHECK_INTERVAL_MS;

export type HumanObserverDeliveryLimits = {
  replay: HumanObserverReplayLimits;
  replayBatchEvents: number;
  maxBufferedBytes: number;
  maxPendingBytes: number;
  controlFrameReserveBytes: number;
  sendTimeoutMs: number;
  helloTimeoutMs: number;
};

export const HUMAN_OBSERVER_DELIVERY_LIMITS: Readonly<HumanObserverDeliveryLimits> = Object.freeze({
  replay: HUMAN_OBSERVER_REPLAY_LIMITS,
  replayBatchEvents: 32,
  maxBufferedBytes: 256 * 1_024,
  maxPendingBytes: 512 * 1_024,
  controlFrameReserveBytes: 1_024,
  sendTimeoutMs: 1_000,
  helloTimeoutMs: 10_000
});

const MAX_CATCHUP_CONTROL_FRAME = serializeMessage({
  type: "human.observer.catchup_required",
  protocolVersion: 1,
  reason: "retention_gap",
  resumeCursor: Number.MAX_SAFE_INTEGER,
  droppedThroughCursor: Number.MAX_SAFE_INTEGER
});

export type HumanObserverWebSocketServer = {
  close(): Promise<void>;
};

function projectIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^\/api\/v1\/projects\/([^/]+)\/human\/observe(?:\?.*)?$/.exec(url);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

type SerializedMessage = {
  data: string;
  bytes: number;
  eventCursor?: number;
};

function serializeMessage(message: unknown): SerializedMessage {
  const parsed = humanObserverServerMessageSchema.parse(message);
  const data = JSON.stringify(parsed);
  return {
    data,
    bytes: Buffer.byteLength(data),
    ...(parsed.type === "human.observer.event" ? { eventCursor: parsed.cursor } : {})
  };
}

function deliveryLimits(
  rawLimits: HumanObserverDeliveryLimits | undefined
): HumanObserverDeliveryLimits {
  const limits = rawLimits ?? HUMAN_OBSERVER_DELIVERY_LIMITS;
  for (const [name, value] of Object.entries({
    replayBatchEvents: limits.replayBatchEvents,
    maxBufferedBytes: limits.maxBufferedBytes,
    maxPendingBytes: limits.maxPendingBytes,
    controlFrameReserveBytes: limits.controlFrameReserveBytes,
    sendTimeoutMs: limits.sendTimeoutMs,
    helloTimeoutMs: limits.helloTimeoutMs
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`human_observer_${name}_invalid`);
    }
  }
  if (limits.controlFrameReserveBytes < MAX_CATCHUP_CONTROL_FRAME.bytes) {
    throw new Error("human_observer_control_frame_reserve_too_small");
  }
  if (limits.maxBufferedBytes > Number.MAX_SAFE_INTEGER - limits.controlFrameReserveBytes) {
    throw new Error("human_observer_total_buffer_limit_invalid");
  }
  return limits;
}

function authorizationSafetyCheckInterval(value: number | undefined): number {
  const interval = value ?? HUMAN_OBSERVER_AUTHORIZATION_SAFETY_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new Error("human_observer_authorization_safety_interval_invalid");
  }
  return interval;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type SendResult = "sent" | "unavailable" | "timeout";

export type HumanObserverWebSocketSendPort = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  once(event: "close" | "error", listener: () => void): unknown;
  off(event: "close" | "error", listener: () => void): unknown;
};

export function sendHumanObserverWebSocketFrame(
  socket: HumanObserverWebSocketSendPort,
  message: SerializedMessage,
  bufferedByteLimit: number,
  sendTimeoutMs: number
): Promise<SendResult> {
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount + message.bytes > bufferedByteLimit
  ) {
    return Promise.resolve("unavailable");
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: SendResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("error", onError);
      resolve(result);
    };
    const onClose = () => settle("unavailable");
    const onError = () => settle("unavailable");
    socket.once("close", onClose);
    socket.once("error", onError);
    timer = setTimeout(() => settle("timeout"), sendTimeoutMs);
    try {
      socket.send(message.data, (error) => settle(error ? "unavailable" : "sent"));
    } catch {
      settle("unavailable");
    }
  });
}

export function attachHumanObserverWebSocketServer(
  options: HumanObserverWebSocketOptions
): HumanObserverWebSocketServer {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes
  });
  const sessions = new Map<WebSocket, () => void>();
  const clock = options.clock ?? (() => new Date());
  const limits = deliveryLimits(options.deliveryLimits);
  const authorizationSafetyIntervalMs = authorizationSafetyCheckInterval(
    options.authorizationSafetyCheckIntervalMs
  );

  const authenticateScope = (
    authorization: string | string[] | undefined,
    projectId: string,
    recordLastUsed: boolean
  ) => {
    const authenticated = authenticateCollaborationForScope(
      options.repository,
      options.workspaceIdentity,
      options.projectAuthority,
      authorization,
      projectId,
      undefined,
      { recordLastUsed }
    );
    if (!authenticated) return undefined;
    try {
      options.projectAccess.policy.assertCapability({
        workspaceId: authenticated.workspaceId,
        projectId,
        actor: { kind: "human", id: authenticated.actor.humanPrincipalId },
        capability: "read"
      });
      return authenticated;
    } catch {
      return undefined;
    }
  };

  const handleConnection = (
    socket: WebSocket,
    scope: HumanObserverScope,
    authorization: string | string[] | undefined,
    authenticated: AuthenticatedCollaborationScope
  ) => {
    let authorizationExpired = false;
    let unsubscribeJournal = () => {};
    let unsubscribeAuthorization = () => {};
    let authorizationSafetyTimer: ReturnType<typeof setTimeout> | undefined;
    let phase: "awaiting_hello" | "replaying" | "live" | "catchup" | "stopping" | "closed" =
      "awaiting_hello";
    let replayHeadCursor = 0;
    let pendingBytes = 0;
    let draining = false;
    const pending: SerializedMessage[] = [];
    const stillAuthorized = () =>
      authenticateScope(authorization, scope.projectId, false)?.workspaceId === scope.workspaceId;
    const stopApplicationSending = (nextPhase: "catchup" | "stopping"): boolean => {
      if (phase === "closed" || phase === "stopping") return false;
      if (phase === "catchup" && nextPhase === "catchup") return false;
      phase = nextPhase;
      if (authorizationSafetyTimer) clearTimeout(authorizationSafetyTimer);
      authorizationSafetyTimer = undefined;
      unsubscribeJournal();
      unsubscribeJournal = () => {};
      unsubscribeAuthorization();
      unsubscribeAuthorization = () => {};
      pending.length = 0;
      pendingBytes = 0;
      return true;
    };
    const closeApplicationSocket = (code: number, reason: string) => {
      if (!stopApplicationSending("stopping")) return;
      socket.close(code, reason);
    };
    const validateAuthorization = (): boolean => {
      try {
        if (stillAuthorized()) return true;
        expireAuthorization();
      } catch {
        closeApplicationSocket(1011, "observer authorization error");
      }
      return false;
    };
    sessions.set(socket, () => {
      stopApplicationSending("stopping");
    });
    const sendSerialized = (
      message: SerializedMessage,
      bufferedByteLimit = limits.maxBufferedBytes
    ): Promise<SendResult> =>
      sendHumanObserverWebSocketFrame(socket, message, bufferedByteLimit, limits.sendTimeoutMs);
    const sendCatchupAndClose = async (message: SerializedMessage) => {
      if (!stopApplicationSending("catchup")) return;
      const result = await sendSerialized(
        message,
        limits.maxBufferedBytes + limits.controlFrameReserveBytes
      );
      if (phase !== "catchup") return;
      if (result === "sent") socket.close(4003, "observer catch-up required");
      else if (socket.readyState === WebSocket.OPEN) socket.terminate();
    };
    const signalCatchup = (resumeCursor: number) => {
      void sendCatchupAndClose(
        serializeMessage({
          type: "human.observer.catchup_required",
          protocolVersion: 1,
          reason: "reset",
          resumeCursor
        })
      );
    };
    const drainPending = async () => {
      if (draining || phase !== "live") return;
      draining = true;
      try {
        let sentInBatch = 0;
        while (phase === "live" && pending.length > 0) {
          if (!validateAuthorization()) break;
          const next = pending.shift();
          if (!next) break;
          pendingBytes -= next.bytes;
          if ((await sendSerialized(next)) !== "sent") {
            signalCatchup(options.journal.head(scope));
            break;
          }
          sentInBatch += 1;
          if (sentInBatch === limits.replayBatchEvents) {
            sentInBatch = 0;
            await yieldToEventLoop();
          }
        }
      } finally {
        draining = false;
        if (phase === "live" && pending.length > 0) void drainPending();
      }
    };
    const enqueue = (message: unknown) => {
      if (phase !== "replaying" && phase !== "live") return;
      const serialized = serializeMessage(message);
      if (
        serialized.eventCursor !== undefined &&
        phase === "replaying" &&
        serialized.eventCursor <= replayHeadCursor
      ) {
        return;
      }
      if (pendingBytes + serialized.bytes > limits.maxPendingBytes) {
        signalCatchup(options.journal.head(scope));
        return;
      }
      pending.push(serialized);
      pendingBytes += serialized.bytes;
      if (phase === "live") void drainPending();
    };
    const expireAuthorization = () => {
      if (authorizationExpired) return;
      authorizationExpired = true;
      if (!stopApplicationSending("stopping")) return;
      if (socket.readyState === WebSocket.OPEN) {
        const message = serializeMessage({
          type: "human.observer.auth_expired",
          protocolVersion: 1,
          code: "human_auth_unauthenticated"
        });
        if (socket.bufferedAmount + message.bytes <= limits.maxBufferedBytes) {
          socket.send(message.data);
        }
      }
      socket.close(4001, "auth expired");
    };
    const scheduleAuthorizationSafetyCheck = () => {
      authorizationSafetyTimer = setTimeout(() => {
        authorizationSafetyTimer = undefined;
        if (validateAuthorization()) scheduleAuthorizationSafetyCheck();
      }, authorizationSafetyIntervalMs);
    };
    const actor = authenticated.actor;
    const humanPrincipalId = actor.humanPrincipalId;
    const deviceSessionId =
      "deviceSessionId" in actor ? actor.deviceSessionId : actor.deviceCredentialId;
    unsubscribeAuthorization = options.authorizationChanges.subscribe(
      { ...scope, humanPrincipalId, deviceSessionId },
      () => {
        validateAuthorization();
      }
    );
    scheduleAuthorizationSafetyCheck();
    const helloTimer = setTimeout(
      () => closeApplicationSocket(4002, "observer hello required"),
      limits.helloTimeoutMs
    );

    const initialize = async (lastCursor: number) => {
      if (phase !== "awaiting_hello") return;
      phase = "replaying";
      unsubscribeJournal = options.journal.subscribe(scope, (event) => {
        if (!validateAuthorization()) return;
        enqueue(event);
      });
      const replay = options.journal.replay(scope, lastCursor, limits.replay);
      replayHeadCursor = replay.headCursor;
      if (replay.kind === "gap") {
        await sendCatchupAndClose(
          serializeMessage({
            type: "human.observer.catchup_required",
            protocolVersion: 1,
            reason: replay.reason,
            resumeCursor: replay.headCursor,
            ...(replay.droppedThroughCursor === undefined
              ? {}
              : { droppedThroughCursor: replay.droppedThroughCursor })
          })
        );
        return;
      }
      for (let index = 0; index < replay.events.length; index += 1) {
        if (phase !== "replaying") return;
        if ((await sendSerialized(serializeMessage(replay.events[index]))) !== "sent") {
          signalCatchup(options.journal.head(scope));
          return;
        }
        if ((index + 1) % limits.replayBatchEvents === 0) await yieldToEventLoop();
      }
      if (phase !== "replaying") return;
      if (
        (await sendSerialized(
          serializeMessage({
            type: "human.observer.welcome",
            protocolVersion: 1,
            projectId: scope.projectId,
            serverTime: clock().toISOString(),
            cursor: replay.headCursor
          })
        )) !== "sent"
      ) {
        signalCatchup(options.journal.head(scope));
        return;
      }
      phase = "live";
      void drainPending();
    };

    socket.on("message", (data, isBinary) => {
      if (phase === "stopping" || phase === "closed") return;
      try {
        if (isBinary) throw new Error("human_observer_binary_message");
        if (!validateAuthorization()) return;
        const message = humanObserverClientMessageSchema.parse(JSON.parse(data.toString()));
        if (phase === "awaiting_hello") {
          if (message.type !== "human.observer.hello" || message.projectId !== scope.projectId) {
            throw new Error("human_observer_hello_invalid");
          }
          clearTimeout(helloTimer);
          void initialize(message.lastCursor).catch(() =>
            closeApplicationSocket(1011, "observer error")
          );
          return;
        }
        if (message.type !== "human.observer.ping") {
          throw new Error("human_observer_message_invalid");
        }
        enqueue({
          type: "human.observer.pong",
          protocolVersion: 1,
          serverTime: clock().toISOString()
        });
      } catch {
        closeApplicationSocket(4000, "protocol error");
      }
    });
    socket.on("close", () => {
      phase = "closed";
      clearTimeout(helloTimer);
      if (authorizationSafetyTimer) clearTimeout(authorizationSafetyTimer);
      unsubscribeJournal();
      unsubscribeAuthorization();
      pending.length = 0;
      pendingBytes = 0;
      sessions.delete(socket);
    });
  };

  const unregister = options.upgradeRouter.register({
    matches: (request) => projectIdFromUrl(request.url) !== undefined,
    handle: (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const projectId = projectIdFromUrl(request.url);
      if (!projectId) {
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
      const authenticated = authenticateScope(request.headers.authorization, projectId, true);
      if (!authenticated) {
        const credentialActor = authenticateCollaborationForProject(
          options.repository,
          options.workspaceIdentity,
          request.headers.authorization,
          projectId
        );
        const hasDevice =
          credentialActor !== undefined ||
          hasAuthenticatedCollaborationDevice(
            options.repository,
            options.workspaceIdentity,
            request.headers.authorization
          );
        reject(socket, hasDevice ? 403 : 401, hasDevice ? "Forbidden" : "Unauthorized");
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
        handleConnection(
          webSocket,
          { workspaceId: authenticated.workspaceId, projectId },
          request.headers.authorization,
          authenticated
        )
      );
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= (async () => {
        unregister();
        for (const [socket, stopApplicationSending] of sessions) {
          stopApplicationSending();
          socket.close(1001, "server shutdown");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const graceful = new Promise<void>((resolve, rejectClose) => {
          webSocketServer.close((error) => (error ? rejectClose(error) : resolve()));
        });
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            for (const socket of sessions.keys()) socket.terminate();
            resolve();
          }, options.shutdownTimeoutMs);
        });
        await Promise.race([graceful, timeout]);
        if (timer) clearTimeout(timer);
        for (const socket of sessions.keys()) socket.terminate();
        await graceful;
      })();
      return closePromise;
    }
  };
}
