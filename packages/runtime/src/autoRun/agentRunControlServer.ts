import { chmod } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  AGENT_RUN_CONTROL_MAX_FRAME_BYTES,
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlCommandIdSchema,
  agentRunControlCommandSchema,
  agentRunControlErrorResponseSchema,
  agentRunControlLeaseIdSchema,
  agentRunControlSuccessReceiptSchema,
  type AgentRunControlCommand,
  type AgentRunControlCommandId,
  type AgentRunControlEndpointDescriptor,
  type AgentRunControlErrorCode,
  type AgentRunControlLeaseId,
  type AgentRunControlResponse
} from "./agentRunControlContract.js";
import {
  allocateAgentRunControlEndpoint,
  createAgentRunControlEndpointDescriptor,
  publishAgentRunControlDescriptor,
  releaseAgentRunControlEndpoint,
  revokeAgentRunControlDescriptor,
  type AgentRunControlEndpointAllocation
} from "./agentRunControlEndpoint.js";
import { AgentRunControlTargetError, type AgentRunControlTarget } from "./agentRunControlTarget.js";

export const AGENT_RUN_CONTROL_DEFAULT_IDLE_TIMEOUT_MS = 15_000;
export const AGENT_RUN_CONTROL_DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
export const AGENT_RUN_CONTROL_DEFAULT_COMMAND_CACHE_SIZE = 256;

const FRAME_HEADER_BYTES = 4;
const UNIX_SOCKET_MODE = 0o600;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type CachedCommand = {
  fingerprint: string;
  response: Promise<AgentRunControlResponse>;
  settled: boolean;
};

export type AgentRunControlServerOptions = {
  runDir: string;
  leaseId: AgentRunControlLeaseId;
  target: AgentRunControlTarget;
  ownerPid?: number;
  now?: () => Date;
  idleTimeoutMs?: number;
  maxConcurrentRequests?: number;
  commandCacheSize?: number;
  temporaryRoot?: string;
};

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function frame(value: AgentRunControlResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const result = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  payload.copy(result, FRAME_HEADER_BYTES);
  return result;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

function parsedCommandId(value: unknown): AgentRunControlCommandId | null {
  if (typeof value !== "object" || value === null || !("commandId" in value)) return null;
  const parsed = agentRunControlCommandIdSchema.safeParse(value.commandId);
  return parsed.success ? parsed.data : null;
}

function schemaErrorCode(issues: readonly { path: PropertyKey[] }[]): AgentRunControlErrorCode {
  return issues.some((issue) => issue.path[0] === "identity")
    ? "invalid_identity"
    : "protocol_mismatch";
}

export class AgentRunControlServer {
  private readonly leaseId: AgentRunControlLeaseId;
  private readonly ownerPid: number;
  private readonly now: () => Date;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrentRequests: number;
  private readonly commandCacheSize: number;
  private readonly sockets = new Set<Socket>();
  private readonly commandCache = new Map<AgentRunControlCommandId, CachedCommand>();
  private readonly processingSockets = new Set<Socket>();
  private nodeServer: Server | null = null;
  private allocation: AgentRunControlEndpointAllocation | null = null;
  private publishedDescriptor: AgentRunControlEndpointDescriptor | null = null;
  private accepting = false;
  private started = false;
  private inFlightRequests = 0;
  private stopPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private serverClosePromise: Promise<void> | null = null;

  constructor(private readonly options: AgentRunControlServerOptions) {
    this.leaseId = agentRunControlLeaseIdSchema.parse(options.leaseId);
    this.ownerPid = positiveSafeInteger(options.ownerPid ?? process.pid, "ownerPid");
    this.now = options.now ?? (() => new Date());
    this.idleTimeoutMs = positiveSafeInteger(
      options.idleTimeoutMs ?? AGENT_RUN_CONTROL_DEFAULT_IDLE_TIMEOUT_MS,
      "idleTimeoutMs"
    );
    this.maxConcurrentRequests = positiveSafeInteger(
      options.maxConcurrentRequests ?? AGENT_RUN_CONTROL_DEFAULT_MAX_CONCURRENT_REQUESTS,
      "maxConcurrentRequests"
    );
    this.commandCacheSize = positiveSafeInteger(
      options.commandCacheSize ?? AGENT_RUN_CONTROL_DEFAULT_COMMAND_CACHE_SIZE,
      "commandCacheSize"
    );
    if (this.commandCacheSize < this.maxConcurrentRequests) {
      throw new Error("commandCacheSize must be at least maxConcurrentRequests.");
    }
  }

  get descriptor(): AgentRunControlEndpointDescriptor | null {
    return this.publishedDescriptor;
  }

  async start(): Promise<AgentRunControlEndpointDescriptor> {
    if (this.started) throw new Error("Agent run control server can only be started once.");
    this.started = true;
    const allocation = await allocateAgentRunControlEndpoint(this.leaseId, {
      temporaryRoot: this.options.temporaryRoot
    });
    const server = createServer((socket) => this.accept(socket));
    this.allocation = allocation;
    this.nodeServer = server;
    try {
      await listen(server, allocation.address);
      if (allocation.transport === "unix") await chmod(allocation.address, UNIX_SOCKET_MODE);
      const descriptor = createAgentRunControlEndpointDescriptor({
        allocation,
        leaseId: this.leaseId,
        ownerPid: this.ownerPid,
        publishedAt: this.now().toISOString()
      });
      this.accepting = true;
      await publishAgentRunControlDescriptor(this.options.runDir, descriptor);
      this.publishedDescriptor = descriptor;
      return descriptor;
    } catch (error) {
      this.accepting = false;
      const cleanup = await Promise.allSettled([
        closeServer(server),
        releaseAgentRunControlEndpoint(allocation)
      ]);
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], "Agent run control server startup failed.");
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  requestShutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.accepting = false;
    const server = this.nodeServer;
    const allocation = this.allocation;
    if (!server || !allocation) {
      this.shutdownPromise = Promise.resolve();
      return this.shutdownPromise;
    }
    this.serverClosePromise = closeServer(server);
    void this.serverClosePromise.catch(() => undefined);
    this.shutdownPromise = revokeAgentRunControlDescriptor(this.options.runDir, this.leaseId).then(
      () => {
        this.publishedDescriptor = null;
      }
    );
    return this.shutdownPromise;
  }

  private accept(socket: Socket): void {
    if (!this.accepting) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(this.idleTimeoutMs);
    let buffered = Buffer.alloc(0);
    let processing = false;
    let terminal = false;

    const terminate = (): void => {
      terminal = true;
      socket.end();
    };

    const writeProtocolError = (message: string): void => {
      if (!socket.destroyed) socket.write(frame(this.error(null, "protocol_mismatch", message)));
      terminate();
    };

    const pump = async (): Promise<void> => {
      if (processing || terminal || socket.destroyed) return;
      if (buffered.byteLength < FRAME_HEADER_BYTES) return;
      const payloadLength = buffered.readUInt32BE(0);
      if (payloadLength < 1 || payloadLength > AGENT_RUN_CONTROL_MAX_FRAME_BYTES) {
        writeProtocolError("Control frame length is outside the protocol limit.");
        return;
      }
      if (buffered.byteLength < FRAME_HEADER_BYTES + payloadLength) return;
      const payload = buffered.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadLength);
      buffered = buffered.subarray(FRAME_HEADER_BYTES + payloadLength);
      processing = true;
      this.processingSockets.add(socket);
      socket.setTimeout(0);
      const response = await this.executePayload(payload);
      if (!socket.destroyed) {
        await new Promise<void>((resolve) => {
          socket.write(frame(response), () => resolve());
        });
      }
      processing = false;
      this.processingSockets.delete(socket);
      if (!this.accepting) {
        terminate();
        return;
      }
      if (!terminal && !socket.destroyed) socket.setTimeout(this.idleTimeoutMs);
      await pump();
    };

    socket.on("data", (chunk) => {
      if (terminal) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (
        buffered.byteLength > AGENT_RUN_CONTROL_MAX_FRAME_BYTES + FRAME_HEADER_BYTES &&
        (buffered.byteLength < FRAME_HEADER_BYTES ||
          buffered.readUInt32BE(0) > AGENT_RUN_CONTROL_MAX_FRAME_BYTES)
      ) {
        writeProtocolError("Control frame exceeds the protocol limit.");
        return;
      }
      void pump().catch(() => {
        if (!socket.destroyed) {
          socket.write(frame(this.error(null, "delivery_failed", "Control request failed.")));
        }
        terminate();
      });
    });
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      terminal = true;
      this.processingSockets.delete(socket);
      this.sockets.delete(socket);
    });
  }

  private async executePayload(payload: Buffer): Promise<AgentRunControlResponse> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(utf8Decoder.decode(payload)) as unknown;
    } catch {
      return this.error(null, "protocol_mismatch", "Control frame is not valid UTF-8 JSON.");
    }
    const commandId = parsedCommandId(decoded);
    const parsed = agentRunControlCommandSchema.safeParse(decoded);
    if (!parsed.success) {
      return this.error(
        commandId,
        schemaErrorCode(parsed.error.issues),
        "Control command does not match the protocol contract."
      );
    }
    if (parsed.data.leaseId !== this.leaseId) {
      return this.error(
        parsed.data.commandId,
        "stale_lease",
        "Control command lease is not owned by this endpoint."
      );
    }
    if (!this.accepting) {
      return this.error(
        parsed.data.commandId,
        "not_active",
        "Control endpoint is no longer accepting commands."
      );
    }
    return this.executeCommand(parsed.data);
  }

  private executeCommand(command: AgentRunControlCommand): Promise<AgentRunControlResponse> {
    const fingerprint = JSON.stringify(command);
    const cached = this.commandCache.get(command.commandId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        return Promise.resolve(
          this.error(
            command.commandId,
            "protocol_mismatch",
            "commandId cannot be reused for a different control command."
          )
        );
      }
      return cached.response;
    }
    if (this.inFlightRequests >= this.maxConcurrentRequests) {
      return Promise.resolve(
        this.error(
          command.commandId,
          "delivery_failed",
          "Control endpoint concurrent request capacity is exhausted."
        )
      );
    }
    if (!this.reserveCacheEntry()) {
      return Promise.resolve(
        this.error(command.commandId, "delivery_failed", "Control command cache is exhausted.")
      );
    }

    const acceptedAt = this.now().toISOString();
    this.inFlightRequests += 1;
    const entryState = { settled: false };
    const response = this.dispatch(command, acceptedAt).finally(() => {
      entryState.settled = true;
      this.inFlightRequests -= 1;
    });
    const entry: CachedCommand = {
      fingerprint,
      response,
      get settled() {
        return entryState.settled;
      }
    };
    this.commandCache.set(command.commandId, entry);
    return entry.response;
  }

  private async dispatch(
    command: AgentRunControlCommand,
    acceptedAt: string
  ): Promise<AgentRunControlResponse> {
    try {
      const result =
        command.kind === "cancel"
          ? await this.options.target.cancel(command.identity)
          : command.kind === "respond"
            ? await this.options.target.respond(command.identity, command.outcome)
            : await this.options.target.followUp(command.identity, command.prompt);
      return agentRunControlSuccessReceiptSchema.parse({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        ok: true,
        commandId: command.commandId,
        acceptedAt,
        ownerPid: this.ownerPid,
        leaseId: this.leaseId,
        result
      });
    } catch (error) {
      if (error instanceof AgentRunControlTargetError) {
        return this.error(command.commandId, error.code, error.message);
      }
      return this.error(
        command.commandId,
        "delivery_failed",
        "Live owner failed while delivering the control command."
      );
    }
  }

  private reserveCacheEntry(): boolean {
    while (this.commandCache.size >= this.commandCacheSize) {
      const settled = [...this.commandCache].find(([, entry]) => entry.settled);
      if (!settled) return false;
      this.commandCache.delete(settled[0]);
    }
    return true;
  }

  private error(
    commandId: AgentRunControlCommandId | null,
    code: AgentRunControlErrorCode,
    message: string
  ): AgentRunControlResponse {
    return agentRunControlErrorResponseSchema.parse({
      version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
      ok: false,
      commandId,
      code,
      message
    });
  }

  private async stopOnce(): Promise<void> {
    const server = this.nodeServer;
    const allocation = this.allocation;
    if (!server || !allocation) return;
    const shutdown = this.requestShutdown();
    for (const socket of this.sockets) {
      if (!this.processingSockets.has(socket)) socket.destroy();
    }
    const results = await Promise.allSettled([
      shutdown,
      this.serverClosePromise ?? closeServer(server)
    ]);
    const release = await Promise.allSettled([releaseAgentRunControlEndpoint(allocation)]);
    this.publishedDescriptor = null;
    const failures = [...results, ...release].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Agent run control server teardown failed.");
    }
  }
}
