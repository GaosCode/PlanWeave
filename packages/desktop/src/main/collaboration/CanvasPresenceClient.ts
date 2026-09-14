import { PresencePendingUpdate, PRESENCE_MAX_BUFFERED_BYTES } from "./PresencePendingUpdate.js";
import { PresenceTransportProbe } from "./PresenceTransportProbe.js";
import type { CaptureStage, CaptureSample } from "../../shared/collaborationCapture.js";
import { createHash } from "node:crypto";
import {
  transportCapture,
  nextPresenceTrace,
  peekPresenceTrace,
  registerCaptureProbe
} from "./collaborationCaptureRecorder.js";
import {
  CANVAS_PRESENCE_MAX_FRAME_BYTES,
  CANVAS_PRESENCE_PROTOCOL_VERSION
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  PRESENCE_DIAGNOSTICS_HEADER,
  PRESENCE_TRANSPORT_DIAGNOSTICS_HEADER,
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
  private diagnosticsSupported = false;
  private transportDiagnosticsSupported = false;
  private readonly probe = new PresenceTransportProbe();
  private unregisterProbe?: () => void;
  private socket?: CollaborationWebSocketLike;
  private pendingUpdate?: PresencePendingUpdate;
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
    this.unregisterProbe = registerCaptureProbe(() => {
      if (!this.socket || this.socket.readyState !== 1 || this.status.state !== "connected") return;
      if (transportCapture.scopeKey() !== JSON.stringify([this.profile.profileId, this.canvasId]))
        return;
      this.probe.tick(
        this.transportDiagnosticsSupported,
        this.socket.bufferedAmount,
        (probeId, captureToken) => {
          this.socket!.send(
            JSON.stringify({
              type: "canvas.presence.probe",
              protocolVersion: 1,
              projectId: this.profile.projectId,
              canvasId: this.canvasId,
              probeId,
              captureToken
            })
          );
        }
      );
    });
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
    const pending = this.pendingUpdate;
    if (!this.wanted || !canvasId || !socket || !pending || socket.readyState !== 1) {
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
    pending.publish(update);
  }

  stop(): void {
    if (
      this.canvasId &&
      transportCapture.scopeKey() === JSON.stringify([this.profile.profileId, this.canvasId])
    ) {
      transportCapture.bind(null);
    }
    this.pendingUpdate?.dispose();
    this.pendingUpdate = undefined;
    this.diagnosticsSupported = false;
    this.transportDiagnosticsSupported = false;
    this.unregisterProbe?.();
    this.unregisterProbe = undefined;
    this.probe.reset();
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
            [PRESENCE_DIAGNOSTICS_HEADER]: "1",
            [PRESENCE_TRANSPORT_DIAGNOSTICS_HEADER]: "1",
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
        const disconnect = () => {
          if (!isCurrent()) return;
          this.pendingUpdate?.dispose();
          this.pendingUpdate = undefined;
          this.recordCapture("socket_close");
          this.socket = undefined;
          this.scheduleReconnect(canvasId, generation);
        };
        const fail = (error: Error) => {
          if (!isCurrent()) return;
          this.logger?.error?.(redactCollaborationText(error.message));
          disconnect();
          try {
            socket.close(4000, "presence send failed");
          } catch (closeError) {
            this.logger?.warn?.(
              redactCollaborationText(
                closeError instanceof Error ? closeError.message : "presence close failed"
              )
            );
          }
        };
        this.pendingUpdate = new PresencePendingUpdate({
          socket,
          clock: this.clock,
          serialize: (update) => {
            const trace = this.diagnosticsSupported ? peekPresenceTrace() : undefined;
            return JSON.stringify({ ...update, ...(trace ? { trace } : {}) });
          },
          onCoalesced: () => this.recordCapture("presence_coalesced"),
          onBuffered: (bufferedBytes) => this.recordCapture("presence_buffer", { bufferedBytes }),
          onFatal: fail,
          send: (text, update, waitMs, bufferedBytes) => {
            const trace = this.diagnosticsSupported ? nextPresenceTrace() : undefined;
            const ticket = transportCapture.ticket();
            const started = performance.now();
            this.recordCapture("presence_queue_wait", { durationMs: waitMs });
            this.recordCapture("socket_send", {
              pointer: update.pointer !== null,
              trace,
              bufferedBytes
            });
            socket.send(
              text,
              ticket === null
                ? undefined
                : (error) => {
                    if (transportCapture.ticket() !== ticket || !isCurrent()) return;
                    this.recordCapture("socket_write", {
                      durationMs: performance.now() - started,
                      bufferedBytes: socket.bufferedAmount,
                      failed: Boolean(error),
                      trace
                    });
                  }
            );
          }
        });
        let helloSent = false;
        const onOpen = () => {
          if (!isCurrent()) return;
          this.diagnosticsSupported = false;
          this.transportDiagnosticsSupported = false;
          this.probe.reset();
          this.recordCapture("socket_open");
          const hello = canvasPresenceHelloSchema.parse({
            type: "canvas.presence.hello",
            protocolVersion: CANVAS_PRESENCE_PROTOCOL_VERSION,
            projectId: this.profile.projectId,
            canvasId
          });
          const text = JSON.stringify(hello);
          const bytes = Buffer.byteLength(text, "utf8");
          if (
            bytes > CANVAS_PRESENCE_MAX_FRAME_BYTES ||
            bytes + socket.bufferedAmount > PRESENCE_MAX_BUFFERED_BYTES
          ) {
            fail(new Error("Presence hello exceeded socket send budget."));
            return;
          }
          try {
            helloSent = true;
            socket.send(text);
          } catch (error) {
            fail(error instanceof Error ? error : new Error("Presence hello send failed."));
          }
        };
        const onMessage = (event: unknown) => {
          if (!isCurrent()) return;
          try {
            if (!helloSent) throw new Error("Presence message arrived before hello.");
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
              if (message.trace)
                this.recordCapture("server_processing", {
                  peer: message.session.identity.sessionId,
                  durationMs: message.trace.serverForwardedMs - message.trace.serverReceivedMs,
                  trace: message.trace
                });
              this.recordCapture("socket_receive", {
                peer: message.session.identity.sessionId,
                pointer: message.session.pointer !== null,
                trace: message.trace
              });
            }
            this.handleMessage(message, canvasId, isCurrent);
          } catch (error) {
            fail(error instanceof Error ? error : new Error("Presence protocol error."));
          }
        };
        const onClose = disconnect;
        const onError = () => {
          if (!isCurrent()) return;
          this.recordCapture("socket_error");
          fail(new Error("collaboration presence socket error"));
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
      case "canvas.presence.probe_error":
        this.probe.rejected(message.probeId);
        break;
      case "canvas.presence.probe_result":
        this.probe.receive(message.report);
        break;
      case "canvas.presence.snapshot":
        this.diagnosticsSupported = message.diagnosticsVersion === 1;
        this.transportDiagnosticsSupported = message.transportDiagnosticsVersion === 1;
        this.reconnectAttempt = 0;
        this.setStatus({ state: "connected", canvasId });
        if (!isCurrent()) return;
        this.handlers?.onSnapshot?.(message);
        if (isCurrent()) this.pendingUpdate?.connected();
        break;
      case "canvas.presence.update":
        this.handlers?.onUpdate?.(message);
        break;
      case "canvas.presence.leave":
        this.handlers?.onLeave?.(message);
        break;
      case "canvas.presence.error":
        this.handlers?.onError?.(message);
        if (!isCurrent()) return;
        if (message.code === "unauthorized" || message.code === "forbidden") {
          this.pendingUpdate?.dispose();
          this.pendingUpdate = undefined;
          const socket = this.socket;
          this.socket = undefined;
          this.wanted = false;
          this.setStatus({ state: "auth_expired", canvasId, code: message.code });
          try {
            socket?.close(4001, "presence auth expired");
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
    options: {
      bufferedBytes?: number;
      failed?: boolean;
      peer?: string;
      pointer?: boolean;
      durationMs?: number;
      trace?: CaptureSample["trace"];
    } = {}
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
