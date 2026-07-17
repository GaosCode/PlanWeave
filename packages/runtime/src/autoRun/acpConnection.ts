import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AgentCapabilities,
  type AnyMessage,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type Client,
  type CloseSessionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type Stream
} from "@agentclientprotocol/sdk";
import { spawnManagedProcess, type ManagedProcessTree } from "../process/managedProcessTree.js";
import type { LivePendingOperationHandle } from "./liveControl.js";

export class AcpOperationTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`ACP ${operation} timed out after ${timeoutMs}ms.`);
    this.name = "AcpOperationTimeoutError";
  }
}

export const ACP_SDK_AUTHORITY = {
  packageName: "@agentclientprotocol/sdk",
  packageVersion: "1.2.1",
  schemaArtifact: "schema/schema.json",
  protocolVersion: PROTOCOL_VERSION
} as const;

export type TrustedAcpLaunch = {
  trusted: true;
  command: string;
  args: readonly string[];
};

export type AcpProtocolObservation = {
  direction: "client_to_agent" | "agent_to_client" | "agent_stderr";
  payload: unknown;
};

export type AcpProtocolObserver = {
  redact(payload: unknown): unknown;
  observe(observation: AcpProtocolObservation): void;
};

export type AcpOperationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type AcpConnection = {
  readonly processId: number | null;
  readonly pendingOperationCount: number;
  readonly pendingOperations: ReadonlyMap<string, LivePendingOperationHandle>;
  readonly stderr: readonly string[];
  readonly closed: Promise<void>;
  initialize(options?: AcpOperationOptions): Promise<InitializeResponse>;
  authenticate(
    request: AuthenticateRequest,
    options?: AcpOperationOptions
  ): Promise<AuthenticateResponse>;
  newSession(
    request: NewSessionRequest,
    options?: AcpOperationOptions
  ): Promise<NewSessionResponse>;
  loadSession(
    request: LoadSessionRequest,
    options?: AcpOperationOptions
  ): Promise<LoadSessionResponse>;
  prompt(request: PromptRequest, options?: AcpOperationOptions): Promise<PromptResponse>;
  cancel(notification: CancelNotification): Promise<void>;
  closeSession(sessionId: string, options?: AcpOperationOptions): Promise<CloseSessionResponse>;
  setSessionMode(
    request: SetSessionModeRequest,
    options?: AcpOperationOptions
  ): Promise<SetSessionModeResponse>;
  setSessionConfigOption(
    request: SetSessionConfigOptionRequest,
    options?: AcpOperationOptions
  ): Promise<SetSessionConfigOptionResponse>;
  dispose(): Promise<void>;
};

export type CreateAcpConnectionOptions = {
  launch: TrustedAcpLaunch;
  cwd: string;
  env: Readonly<Record<string, string>>;
  clientInfo: { name: string; version: string };
  clientCapabilities?: Parameters<ClientSideConnection["initialize"]>[0]["clientCapabilities"];
  onSessionUpdate?: (notification: SessionNotification) => void | Promise<void>;
  onPermissionRequest?: (
    request: RequestPermissionRequest
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  onTerminalOutput?: (
    request: TerminalOutputRequest
  ) => TerminalOutputResponse | Promise<TerminalOutputResponse>;
  onElicitationRequest?: (
    request: CreateElicitationRequest
  ) => CreateElicitationResponse | Promise<CreateElicitationResponse>;
  observer?: AcpProtocolObserver;
  defaultTimeoutMs?: number;
  shutdownGraceMs?: number;
};

export const DEFAULT_ACP_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 100;

function validateSpawnOptions(options: CreateAcpConnectionOptions): void {
  if (options.launch.trusted !== true) throw new Error("ACP command is not trusted.");
  if (!options.launch.command.trim() || options.launch.command.includes("\0")) {
    throw new Error("ACP command is missing or invalid.");
  }
  if (!isAbsolute(options.cwd)) throw new Error("ACP cwd must be an absolute path.");
  for (const argument of options.launch.args) {
    if (argument.includes("\0")) throw new Error("ACP command argument contains a null byte.");
  }
  for (const [key, value] of Object.entries(options.env)) {
    if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      throw new Error(`ACP environment entry '${key}' is invalid.`);
    }
  }
  if (options.clientCapabilities?.auth?.terminal === true) {
    throw new Error("ACP client does not implement terminal authentication.");
  }
}

function asError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function observe(
  observer: AcpProtocolObserver | undefined,
  direction: AcpProtocolObservation["direction"],
  payload: unknown
): void {
  if (!observer) return;
  observer.observe({ direction, payload: observer.redact(payload) });
}

function isJsonRpcId(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isTransportEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.jsonrpc !== "2.0") return false;
  if ("method" in envelope) {
    if (typeof envelope.method !== "string") return false;
    if ("result" in envelope || "error" in envelope) return false;
    return !("id" in envelope) || isJsonRpcId(envelope.id);
  }
  if (!("id" in envelope) || !isJsonRpcId(envelope.id)) return false;
  return "result" in envelope !== "error" in envelope;
}

function validateTransportLine(line: string): void {
  let envelope: unknown;
  try {
    envelope = JSON.parse(line);
  } catch (error) {
    throw new Error("ACP transport received malformed JSON.", { cause: error });
  }
  if (!isTransportEnvelope(envelope)) {
    throw new Error("ACP transport received an invalid JSON-RPC envelope.");
  }
}

function createGuardedStream(
  process: ChildProcessWithoutNullStreams,
  observer: AcpProtocolObserver | undefined,
  fail: (error: Error) => void
): Stream {
  const decoder = new TextDecoder();
  let rawBuffer = "";
  const rawGuard = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      rawBuffer += decoder.decode(chunk, { stream: true });
      const lines = rawBuffer.split("\n");
      rawBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        validateTransportLine(line);
      }
      controller.enqueue(chunk);
    },
    flush() {
      rawBuffer += decoder.decode();
      if (!rawBuffer.trim()) return;
      validateTransportLine(rawBuffer);
    }
  });
  const stdout = Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>;
  const sdkStream = ndJsonStream(Writable.toWeb(process.stdin), stdout.pipeThrough(rawGuard));
  const pendingIds = new Set<string>();
  const completedIds = new Set<string>();
  const idKey = (id: unknown): string => `${typeof id}:${String(id)}`;

  return {
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        observe(observer, "client_to_agent", message);
        if ("method" in message && "id" in message) pendingIds.add(idKey(message.id));
        const writer = sdkStream.writable.getWriter();
        try {
          await writer.write(message);
        } finally {
          writer.releaseLock();
        }
      },
      async close() {
        const writer = sdkStream.writable.getWriter();
        try {
          await writer.close();
        } finally {
          writer.releaseLock();
        }
      },
      abort(reason) {
        return sdkStream.writable.abort(reason);
      }
    }),
    readable: new ReadableStream<AnyMessage>({
      async start(controller) {
        const reader = sdkStream.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            observe(observer, "agent_to_client", value);
            if ("id" in value && !("method" in value)) {
              const key = idKey(value.id);
              if (completedIds.has(key))
                throw new Error(`ACP duplicate response id: ${String(value.id)}`);
              if (!pendingIds.delete(key))
                throw new Error(`ACP unknown response id: ${String(value.id)}`);
              completedIds.add(key);
            }
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          const failure = asError(error, "ACP transport failed.");
          fail(failure);
          controller.error(failure);
        } finally {
          reader.releaseLock();
        }
      },
      cancel(reason) {
        return sdkStream.readable.cancel(reason);
      }
    })
  };
}

class SubprocessAcpConnection implements AcpConnection {
  readonly stderr: string[] = [];
  readonly closed: Promise<void>;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly processTree: ManagedProcessTree;
  private readonly sdk: ClientSideConnection;
  private readonly options: CreateAcpConnectionOptions;
  private capabilities: AgentCapabilities | undefined;
  private initialized = false;
  private terminalError: Error | undefined;
  private disposePromise: Promise<void> | undefined;
  private readonly livePendingOperations = new Map<string, LivePendingOperationHandle>();
  private nextOperationId = 1;

  get processId(): number | null {
    return this.process.pid ?? null;
  }

  get pendingOperationCount(): number {
    return this.livePendingOperations.size;
  }

  get pendingOperations(): ReadonlyMap<string, LivePendingOperationHandle> {
    return this.livePendingOperations;
  }

  constructor(options: CreateAcpConnectionOptions) {
    validateSpawnOptions(options);
    this.options = options;
    const managed = spawnManagedProcess({
      command: options.launch.command,
      args: options.launch.args,
      cwd: options.cwd,
      env: { ...options.env },
      graceMs: options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
    });
    this.process = managed.child;
    this.processTree = managed.tree;
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.stderr.push(chunk);
      observe(options.observer, "agent_stderr", chunk);
    });
    const stream = createGuardedStream(this.process, options.observer, (error) =>
      this.terminate(error)
    );
    const client: Client = {
      requestPermission: (request) => {
        if (!options.onPermissionRequest) {
          return { outcome: { outcome: "cancelled" } };
        }
        return options.onPermissionRequest(request);
      },
      sessionUpdate: (notification) => options.onSessionUpdate?.(notification),
      ...(options.onTerminalOutput ? { terminalOutput: options.onTerminalOutput } : {}),
      ...(options.onElicitationRequest
        ? { unstable_createElicitation: options.onElicitationRequest }
        : {})
    };
    this.sdk = new ClientSideConnection(() => client, stream);
    this.process.once("error", (error) =>
      this.terminate(new Error("ACP process failed to start.", { cause: error }))
    );
    this.process.once("exit", (code, signal) => {
      this.terminate(
        new Error(`ACP process exited (code=${String(code)}, signal=${String(signal)}).`)
      );
    });
    this.closed = this.sdk.closed;
  }

  async initialize(options?: AcpOperationOptions): Promise<InitializeResponse> {
    const response = await this.runOperation(
      "initialize",
      () =>
        this.sdk.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: this.options.clientCapabilities ?? {},
          clientInfo: this.options.clientInfo
        }),
      options
    );
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      const error = new Error(
        `Unsupported ACP protocol version ${String(response.protocolVersion)}; expected ${PROTOCOL_VERSION}.`
      );
      this.terminate(error);
      throw error;
    }
    this.capabilities = response.agentCapabilities;
    this.initialized = true;
    return response;
  }

  authenticate(
    request: AuthenticateRequest,
    options?: AcpOperationOptions
  ): Promise<AuthenticateResponse> {
    if (!this.initialized) {
      return Promise.reject(new Error("ACP connection must be initialized before authenticate."));
    }
    return this.runOperation("authenticate", () => this.sdk.authenticate(request), options);
  }

  newSession(
    request: NewSessionRequest,
    options?: AcpOperationOptions
  ): Promise<NewSessionResponse> {
    if (!isAbsolute(request.cwd))
      return Promise.reject(new Error("ACP session cwd must be absolute."));
    return this.runOperation("session/new", () => this.sdk.newSession(request), options);
  }

  loadSession(
    request: LoadSessionRequest,
    options?: AcpOperationOptions
  ): Promise<LoadSessionResponse> {
    if (!isAbsolute(request.cwd))
      return Promise.reject(new Error("ACP session cwd must be absolute."));
    return this.runOperation("session/load", () => this.sdk.loadSession(request), options);
  }

  prompt(request: PromptRequest, options?: AcpOperationOptions): Promise<PromptResponse> {
    return this.runOperation("session/prompt", () => this.sdk.prompt(request), options);
  }

  cancel(notification: CancelNotification): Promise<void> {
    return this.sdk.cancel(notification);
  }

  closeSession(sessionId: string, options?: AcpOperationOptions): Promise<CloseSessionResponse> {
    if (this.capabilities?.sessionCapabilities?.close == null) {
      return Promise.reject(new Error("ACP agent does not advertise session/close capability."));
    }
    return this.runOperation("session/close", () => this.sdk.closeSession({ sessionId }), options);
  }

  setSessionMode(
    request: SetSessionModeRequest,
    options?: AcpOperationOptions
  ): Promise<SetSessionModeResponse> {
    return this.runOperation("session/set_mode", () => this.sdk.setSessionMode(request), options);
  }

  setSessionConfigOption(
    request: SetSessionConfigOptionRequest,
    options?: AcpOperationOptions
  ): Promise<SetSessionConfigOptionResponse> {
    return this.runOperation(
      "session/set_config_option",
      () => this.sdk.setSessionConfigOption(request),
      options
    );
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeProcess();
    return this.disposePromise;
  }

  private async runOperation<T>(
    name: string,
    operation: () => Promise<T>,
    options: AcpOperationOptions | undefined
  ): Promise<T> {
    if (this.terminalError) throw this.terminalError;
    const timeoutMs =
      options?.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_ACP_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`ACP ${name} timeout must be a positive integer.`);
    }
    if (options?.signal?.aborted) throw asError(options.signal.reason, `ACP ${name} aborted.`);
    let rejectBoundary: ((error: Error) => void) | undefined;
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectBoundary = reject;
    });
    const abort = (): void => {
      const error = asError(options?.signal?.reason, `ACP ${name} aborted.`);
      this.terminate(error);
      rejectBoundary?.(error);
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      const error = new AcpOperationTimeoutError(name, timeoutMs);
      this.terminate(error);
      rejectBoundary?.(error);
    }, timeoutMs);
    const operationId = `ACP-OP-${String(this.nextOperationId++).padStart(4, "0")}`;
    const rejectOperation = async (reason: string): Promise<void> => {
      const error = new Error(reason);
      this.terminate(error);
      rejectBoundary?.(error);
    };
    try {
      this.livePendingOperations.set(operationId, {
        operationId,
        operation: name,
        reject: rejectOperation
      });
      return await Promise.race([operation(), boundary]);
    } finally {
      this.livePendingOperations.delete(operationId);
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abort);
    }
  }

  private terminate(error: Error): void {
    this.terminalError ??= error;
    if (!this.process.stdin.destroyed) this.process.stdin.destroy(error);
    if (!this.process.stdout.destroyed) this.process.stdout.destroy(error);
    void this.dispose();
  }

  private async disposeProcess(): Promise<void> {
    if (!this.process.stdin.destroyed && !this.process.stdin.writableEnded)
      this.process.stdin.end();
    if (await this.waitForExit()) return;
    await this.processTree.terminate("acp-dispose");
    if (!(await this.waitForExit())) {
      throw new Error(
        `ACP process ${String(this.process.pid)} did not exit after process-tree termination.`
      );
    }
  }

  private waitForExit(): Promise<boolean> {
    if (this.process.exitCode !== null || this.process.signalCode !== null)
      return Promise.resolve(true);
    const graceMs = this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    return Promise.race([
      new Promise<true>((resolve) => this.process.once("exit", () => resolve(true))),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs))
    ]);
  }
}

export function createAcpConnection(options: CreateAcpConnectionOptions): AcpConnection {
  return new SubprocessAcpConnection(options);
}
