import type { CaptureStage } from "../../shared/collaborationCapture.js";
import { createHash } from "node:crypto";
import { transportCapture } from "./collaborationCaptureRecorder.js";
import {
  CANVAS_PRESENCE_MAX_FRAME_BYTES,
  CANVAS_PRESENCE_PROTOCOL_VERSION
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasPresenceClientUpdateSchema,
  canvasPresenceHelloSchema,
  canvasPresenceServerMessageSchema,
  type CanvasPresencePointer,
  type CanvasPresenceSelectionId,
  type CanvasPresenceServerMessage
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import { type CollaborationConnectionProfile } from "@planweave-ai/collaboration-protocol/connection";
import { CollaborationClientError } from "./collaborationErrors.js";
import { reconnectDelay } from "./reconnectBackoff.js";
import { redactCollaborationText } from "./redaction.js";
import { derivedWebSocketOrigin } from "./webSocketOrigin.js";
import type {
  CollaborationClientClock,
  CollaborationCredentialPort,
  CollaborationPresenceHandlers,
  CollaborationPresenceStatus,
  CollaborationWebSocketConstructor,
  CollaborationWebSocketLike
} from "./collaborationClientTypes.js";

export type CanvasPresenceClientOptions = {
  profile: CollaborationConnectionProfile;
  credential: CollaborationCredentialPort;
  WebSocketImpl?: CollaborationWebSocketConstructor;
  clock: CollaborationClientClock;
  random: () => number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

function textFromEvent(event: unknown): string {
  const data =
    typeof event === "object" && event !== null && "data" in event
      ? (event as { data: unknown }).data
      : event;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  throw new CollaborationClientError({
    kind: "protocol",
    code: "collaboration_presence_payload_type",
    message: "Presence payload must be text."
  });
}

/** Main-process-only ephemeral presence transport. It never stores cursors or replays updates. */
export class CanvasPresenceClient {
  private readonly profile: CollaborationConnectionProfile;
  private readonly credential: CollaborationCredentialPort;
  private readonly WebSocketImpl?: CollaborationWebSocketConstructor;
  private readonly clock: CollaborationClientClock;
  private readonly random: () => number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly logger?: CanvasPresenceClientOptions["logger"];
  private socket?: CollaborationWebSocketLike;
  private handlers?: CollaborationPresenceHandlers;
  private status: CollaborationPresenceStatus = { state: "stopped" };
  private canvasId: string | null = null;
  private wanted = false;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: unknown;
  private generation = 0;

  constructor(options: CanvasPresenceClientOptions) {
    this.profile = options.profile;
    this.credential = options.credential;
    this.WebSocketImpl = options.WebSocketImpl;
    this.clock = options.clock;
    this.random = options.random;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs;
    this.logger = options.logger;
  }

  state(): CollaborationPresenceStatus {
    return this.status;
  }

  canvas(): string | null {
    return this.canvasId;
  }

  start(canvasId: string, handlers: CollaborationPresenceHandlers = {}): void {
    if (this.disposed) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_disposed",
        message: "CanvasPresenceClient has been disposed."
      });
    }
    if (!this.WebSocketImpl) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_websocket_unavailable",
        message: "WebSocket implementation was not provided to CollaborationClient."
      });
    }
    const parsedCanvasId = canvasPresenceHelloSchema.parse({
      type: "canvas.presence.hello",
      protocolVersion: CANVAS_PRESENCE_PROTOCOL_VERSION,
      projectId: this.profile.projectId,
      canvasId
    }).canvasId;
    if (this.wanted && this.canvasId === parsedCanvasId) {
      this.handlers = handlers;
      return;
    }
    this.stop();
    this.generation += 1;
    this.canvasId = parsedCanvasId;
    transportCapture.bind(
      JSON.stringify([this.profile.profileId, parsedCanvasId]),
      createHash("sha256")
        .update(
          JSON.stringify([
            new URL(this.profile.serverBaseUrl).origin,
            this.profile.projectId,
            parsedCanvasId
          ])
        )
        .digest("hex")
    );
    this.handlers = handlers;
    this.wanted = true;
    this.reconnectAttempt = 0;
    this.connect(this.generation, parsedCanvasId);
  }

  publish(input: {
    pointer: CanvasPresencePointer | null;
    selectionIds: CanvasPresenceSelectionId[];
  }): void {
    if (this.disposed) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_disposed",
        message: "CanvasPresenceClient has been disposed."
      });
    }
    const canvasId = this.canvasId;
    const socket = this.socket;
    if (!this.wanted || !canvasId || !socket || socket.readyState !== 1) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_presence_not_connected",
        message: "Canvas presence is not connected."
      });
    }
    const update = canvasPresenceClientUpdateSchema.parse({
      type: "canvas.presence.update",
      protocolVersion: CANVAS_PRESENCE_PROTOCOL_VERSION,
      projectId: this.profile.projectId,
      canvasId,
      pointer: input.pointer,
      selectionIds: input.selectionIds
    });
    socket.send(JSON.stringify(update));
    this.recordCapture("socket_send", { pointer: input.pointer !== null });
  }

  stop(): void {
    if (
      this.canvasId &&
      transportCapture.scopeKey() === JSON.stringify([this.profile.profileId, this.canvasId])
    ) {
      transportCapture.bind(null);
    }
    this.wanted = false;
    this.generation += 1;
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.canvasId = null;
    this.handlers = undefined;
    if (socket && socket.readyState !== 3) {
      try {
        socket.close(1000, "presence stopped");
      } catch {
        // ignore close races
      }
    }
    this.setStatus({ state: "stopped" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }

  private connect(generation: number, canvasId: string): void {
    if (!this.isScopeCurrent(generation, canvasId)) return;
    this.setStatus({ state: "connecting", canvasId, attempt: this.reconnectAttempt + 1 });
    void (async () => {
      try {
        const token = await this.credential.getDeviceToken();
        if (!this.isScopeCurrent(generation, canvasId)) return;
        if (!token) {
          this.wanted = false;
          this.setStatus({
            state: "auth_expired",
            canvasId,
            code: "collaboration_credential_missing"
          });
          return;
        }
        const base = new URL(this.profile.serverBaseUrl);
        const wsUrl = new URL(base.origin);
        wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
        wsUrl.pathname =
          `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}` +
          `/canvases/${encodeURIComponent(canvasId)}/human/presence`;
        const socket = new this.WebSocketImpl!(wsUrl.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: derivedWebSocketOrigin(this.profile.serverBaseUrl)
          }
        });
        if (!this.isScopeCurrent(generation, canvasId)) {
          try {
            socket.close(1000, "stale presence connection");
          } catch {
            // ignore stale construction races
          }
          return;
        }
        this.socket = socket;
        const isCurrent = () => this.isScopeCurrent(generation, canvasId) && this.socket === socket;
        const onOpen = () => {
          if (!isCurrent()) return;
          this.recordCapture("socket_open");
          const hello = canvasPresenceHelloSchema.parse({
            type: "canvas.presence.hello",
            protocolVersion: CANVAS_PRESENCE_PROTOCOL_VERSION,
            projectId: this.profile.projectId,
            canvasId
          });
          socket.send(JSON.stringify(hello));
        };
        const onMessage = (event: unknown) => {
          if (!isCurrent()) return;
          try {
            const text = textFromEvent(event);
            if (Buffer.byteLength(text, "utf8") > CANVAS_PRESENCE_MAX_FRAME_BYTES) {
              throw new CollaborationClientError({
                kind: "payload_too_large",
                code: "collaboration_presence_payload_too_large",
                message: "Presence payload exceeded size limit."
              });
            }
            const message = canvasPresenceServerMessageSchema.parse(JSON.parse(text));
            if (message.projectId !== this.profile.projectId || message.canvasId !== canvasId) {
              throw new CollaborationClientError({
                kind: "protocol",
                code: "collaboration_presence_scope_mismatch",
                message: "Presence payload scope did not match the active canvas."
              });
            }
            if (message.type === "canvas.presence.update") {
              this.recordCapture("socket_receive", {
                peer: message.session.identity.sessionId,
                pointer: message.session.pointer !== null
              });
            }
            this.handleMessage(message, canvasId, isCurrent);
          } catch (error) {
            this.logger?.error?.(
              redactCollaborationText(
                error instanceof Error ? error.message : "presence message failed"
              )
            );
            try {
              socket.close(4000, "presence protocol error");
            } catch {
              // ignore close races
            }
          }
        };
        const onClose = () => {
          if (!isCurrent()) return;
          this.recordCapture("socket_close");
          this.socket = undefined;
          if (this.status.state === "auth_expired") return;
          if (!this.wanted || this.disposed) {
            this.setStatus({ state: "stopped" });
            return;
          }
          this.scheduleReconnect(canvasId, generation);
        };
        const onError = () => {
          if (isCurrent()) this.recordCapture("socket_error");
          if (isCurrent()) this.logger?.warn?.("collaboration presence socket error");
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onError);
      } catch (error) {
        if (!this.isScopeCurrent(generation, canvasId)) return;
        this.logger?.error?.(
          redactCollaborationText(
            error instanceof Error ? error.message : "presence connect failed"
          )
        );
        this.setStatus({ state: "error", canvasId, code: "collaboration_presence_connect" });
        this.scheduleReconnect(canvasId, generation);
      }
    })();
  }

  private handleMessage(
    message: CanvasPresenceServerMessage,
    canvasId: string,
    isCurrent: () => boolean
  ): void {
    if (!isCurrent()) return;
    switch (message.type) {
      case "canvas.presence.snapshot":
        this.reconnectAttempt = 0;
        this.setStatus({ state: "connected", canvasId });
        this.handlers?.onSnapshot?.(message);
        break;
      case "canvas.presence.update":
        this.handlers?.onUpdate?.(message);
        break;
      case "canvas.presence.leave":
        this.handlers?.onLeave?.(message);
        break;
      case "canvas.presence.error":
        this.handlers?.onError?.(message);
        if (message.code === "unauthorized" || message.code === "forbidden") {
          this.wanted = false;
          this.setStatus({ state: "auth_expired", canvasId, code: message.code });
          try {
            this.socket?.close(4001, "presence auth expired");
          } catch {
            // ignore close races
          }
        } else {
          this.setStatus({ state: "error", canvasId, code: message.code });
        }
        break;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  private scheduleReconnect(canvasId: string, generation: number): void {
    if (!this.isScopeCurrent(generation, canvasId)) return;
    this.reconnectAttempt += 1;
    const delayMs = reconnectDelay(this.reconnectAttempt, this.random, {
      initialDelayMs: this.reconnectInitialDelayMs,
      maxDelayMs: this.reconnectMaxDelayMs
    });
    this.setStatus({ state: "reconnecting", canvasId, attempt: this.reconnectAttempt, delayMs });
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(generation, canvasId);
    }, delayMs);
  }

  private isScopeCurrent(generation: number, canvasId: string): boolean {
    return (
      this.wanted && !this.disposed && generation === this.generation && this.canvasId === canvasId
    );
  }

  private recordCapture(
    stage: CaptureStage,
    options: { peer?: string; pointer?: boolean } = {}
  ): void {
    if (
      transportCapture.running() &&
      transportCapture.scopeKey() === JSON.stringify([this.profile.profileId, this.canvasId])
    ) {
      transportCapture.record(stage, options);
    }
  }

  private setStatus(status: CollaborationPresenceStatus): void {
    this.status = status;
    this.handlers?.onStatus?.(status);
  }
}
