import {
  humanObserverHelloSchema,
  parseHumanObserverServerMessage,
  type HumanObserverCursor,
  type HumanObserverServerMessage
} from "@planweave-ai/collaboration-protocol/activity/observer";
import { HUMAN_OBSERVER_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import type {
  CollaborationClientLimits,
  CollaborationConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import { CollaborationClientError } from "./collaborationErrors.js";
import type {
  CollaborationClientClock,
  CollaborationCredentialPort,
  CollaborationObserverHandlers,
  CollaborationObserverStatus,
  CollaborationWebSocketConstructor,
  CollaborationWebSocketLike
} from "./collaborationClientTypes.js";
import { reconnectDelay } from "./reconnectBackoff.js";
import { redactCollaborationText } from "./redaction.js";
import { derivedWebSocketOrigin } from "./webSocketOrigin.js";

type HumanObserverClientOptions = {
  profile: CollaborationConnectionProfile;
  credential: CollaborationCredentialPort;
  WebSocketImpl?: CollaborationWebSocketConstructor;
  clock: CollaborationClientClock;
  random: () => number;
  limits: CollaborationClientLimits;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

export class HumanObserverClient {
  private socket?: CollaborationWebSocketLike;
  private handlers?: CollaborationObserverHandlers;
  private status: CollaborationObserverStatus = { state: "stopped" };
  private cursor: HumanObserverCursor = 0;
  private reconnectAttempt = 0;
  private reconnectTimer?: unknown;
  private wanted = false;
  private disposed = false;
  private generation = 0;

  constructor(private readonly options: HumanObserverClientOptions) {}

  state(): CollaborationObserverStatus {
    return this.status;
  }

  lastCursor(): HumanObserverCursor {
    return this.cursor;
  }

  start(handlers: CollaborationObserverHandlers = {}, options?: { cursor?: number }): void {
    if (this.disposed) throw new Error("collaboration_disposed");
    if (!this.options.WebSocketImpl) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_websocket_unavailable",
        message: "WebSocket implementation was not provided to CollaborationClient."
      });
    }
    this.generation += 1;
    this.releaseConnection();
    this.handlers = handlers;
    this.wanted = true;
    if (options?.cursor !== undefined) this.cursor = options.cursor;
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.generation += 1;
    this.releaseConnection();
    this.setStatus({ state: "stopped" });
  }

  private releaseConnection(): void {
    if (this.reconnectTimer) this.options.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== 3) {
      try {
        socket.close(1000, "observer stopped");
      } catch {
        // WebSocket close races do not change the already-stopped observer state.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }

  private connect(): void {
    if (!this.wanted || this.disposed) return;
    const WebSocketImpl = this.options.WebSocketImpl;
    if (!WebSocketImpl) return;
    const generation = this.generation;
    this.setStatus({ state: "connecting", attempt: this.reconnectAttempt + 1 });
    if (!this.isCurrent(generation)) return;
    void this.connectAuthenticated(WebSocketImpl, generation);
  }

  private async connectAuthenticated(
    WebSocketImpl: CollaborationWebSocketConstructor,
    generation: number
  ) {
    try {
      if (!this.isCurrent(generation)) return;
      const token = await this.options.credential.getDeviceToken();
      if (!this.isCurrent(generation)) return;
      if (!token) {
        this.wanted = false;
        this.setStatus({ state: "auth_expired", code: "collaboration_credential_missing" });
        return;
      }
      const base = new URL(this.options.profile.serverBaseUrl);
      const wsUrl = new URL(base.origin);
      wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      wsUrl.pathname = `/api/v1/projects/${encodeURIComponent(this.options.profile.projectId)}/human/observe`;
      const socket = new WebSocketImpl(wsUrl.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: derivedWebSocketOrigin(this.options.profile.serverBaseUrl)
        }
      });
      if (!this.isCurrent(generation)) {
        try {
          socket.close(1000, "stale observer connection");
        } catch {
          // A constructor-side lifecycle change has already invalidated this connection.
        }
        return;
      }
      this.socket = socket;
      socket.on?.("unexpected-response", (_request, response) => {
        response.resume?.();
        if (!this.isSocketCurrent(generation, socket)) return;
        const statusCode = response.statusCode;
        const code =
          statusCode === undefined
            ? "collaboration_observer_handshake_rejected"
            : `collaboration_observer_http_${statusCode}`;
        if (statusCode === 401) {
          this.wanted = false;
          this.setStatus({ state: "auth_expired", code });
          return;
        }
        this.setStatus({ state: "failed", code });
        if (!this.isSocketCurrent(generation, socket)) return;
        this.socket = undefined;
        this.scheduleReconnect(generation);
      });
      socket.addEventListener("open", () => this.onOpen(socket, generation));
      socket.addEventListener("message", (event) => this.onMessage(socket, event, generation));
      socket.addEventListener("close", () => this.onClose(socket, generation));
      socket.addEventListener("error", () => {
        if (this.isSocketCurrent(generation, socket))
          this.options.logger?.warn?.("collaboration observer socket error");
      });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.options.logger?.error?.(
        redactCollaborationText(error instanceof Error ? error.message : "observer connect failed")
      );
      if (this.isCurrent(generation)) this.scheduleReconnect(generation);
    }
  }

  private onOpen(socket: CollaborationWebSocketLike, generation: number): void {
    if (!this.isSocketCurrent(generation, socket)) return;
    socket.send(
      JSON.stringify(
        humanObserverHelloSchema.parse({
          type: "human.observer.hello",
          protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
          projectId: this.options.profile.projectId,
          lastCursor: this.cursor
        })
      )
    );
  }

  private onMessage(socket: CollaborationWebSocketLike, event: unknown, generation: number): void {
    if (!this.isSocketCurrent(generation, socket)) return;
    try {
      const data =
        typeof event === "object" && event !== null && "data" in event
          ? (event as { data: unknown }).data
          : event;
      if (typeof data !== "string" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "collaboration_observer_payload_type",
          message: "Observer payload must be text."
        });
      }
      const text =
        typeof data === "string"
          ? data
          : Buffer.from(
              data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer,
              data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset,
              data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength
            ).toString("utf8");
      if (Buffer.byteLength(text, "utf8") > this.options.limits.observerMaxPayloadBytes) {
        throw new CollaborationClientError({
          kind: "payload_too_large",
          code: "collaboration_observer_payload_too_large",
          message: "Observer payload exceeded size limit."
        });
      }
      this.handleMessage(parseHumanObserverServerMessage(JSON.parse(text)), socket, generation);
    } catch (error) {
      if (!this.isSocketCurrent(generation, socket)) return;
      this.options.logger?.error?.(
        redactCollaborationText(error instanceof Error ? error.message : "observer message failed")
      );
      try {
        socket.close(4000, "protocol error");
      } catch {
        // Protocol failure already transitions through the socket close path.
      }
    }
  }

  private onClose(socket: CollaborationWebSocketLike, generation: number): void {
    if (!this.isSocketCurrent(generation, socket)) return;
    this.socket = undefined;
    this.scheduleReconnect(generation);
  }

  private handleMessage(
    message: HumanObserverServerMessage,
    socket: CollaborationWebSocketLike,
    generation: number
  ): void {
    switch (message.type) {
      case "human.observer.welcome":
        this.cursor = message.cursor;
        this.reconnectAttempt = 0;
        this.setStatus({
          state: "connected",
          cursor: message.cursor,
          connectedAt: this.options.clock.now().toISOString()
        });
        return;
      case "human.observer.event":
        if (message.previousCursor !== this.cursor) {
          throw new CollaborationClientError({
            kind: "protocol",
            code: "collaboration_observer_cursor_gap",
            message: "Observer event did not continue from the last validated cursor."
          });
        }
        this.cursor = message.cursor;
        this.handlers?.onEvent?.(message);
        return;
      case "human.observer.catchup_required":
        this.cursor = message.resumeCursor;
        this.setStatus({ state: "catching_up", resumeCursor: message.resumeCursor });
        if (this.isSocketCurrent(generation, socket)) this.handlers?.onCatchupRequired?.(message);
        return;
      case "human.observer.auth_expired": {
        this.wanted = false;
        this.socket = undefined;
        const handlers = this.handlers;
        try {
          socket.close(4001, "auth expired");
        } catch {
          // The socket is detached before notifying application callbacks.
        }
        if (generation !== this.generation || this.disposed) return;
        this.setStatus({ state: "auth_expired", code: message.code });
        if (generation === this.generation && !this.disposed) handlers?.onAuthExpired?.(message);
        return;
      }
      case "human.observer.pong":
        return;
    }
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.reconnectAttempt += 1;
    const delayMs = reconnectDelay(this.reconnectAttempt, this.options.random, {
      initialDelayMs: this.options.limits.reconnectInitialDelayMs,
      maxDelayMs: this.options.limits.reconnectMaxDelayMs
    });
    this.setStatus({ state: "reconnecting", attempt: this.reconnectAttempt, delayMs });
    if (!this.isCurrent(generation)) return;
    if (this.reconnectTimer) this.options.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.options.clock.setTimeout(() => {
      if (!this.isCurrent(generation)) return;
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
  }

  private isCurrent(generation: number): boolean {
    return this.wanted && !this.disposed && generation === this.generation;
  }

  private isSocketCurrent(generation: number, socket: CollaborationWebSocketLike): boolean {
    return this.isCurrent(generation) && this.socket === socket;
  }

  private setStatus(status: CollaborationObserverStatus): void {
    this.status = status;
    this.handlers?.onStatus?.(status);
  }
}
