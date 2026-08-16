export type HostTransportStatus =
  | { readonly state: "connecting"; readonly attempt: number }
  | { readonly state: "connected"; readonly connectedAt: string }
  | { readonly state: "degraded"; readonly reason: string }
  | { readonly state: "reconciliation-required"; readonly reason: string }
  | {
      readonly state: "backing-off";
      readonly attempt: number;
      readonly delayMs: number;
      readonly retryAt: string;
    }
  | { readonly state: "auth-failed"; readonly reason: string }
  | { readonly state: "stopped" };

export type HostTransportStatusListener = (status: HostTransportStatus) => void;

export interface HostTransport {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  status(): HostTransportStatus;
  subscribe(listener: HostTransportStatusListener): () => void;
}

export interface HostTransportClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export type HostTransportLimits = {
  readonly maxPayloadBytes: number;
  readonly maxQueuedMessages: number;
  readonly maxBufferedBytes: number;
  readonly maxOutboundBatch: number;
  readonly shutdownTimeoutMs: number;
};

export const DEFAULT_HOST_TRANSPORT_LIMITS: HostTransportLimits = {
  maxPayloadBytes: 256 * 1_024,
  maxQueuedMessages: 128,
  maxBufferedBytes: 512 * 1_024,
  maxOutboundBatch: 128,
  shutdownTimeoutMs: 5_000
};

export function parseHostTransportLimits(
  input: Partial<HostTransportLimits> = {}
): HostTransportLimits {
  const limits = { ...DEFAULT_HOST_TRANSPORT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`agent_host_transport_${name}_invalid`);
    }
  }
  if (limits.maxBufferedBytes < limits.maxPayloadBytes) {
    throw new Error("agent_host_transport_buffer_smaller_than_payload");
  }
  return limits;
}

export const systemHostTransportClock: HostTransportClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

export type HostTransportLogRecord = {
  readonly level: "debug" | "warn" | "error";
  readonly event: string;
  readonly state: HostTransportStatus["state"];
  readonly reason?: string;
};

export interface HostTransportLogger {
  log(record: HostTransportLogRecord): void;
}
