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
import type { AcpConnection, AcpOperationOptions } from "./acpConnection.js";
import { AcpCleanupSequencer } from "./acpExecutionCleanup.js";
import type { LivePendingOperationHandle } from "./liveControl.js";
import {
  AcpLeaseReleasedError,
  acpLeaseReleaseInputSchema,
  acpLeaseReleaseResultSchema,
  acpOwnedSessionOpenSchema,
  type AcpConnectionLease,
  type AcpLeaseAdvertisedCapabilities,
  type AcpLeaseReleaseInput,
  type AcpLeaseReleaseResult,
  type AcpOwnedSession,
  type AcpOwnedSessionConfigInput,
  type AcpOwnedSessionOpenOptions,
  type AcpOwnedSessionStart
} from "./acpConnectionProvider.js";

const SESSION_CLOSE_STEP_LIMIT_MS = 100;

class DedicatedAcpOwnedSession implements AcpOwnedSession {
  private readonly cancellations = new Map<string, Promise<void>>();
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly host: DedicatedAcpConnectionLease,
    readonly created: NewSessionResponse
  ) {}

  get sessionId(): string {
    return this.created.sessionId;
  }

  prompt(prompt: PromptRequest["prompt"], options?: AcpOperationOptions): Promise<PromptResponse> {
    const released = this.host.rejectIfReleased("session/prompt");
    if (released) return released;
    return this.host.connection.prompt({ sessionId: this.sessionId, prompt }, options);
  }

  cancel(options?: AcpOperationOptions): Promise<void> {
    const released = this.host.rejectIfReleased("session/cancel");
    if (released) return released;
    const existing = this.cancellations.get(this.sessionId);
    if (existing) return existing;
    const operation = this.host.connection.cancel({ sessionId: this.sessionId }, options);
    this.cancellations.set(this.sessionId, operation);
    return operation;
  }

  close(options?: AcpOperationOptions): Promise<void> {
    const released = this.host.rejectIfReleased("session/close");
    if (released) return released;
    this.closePromise ??= this.host.closeBoundSession(options);
    return this.closePromise;
  }

  setMode(modeId: string, options?: AcpOperationOptions): Promise<SetSessionModeResponse> {
    const released = this.host.rejectIfReleased("session/set_mode");
    if (released) return released;
    return this.host.connection.setSessionMode({ sessionId: this.sessionId, modeId }, options);
  }

  setConfigOption(
    input: AcpOwnedSessionConfigInput,
    options?: AcpOperationOptions
  ): Promise<SetSessionConfigOptionResponse> {
    const released = this.host.rejectIfReleased("session/set_config_option");
    if (released) return released;
    return this.host.connection.setSessionConfigOption(
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

class DedicatedAcpConnectionLease implements AcpConnectionLease {
  readonly closed: Promise<void>;
  private initialized = false;
  private released = false;
  private advertisedCapabilities: AcpLeaseAdvertisedCapabilities = {
    loadSession: false,
    closeSession: false
  };
  private boundSession: DedicatedAcpOwnedSession | null = null;
  private sessionClosed = false;
  private releasePromise: Promise<AcpLeaseReleaseResult> | undefined;

  constructor(
    readonly connection: AcpConnection,
    private readonly sessionCwd: string
  ) {
    this.closed = connection.closed;
  }

  get processId(): number | null {
    return this.connection.processId;
  }

  get pendingOperationCount(): number {
    return this.connection.pendingOperationCount;
  }

  get pendingOperations(): ReadonlyMap<string, LivePendingOperationHandle> {
    return this.connection.pendingOperations;
  }

  get stderr(): readonly string[] {
    return this.connection.stderr;
  }

  get terminalFailure(): Error | null | undefined {
    return this.connection.terminalFailure;
  }

  get advertised(): AcpLeaseAdvertisedCapabilities {
    return this.advertisedCapabilities;
  }

  rejectIfReleased(operation: string): Promise<never> | undefined {
    if (this.released) return Promise.reject(new AcpLeaseReleasedError(operation));
    return undefined;
  }

  initialize(options?: AcpOperationOptions): Promise<InitializeResponse> {
    const released = this.rejectIfReleased("initialize");
    if (released) return released;
    return this.connection.initialize(options).then((response) => {
      this.initialized = true;
      this.advertisedCapabilities = {
        loadSession: response.agentCapabilities?.loadSession === true,
        closeSession: response.agentCapabilities?.sessionCapabilities?.close != null
      };
      return response;
    });
  }

  authenticate(
    request: AuthenticateRequest,
    options?: AcpOperationOptions
  ): Promise<AuthenticateResponse> {
    const released = this.rejectIfReleased("authenticate");
    if (released) return released;
    return this.connection.authenticate(request, options);
  }

  async openSession(
    start: AcpOwnedSessionStart,
    options?: AcpOwnedSessionOpenOptions
  ): Promise<AcpOwnedSession> {
    const released = this.rejectIfReleased("openSession");
    if (released) return released;
    if (!this.initialized) {
      throw new Error("ACP lease must be initialized before opening a session.");
    }
    if (this.boundSession) throw new Error("ACP lease already has an open session.");
    const parsed = acpOwnedSessionOpenSchema.parse(start);
    const cwd = options?.cwd ?? this.sessionCwd;
    const operationOptions: AcpOperationOptions = {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.cleanupDeadline ? { cleanupDeadline: options.cleanupDeadline } : {})
    };
    if (parsed.kind === "load") {
      if (!this.advertisedCapabilities.loadSession) {
        throw new Error("ACP agent does not advertise session/load capability.");
      }
      const loaded = await this.connection.loadSession(
        { sessionId: parsed.sessionId, cwd, mcpServers: [] },
        operationOptions
      );
      this.boundSession = new DedicatedAcpOwnedSession(this, {
        sessionId: parsed.sessionId,
        ...loaded
      });
      return this.boundSession;
    }
    const created = await this.connection.newSession({ cwd, mcpServers: [] }, operationOptions);
    this.boundSession = new DedicatedAcpOwnedSession(this, created);
    return this.boundSession;
  }

  cancel(notification: CancelNotification, options?: AcpOperationOptions): Promise<void> {
    const released = this.rejectIfReleased("session/cancel");
    if (released) return released;
    if (this.boundSession && notification.sessionId === this.boundSession.sessionId) {
      return this.boundSession.cancel(options);
    }
    return this.connection.cancel(notification, options);
  }

  release(input: AcpLeaseReleaseInput): Promise<AcpLeaseReleaseResult> {
    this.released = true;
    this.releasePromise ??= this.performRelease(input);
    return this.releasePromise;
  }

  closeBoundSession(options?: AcpOperationOptions): Promise<void> {
    if (!this.boundSession) throw new Error("ACP lease has no bound session to close.");
    if (!this.advertisedCapabilities.closeSession) {
      return Promise.reject(new Error("ACP agent does not advertise session/close capability."));
    }
    if (this.sessionClosed) return Promise.resolve();
    return this.connection.closeSession(this.boundSession.sessionId, options).then(() => {
      this.sessionClosed = true;
    });
  }

  private async performRelease(input: AcpLeaseReleaseInput): Promise<AcpLeaseReleaseResult> {
    const parsed = acpLeaseReleaseInputSchema.parse(input);
    const cleanup = new AcpCleanupSequencer(parsed.cleanupDeadline);
    const failures: unknown[] = [];
    let closedSession = false;
    if (this.advertisedCapabilities.closeSession && this.boundSession && !this.sessionClosed) {
      try {
        await cleanup.run(
          "session close",
          (timeoutMs) =>
            this.closeBoundSession({
              timeoutMs,
              cleanupDeadline: parsed.cleanupDeadline
            }),
          SESSION_CLOSE_STEP_LIMIT_MS
        );
        closedSession = true;
      } catch (error) {
        failures.push(error);
      }
    }
    let disposed = false;
    try {
      await cleanup.run("connection disposal", (timeoutMs) =>
        this.connection.dispose({ timeoutMs, cleanupDeadline: parsed.cleanupDeadline })
      );
      disposed = true;
    } catch (error) {
      failures.push(error);
    }
    return acpLeaseReleaseResultSchema.parse({ closedSession, disposed, failures });
  }
}

export function createDedicatedAcpConnectionLease(
  connection: AcpConnection,
  sessionCwd: string
): AcpConnectionLease {
  return new DedicatedAcpConnectionLease(connection, sessionCwd);
}
