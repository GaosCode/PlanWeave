import { WebSocket } from "ws";
import { ZodError } from "zod";
import { encodeHistoricalAgentHostEvent, type HistoricalHostEvent } from "../protocol.js";
import type { AgentHostStateRepository } from "../state/agentHostStateContract.js";
import type { HostTransportClock, HostTransportLimits } from "./hostTransport.js";

type OutboxState = Pick<
  AgentHostStateRepository,
  "subscribeOutboxReady" | "pendingEvents" | "historicalPermissionEventJson"
>;

export class AgentHostOutboxDataError extends Error {}

function readOutbox<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof ZodError ||
      (error instanceof Error &&
        ["historical_permission_event_not_pending", "host_event_identity_conflict"].includes(
          error.message
        ))
    ) {
      throw new AgentHostOutboxDataError("agent_host_outbox_record_invalid", { cause: error });
    }
    // Unclassified read failures, including temporary SQLite busy/I/O, remain retryable.
    throw error;
  }
}

/** Hints schedule reads; the durable outbox and Server ACKs own delivery state. */
export class AgentHostOutboxDrain {
  private unsubscribe?: () => void;
  private socket?: WebSocket;
  private historicalReplay = false;
  private maxPayloadBytes: number;
  private readonly inFlight = new Set<string>();
  private generation = 0;
  private scheduled = false;
  private requested = false;
  private retryTimer?: unknown;
  private retryDelayMs = 25;

  constructor(
    private readonly state: OutboxState,
    private readonly clock: HostTransportClock,
    private readonly limits: HostTransportLimits,
    private readonly onError: (error: unknown) => void,
    private readonly rejectHistoricalReplay: () => void
  ) {
    this.maxPayloadBytes = limits.maxPayloadBytes;
  }

  setMaxPayloadBytes(bytes: number): void {
    this.maxPayloadBytes = bytes;
  }

  validatePending(): void {
    for (const event of readOutbox(() => this.state.pendingEvents(Number.MAX_SAFE_INTEGER))) {
      this.encode(event);
    }
  }

  start(): void {
    this.unsubscribe ??= this.state.subscribeOutboxReady(() => this.request());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.disconnect();
  }

  disconnect(): void {
    this.generation += 1;
    this.socket = undefined;
    this.inFlight.clear();
    this.scheduled = false;
    this.requested = false;
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryDelayMs = 25;
  }

  supportsHistoricalReplay(): boolean {
    return this.historicalReplay;
  }

  welcome(socket: WebSocket, historicalReplay: boolean): boolean {
    try {
      if (
        !historicalReplay &&
        readOutbox(() => this.state.pendingEvents()).some(
          (event) => event.type === "interaction.permission_requested" && !("options" in event)
        )
      ) {
        this.rejectHistoricalReplay();
        return false;
      }
    } catch (error) {
      this.onError(error);
      return false;
    }
    this.disconnect();
    this.socket = socket;
    this.historicalReplay = historicalReplay;
    this.request();
    return true;
  }

  acknowledge(messageId: string): void {
    this.inFlight.delete(messageId);
    this.request();
  }

  request(): void {
    if (!this.socket) return;
    this.requested = true;
    if (this.scheduled || this.retryTimer !== undefined) return;
    const generation = this.generation;
    this.scheduled = true;
    queueMicrotask(() => {
      if (generation !== this.generation) return;
      // Keep the flag set while draining: a burst shares this durable queue read.
      this.requested = false;
      try {
        this.drain();
      } catch (error) {
        this.onError(error);
      } finally {
        if (generation === this.generation) {
          this.scheduled = false;
          if (this.requested) this.request();
        }
      }
    });
  }

  private retry(): void {
    if (this.retryTimer !== undefined || !this.socket) return;
    const generation = this.generation;
    this.retryTimer = this.clock.setTimeout(() => {
      if (generation !== this.generation) return;
      this.retryTimer = undefined;
      this.request();
    }, this.retryDelayMs);
    this.retryDelayMs = Math.min(1_000, this.retryDelayMs * 2);
  }

  private drain(): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const responseSafeWindow = Math.max(1, Math.floor((this.limits.maxQueuedMessages - 4) / 2));
    const windowSize = Math.min(this.limits.maxOutboundBatch, responseSafeWindow);
    let available = windowSize - this.inFlight.size;
    if (available <= 0) return;
    for (const event of readOutbox(() => this.state.pendingEvents(this.limits.maxOutboundBatch))) {
      if (available <= 0) return;
      if (this.inFlight.has(event.messageId)) continue;
      if (!this.send(socket, event)) return;
      this.inFlight.add(event.messageId);
      available -= 1;
    }
  }

  private send(socket: WebSocket, event: HistoricalHostEvent): boolean {
    const historical = event.type === "interaction.permission_requested" && !("options" in event);
    if (historical && !this.historicalReplay) {
      this.rejectHistoricalReplay();
      return false;
    }
    const { payload, bytes } = this.encode(event);
    if (socket.bufferedAmount + bytes > this.limits.maxBufferedBytes) {
      this.retry();
      return false;
    }
    socket.send(payload);
    this.retryDelayMs = 25;
    return true;
  }

  private encode(event: HistoricalHostEvent): { payload: string; bytes: number } {
    const historical = event.type === "interaction.permission_requested" && !("options" in event);
    const eventJson = historical
      ? readOutbox(() => this.state.historicalPermissionEventJson(event.messageId))
      : undefined;
    let payload: string;
    let bytes: number;
    try {
      ({ payload, bytes } = encodeHistoricalAgentHostEvent(event, this.maxPayloadBytes, eventJson));
    } catch (error) {
      throw new AgentHostOutboxDataError(
        error instanceof ZodError
          ? "agent_host_outbox_encoding_failed"
          : error instanceof Error
            ? error.message
            : "agent_host_outbound_payload_budget_invalid",
        { cause: error }
      );
    }
    return { payload, bytes };
  }
}
