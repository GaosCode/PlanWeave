import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AgentCapabilities,
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
  type TerminalOutputResponse
} from "@agentclientprotocol/sdk";
import {
  spawnManagedProcess,
  type ManagedProcessTree,
  type ProcessTerminationOptions
} from "../process/managedProcessTree.js";
import {
  ACP_FORCE_EXIT_CONFIRM_MS,
  acpShutdownPolicySchema,
  type AcpShutdownPolicy
} from "../acpProfile/schema.js";
import type { LivePendingOperationHandle } from "./liveControl.js";
import { createAcpCleanupDeadline, type AcpCleanupDeadline } from "./acpExecutionCleanup.js";
import { shutdownAcpProcess } from "./acpProcessShutdown.js";
import {
  AcpProtocolError,
  createGuardedAcpStream,
  type AcpProtocolObserver
} from "./acpTransportGuard.js";

export {
  AcpInboundMessageLimitError,
  AcpProtocolError
} from "./acpTransportGuard.js";
export type {
  AcpProtocolObservation,
  AcpProtocolObserver
} from "./acpTransportGuard.js";

export class AcpOperationTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`ACP ${operation} timed out after ${timeoutMs}ms.`);
    this.name = "AcpOperationTimeoutError";
  }
}

export class AcpProcessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcpProcessError";
  }
}

export class AcpStderrLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`ACP stderr exceeded the ${maxBytes}-byte limit.`);
    this.name = "AcpStderrLimitError";
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

export type AcpOperationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Shared monotonic cleanup boundary for cleanup-phase protocol operations. */
  cleanupDeadline?: AcpCleanupDeadline;
};

export type AcpDisposeOptions = AcpOperationOptions;

export type AcpConnection = {
  readonly processId: number | null;
  readonly pendingOperationCount: number;
  readonly pendingOperations: ReadonlyMap<string, LivePendingOperationHandle>;
  readonly stderr: readonly string[];
  readonly closed: Promise<void>;
  readonly terminalFailure?: Error | null;
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
  cancel(notification: CancelNotification, options?: AcpOperationOptions): Promise<void>;
  closeSession(sessionId: string, options?: AcpOperationOptions): Promise<CloseSessionResponse>;
  setSessionMode(
    request: SetSessionModeRequest,
    options?: AcpOperationOptions
  ): Promise<SetSessionModeResponse>;
  setSessionConfigOption(
    request: SetSessionConfigOptionRequest,
    options?: AcpOperationOptions
  ): Promise<SetSessionConfigOptionResponse>;
  dispose(options?: AcpDisposeOptions): Promise<void>;
};

export type CreateAcpConnectionOptions = {
  launch: TrustedAcpLaunch;
  cwd: string;
  /** Native process cwd. null deliberately omits cwd (used by WSL host adapters). */
  spawnCwd?: string | null;
  env: Readonly<Record<string, string>>;
  decorateProcessTree?: (tree: ManagedProcessTree) => ManagedProcessTree;
  cleanupExitedProcessTree?: (options?: ProcessTerminationOptions) => Promise<void>;
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
  shutdown: AcpShutdownPolicy;
  maxInboundMessageBytes?: number;
  maxStderrBytes?: number;
};

export const DEFAULT_ACP_OPERATION_TIMEOUT_MS = 30_000;
export const DEFAULT_ACP_INBOUND_MESSAGE_MAX_BYTES = 1_048_576;
export const DEFAULT_ACP_STDERR_MAX_BYTES = 1_048_576;

function validateSpawnOptions(options: CreateAcpConnectionOptions): void {
  if (options.launch.trusted !== true) throw new Error("ACP command is not trusted.");
  if (!options.launch.command.trim() || options.launch.command.includes("\0")) {
    throw new Error("ACP command is missing or invalid.");
  }
  if (!isAbsolute(options.cwd)) throw new Error("ACP cwd must be an absolute path.");
  if (typeof options.spawnCwd === "string" && !isAbsolute(options.spawnCwd)) {
    throw new Error("ACP spawn cwd must be an absolute path.");
  }
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
  const maxInboundMessageBytes =
    options.maxInboundMessageBytes ?? DEFAULT_ACP_INBOUND_MESSAGE_MAX_BYTES;
  if (!Number.isSafeInteger(maxInboundMessageBytes) || maxInboundMessageBytes <= 0) {
    throw new Error("ACP inbound message byte limit must be a positive safe integer.");
  }
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_ACP_STDERR_MAX_BYTES;
  if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes <= 0) {
    throw new Error("ACP stderr byte limit must be a positive safe integer.");
  }
}

function asError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function utf8Prefix(buffer: Buffer, maxBytes: number): string {
  let end = Math.min(buffer.byteLength, maxBytes);
  while (end > 0) {
    const candidate = buffer.subarray(0, end).toString("utf8");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
    end -= 1;
  }
  return "";
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
  private readonly settlingOperations = new Set<Promise<unknown>>();
  private readonly livePendingOperations = new Map<string, LivePendingOperationHandle>();
  private nextOperationId = 1;
  private stderrBytes = 0;

  get processId(): number | null {
    return this.process.pid ?? null;
  }

  get pendingOperationCount(): number {
    return this.livePendingOperations.size;
  }

  get pendingOperations(): ReadonlyMap<string, LivePendingOperationHandle> {
    return this.livePendingOperations;
  }

  get terminalFailure(): Error | null {
    return this.terminalError ?? null;
  }

  constructor(options: CreateAcpConnectionOptions) {
    validateSpawnOptions(options);
    this.options = { ...options, shutdown: acpShutdownPolicySchema.parse(options.shutdown) };
    const shutdown = this.options.shutdown;
    const managed = spawnManagedProcess({
      command: options.launch.command,
      args: options.launch.args,
      cwd: options.spawnCwd === null ? undefined : (options.spawnCwd ?? options.cwd),
      env: { ...options.env },
      graceMs: shutdown.terminateGraceMs,
      forceExitConfirmMs: ACP_FORCE_EXIT_CONFIRM_MS
    });
    this.process = managed.child;
    this.processTree = options.decorateProcessTree?.(managed.tree) ?? managed.tree;
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      const maxBytes = options.maxStderrBytes ?? DEFAULT_ACP_STDERR_MAX_BYTES;
      const chunkBytes = Buffer.from(chunk, "utf8");
      const remaining = Math.max(0, maxBytes - this.stderrBytes);
      const accepted = utf8Prefix(chunkBytes, remaining);
      if (accepted.length > 0) {
        this.stderr.push(accepted);
        this.stderrBytes += Buffer.byteLength(accepted, "utf8");
        options.observer?.observe({
          direction: "agent_stderr",
          payload: options.observer.redact(accepted)
        });
      }
      if (chunkBytes.byteLength > remaining) {
        this.terminate(new AcpStderrLimitError(maxBytes));
      }
    });
    const stream = createGuardedAcpStream({
      process: this.process,
      observer: options.observer,
      fail: (error) => this.terminate(error),
      maxInboundMessageBytes:
        options.maxInboundMessageBytes ?? DEFAULT_ACP_INBOUND_MESSAGE_MAX_BYTES
    });
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
      this.terminate(new AcpProcessError("ACP process failed to start.", { cause: error }))
    );
    this.process.once("exit", (code, signal) => {
      const processError = new AcpProcessError(
        `ACP process exited (code=${String(code)}, signal=${String(signal)}).`
      );
      if (
        !(this.terminalError instanceof AcpProtocolError) &&
        !(this.terminalError instanceof AcpOperationTimeoutError) &&
        !(this.terminalError instanceof AcpStderrLimitError)
      ) {
        this.terminalError = processError;
      }
      this.terminate(processError);
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

  cancel(notification: CancelNotification, options?: AcpOperationOptions): Promise<void> {
    if (this.terminalError) return Promise.resolve();
    return this.runOperation("session/cancel", () => this.sdk.cancel(notification), options);
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

  dispose(options?: AcpDisposeOptions): Promise<void> {
    this.disposePromise ??= this.disposeProcess(
      options?.cleanupDeadline ?? createAcpCleanupDeadline(this.options.shutdown.cleanupDeadlineMs)
    );
    if (!options || options.cleanupDeadline) return this.disposePromise;
    return this.waitForDisposal(this.disposePromise, options);
  }

  private async waitForDisposal(
    disposal: Promise<void>,
    options: AcpOperationOptions
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_ACP_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("ACP dispose timeout must be a positive integer.");
    }
    if (options.signal?.aborted) {
      throw asError(options.signal.reason, "ACP dispose aborted.");
    }
    let rejectAbort: ((error: Error) => void) | undefined;
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = (): void =>
      rejectAbort?.(asError(options.signal?.reason, "ACP dispose aborted."));
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => rejectAbort?.(new AcpOperationTimeoutError("dispose", timeoutMs)),
      timeoutMs
    );
    try {
      await Promise.race([disposal, boundary]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
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
      this.terminate(error, options?.cleanupDeadline);
      rejectBoundary?.(error);
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      const error = new AcpOperationTimeoutError(name, timeoutMs);
      this.terminate(error, options?.cleanupDeadline);
      rejectBoundary?.(error);
    }, timeoutMs);
    const operationId = `ACP-OP-${String(this.nextOperationId++).padStart(4, "0")}`;
    const rejectOperation = async (reason: string): Promise<void> => {
      const error = new Error(reason);
      this.terminate(error, options?.cleanupDeadline);
      rejectBoundary?.(error);
    };
    try {
      this.livePendingOperations.set(operationId, {
        operationId,
        operation: name,
        reject: rejectOperation
      });
      const operationPromise = operation();
      this.settlingOperations.add(operationPromise);
      void operationPromise.then(
        () => this.settlingOperations.delete(operationPromise),
        () => this.settlingOperations.delete(operationPromise)
      );
      return await Promise.race([operationPromise, boundary]);
    } finally {
      this.livePendingOperations.delete(operationId);
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abort);
    }
  }

  private terminate(error: Error, cleanupDeadline?: AcpCleanupDeadline): void {
    this.terminalError ??= error;
    if (!this.process.stdin.destroyed) this.process.stdin.destroy(error);
    if (!this.process.stdout.destroyed) this.process.stdout.destroy(error);
    void this.dispose(cleanupDeadline ? { cleanupDeadline } : undefined);
  }

  private async disposeProcess(deadline: AcpCleanupDeadline): Promise<void> {
    await shutdownAcpProcess({
      policy: this.options.shutdown,
      deadline,
      closeInput: () => {
        if (!this.process.stdin.destroyed && !this.process.stdin.writableEnded) {
          this.process.stdin.end();
        }
      },
      waitForRootExit: (timeoutMs) => this.waitForExit(timeoutMs),
      processTree: this.processTree,
      ...(this.options.cleanupExitedProcessTree
        ? { cleanupExitedProcessTree: this.options.cleanupExitedProcessTree }
        : {})
    });
    await this.settleOperations();
    this.assertShutdownDeadline(deadline, "forced process-tree cleanup");
  }

  private async settleOperations(): Promise<void> {
    if (this.settlingOperations.size > 0) {
      await Promise.allSettled([...this.settlingOperations]);
    }
  }

  private assertShutdownDeadline(deadline: AcpCleanupDeadline, stage: string): void {
    if (deadline.remainingMs() <= 0) {
      throw new Error(`ACP ${stage} exceeded the configured cleanup deadline.`);
    }
  }

  private waitForExit(waitMs: number): Promise<boolean> {
    if (this.process.exitCode !== null || this.process.signalCode !== null)
      return Promise.resolve(true);
    if (waitMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const exited = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.process.off("exit", exited);
        resolve(false);
      }, waitMs);
      this.process.once("exit", exited);
    });
  }
}

export function createAcpConnection(options: CreateAcpConnectionOptions): AcpConnection {
  return new SubprocessAcpConnection(options);
}
