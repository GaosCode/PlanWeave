import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeResponse,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionResponse,
  SetSessionModeResponse
} from "@agentclientprotocol/sdk";
import type { AcpOperationOptions } from "./acpConnection.js";
import { AcpCleanupSequencer } from "./acpExecutionCleanup.js";
import type { LivePendingOperationHandle } from "./liveControl.js";
import {
  AcpLeaseReleasedError,
  acpLeaseReleaseInputSchema,
  acpLeaseReleaseResultSchema,
  acpOwnedSessionOpenSchema,
  type AcpConnectionAcquireRequest,
  type AcpConnectionLease,
  type AcpConnectionProvider,
  type AcpLeaseAdvertisedCapabilities,
  type AcpLeaseReleaseInput,
  type AcpLeaseReleaseResult,
  type AcpOwnedSession,
  type AcpOwnedSessionConfigInput,
  type AcpOwnedSessionOpenOptions,
  type AcpOwnedSessionStart
} from "./acpConnectionProvider.js";
import { AcpSharedConnectionLostError } from "./acpSharedConnectionErrors.js";
import {
  createSharedLeaseId,
  SharedAcpConnectionPool,
  SHARED_ACP_CONNECTION_IDLE_MS,
  type SharedAcpConnectionEntry,
  type SharedAcpConnectionPoolOptions,
  type SharedAcpLeaseHandle
} from "./acpSharedConnectionPool.js";

const SESSION_CANCEL_STEP_LIMIT_MS = 100;

export type SharedAcpConnectionProviderOptions = SharedAcpConnectionPoolOptions;

class SharedAcpOwnedSession implements AcpOwnedSession {
  private readonly cancellations = new Map<string, Promise<void>>();
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly host: SharedAcpConnectionLease,
    readonly created: NewSessionResponse
  ) {}

  get sessionId(): string {
    return this.created.sessionId;
  }

  prompt(prompt: PromptRequest["prompt"], options?: AcpOperationOptions): Promise<PromptResponse> {
    const unusable = this.host.rejectIfUnusable("session/prompt");
    if (unusable) return unusable;
    return this.host.entry.router.runPrompt(this.sessionId, () =>
      this.host.entry.connection().prompt({ sessionId: this.sessionId, prompt }, options)
    );
  }

  cancel(options?: AcpOperationOptions): Promise<void> {
    const unusable = this.host.rejectIfUnusable("session/cancel");
    if (unusable) return unusable;
    const existing = this.cancellations.get(this.sessionId);
    if (existing) return existing;
    const operation = this.host.entry.connection().cancel({ sessionId: this.sessionId }, options);
    this.cancellations.set(this.sessionId, operation);
    return operation;
  }

  close(options?: AcpOperationOptions): Promise<void> {
    const unusable = this.host.rejectIfUnusable("session/close");
    if (unusable) return unusable;
    this.closePromise ??= this.host.closeBoundSession(options);
    return this.closePromise;
  }

  setMode(modeId: string, options?: AcpOperationOptions): Promise<SetSessionModeResponse> {
    const unusable = this.host.rejectIfUnusable("session/set_mode");
    if (unusable) return unusable;
    return this.host.entry
      .connection()
      .setSessionMode({ sessionId: this.sessionId, modeId }, options);
  }

  setConfigOption(
    input: AcpOwnedSessionConfigInput,
    options?: AcpOperationOptions
  ): Promise<SetSessionConfigOptionResponse> {
    const unusable = this.host.rejectIfUnusable("session/set_config_option");
    if (unusable) return unusable;
    return this.host.entry.connection().setSessionConfigOption(
      typeof input.value === "boolean"
        ? {
            sessionId: this.sessionId,
            configId: input.configId,
            type: "boolean",
            value: input.value
          }
        : { sessionId: this.sessionId, configId: input.configId, value: input.value },
      options
    );
  }
}

class SharedAcpConnectionLease implements AcpConnectionLease, SharedAcpLeaseHandle {
  readonly leaseId = createSharedLeaseId();
  readonly closed: Promise<void>;
  private initialized = false;
  private released = false;
  private boundSession: SharedAcpOwnedSession | null = null;
  private sessionClosed = false;
  private releasePromise: Promise<AcpLeaseReleaseResult> | undefined;
  private lostError: AcpSharedConnectionLostError | null = null;
  private promptReject: ((error: Error) => void) | null = null;

  constructor(
    readonly entry: SharedAcpConnectionEntry,
    private readonly sessionCwd: string
  ) {
    this.closed = entry.closed;
    this.entry.addLease(this);
  }

  get processId(): number | null {
    return this.entry.processId();
  }

  get pendingOperationCount(): number {
    return this.entry.connection().pendingOperationCount;
  }

  get pendingOperations(): ReadonlyMap<string, LivePendingOperationHandle> {
    return this.entry.connection().pendingOperations;
  }

  get stderr(): readonly string[] {
    return this.entry.connection().stderr;
  }

  get terminalFailure(): Error | null | undefined {
    return this.lostError ?? this.entry.connection().terminalFailure;
  }

  get advertised(): AcpLeaseAdvertisedCapabilities {
    return this.entry.advertised;
  }

  notifyLost(error: AcpSharedConnectionLostError): void {
    this.lostError ??= error;
    this.promptReject?.(error);
  }

  rejectIfUnusable(operation: string): Promise<never> | undefined {
    if (this.lostError) return Promise.reject(this.lostError);
    if (this.released && operation !== "session/cancel" && operation !== "session/close") {
      return Promise.reject(new AcpLeaseReleasedError(operation));
    }
    return undefined;
  }

  initialize(options?: AcpOperationOptions): Promise<InitializeResponse> {
    const unusable = this.rejectIfUnusable("initialize");
    if (unusable) return unusable;
    return this.entry.initialize(options).then((response) => {
      this.initialized = true;
      return response;
    });
  }

  authenticate(
    request: AuthenticateRequest,
    options?: AcpOperationOptions
  ): Promise<AuthenticateResponse> {
    const unusable = this.rejectIfUnusable("authenticate");
    if (unusable) return unusable;
    return this.entry.authenticate(request, options);
  }

  async openSession(
    start: AcpOwnedSessionStart,
    options?: AcpOwnedSessionOpenOptions
  ): Promise<AcpOwnedSession> {
    const unusable = this.rejectIfUnusable("openSession");
    if (unusable) return unusable;
    if (!this.initialized) {
      throw new Error("ACP lease must be initialized before opening a session.");
    }
    if (this.boundSession) throw new Error("ACP lease already has an open session.");
    const parsed = acpOwnedSessionOpenSchema.parse(start);
    const cwd = options?.cwd ?? this.sessionCwd;
    const ownerId = options?.ownerId ?? this.leaseId;
    const operationOptions: AcpOperationOptions = {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.cleanupDeadline ? { cleanupDeadline: options.cleanupDeadline } : {})
    };
    const created = await this.entry.router.withOpening(
      ownerId,
      options?.handlers ?? {},
      async () => {
        if (parsed.kind === "load") {
          if (!this.entry.advertised.loadSession) {
            throw new Error("ACP agent does not advertise session/load capability.");
          }
          const loaded = await this.entry
            .connection()
            .loadSession({ sessionId: parsed.sessionId, cwd, mcpServers: [] }, operationOptions);
          return { sessionId: parsed.sessionId, ...loaded };
        }
        return this.entry.connection().newSession({ cwd, mcpServers: [] }, operationOptions);
      }
    );
    this.boundSession = new SharedAcpOwnedSession(this, created);
    this.entry.bindSession(this.leaseId, created.sessionId);
    return this.boundSession;
  }

  cancel(notification: CancelNotification, options?: AcpOperationOptions): Promise<void> {
    const unusable = this.rejectIfUnusable("session/cancel");
    if (unusable) return unusable;
    if (this.boundSession && notification.sessionId === this.boundSession.sessionId) {
      return this.boundSession.cancel(options);
    }
    return this.entry.connection().cancel(notification, options);
  }

  release(input: AcpLeaseReleaseInput): Promise<AcpLeaseReleaseResult> {
    this.released = true;
    this.releasePromise ??= this.performRelease(input);
    return this.releasePromise;
  }

  closeBoundSession(options?: AcpOperationOptions): Promise<void> {
    if (!this.boundSession) throw new Error("ACP lease has no bound session to close.");
    if (!this.entry.advertised.closeSession) {
      return Promise.reject(new Error("ACP agent does not advertise session/close capability."));
    }
    if (this.sessionClosed) return Promise.resolve();
    return this.entry
      .connection()
      .closeSession(this.boundSession.sessionId, options)
      .then(() => {
        this.sessionClosed = true;
      });
  }

  private async performRelease(input: AcpLeaseReleaseInput): Promise<AcpLeaseReleaseResult> {
    const parsed = acpLeaseReleaseInputSchema.parse(input);
    const cleanup = new AcpCleanupSequencer(parsed.cleanupDeadline);
    const failures: unknown[] = [];
    let closedSession = false;
    if (this.boundSession) {
      try {
        await cleanup.run(
          "session cancellation",
          (timeoutMs) =>
            this.boundSession?.cancel({
              timeoutMs,
              cleanupDeadline: parsed.cleanupDeadline
            }) ?? Promise.resolve(),
          SESSION_CANCEL_STEP_LIMIT_MS
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.entry.advertised.closeSession && this.boundSession && !this.sessionClosed) {
      try {
        await cleanup.run(
          "session close",
          (timeoutMs) =>
            this.closeBoundSession({
              timeoutMs,
              cleanupDeadline: parsed.cleanupDeadline
            }),
          this.entry.sessionCloseBudgetMs()
        );
        closedSession = true;
      } catch (error) {
        failures.push(error);
        await this.entry.poison(error, this.leaseId);
        this.entry.removeLease(this);
        return acpLeaseReleaseResultSchema.parse({
          closedSession: false,
          disposed: true,
          failures
        });
      }
    }
    this.entry.removeLease(this);
    let disposed = false;
    if (this.entry.leaseCount() === 0) {
      try {
        if (this.entry.advertised.closeSession) {
          disposed = await this.entry.idleThenDispose();
        } else {
          await this.entry.disposeImmediate();
          disposed = true;
        }
      } catch (error) {
        failures.push(error);
      }
    }
    return acpLeaseReleaseResultSchema.parse({ closedSession, disposed, failures });
  }
}

export function createSharedAcpConnectionProvider(
  options: SharedAcpConnectionProviderOptions = {}
): AcpConnectionProvider {
  const pool = new SharedAcpConnectionPool(options);
  return {
    async acquire(request: AcpConnectionAcquireRequest): Promise<AcpConnectionLease> {
      const entry = await pool.acquire(request);
      return new SharedAcpConnectionLease(entry, request.cwd);
    },
    shutdown: () => pool.shutdown()
  };
}

let processSharedProvider: AcpConnectionProvider | undefined;

export function processSharedAcpConnectionProvider(
  options: SharedAcpConnectionProviderOptions = {}
): AcpConnectionProvider {
  if (options.connect || options.idleMs !== undefined) {
    return createSharedAcpConnectionProvider(options);
  }
  processSharedProvider ??= createSharedAcpConnectionProvider();
  return processSharedProvider;
}

export { SHARED_ACP_CONNECTION_IDLE_MS, SharedAcpConnectionPool };
export type { SharedAcpConnectionPoolOptions };
