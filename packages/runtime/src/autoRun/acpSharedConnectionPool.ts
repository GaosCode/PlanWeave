import { randomUUID } from "node:crypto";
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  InitializeResponse
} from "@agentclientprotocol/sdk";
import {
  createAcpConnection,
  type AcpConnection,
  type AcpOperationOptions,
  type AcpProtocolObserver,
  type CreateAcpConnectionOptions
} from "./acpConnection.js";
import { createAcpCleanupDeadline, type AcpCleanupDeadline } from "./acpExecutionCleanup.js";
import type {
  AcpConnectionAcquireRequest,
  AcpLeaseAdvertisedCapabilities
} from "./acpConnectionProvider.js";
import {
  AcpSharedConnectionAuthRequiredError,
  AcpSharedConnectionCleanupError,
  AcpSharedConnectionLostError,
  AcpSharedConnectionShutdownError
} from "./acpSharedConnectionErrors.js";
import { acpSharedConnectionKey } from "./acpSharedConnectionKey.js";
import { AcpSessionRouter } from "./acpSessionRouter.js";
import { coordinateAcpAuthentication } from "./acpAuthentication.js";

export const SHARED_ACP_CONNECTION_IDLE_MS = 250;

export type SharedAcpConnectionPoolOptions = {
  readonly connect?: (options: CreateAcpConnectionOptions) => AcpConnection;
  readonly idleMs?: number;
};

type PendingStart = {
  readonly promise: Promise<SharedAcpPoolEntry>;
  readonly controller: AbortController;
  cancellation?: Promise<void>;
  waiters: number;
  cleanupBoundary: { deadline?: AcpCleanupDeadline };
};

export type SharedAcpConnectionEntryState = "starting" | "ready" | "draining" | "failed" | "closed";

export type SharedAcpLeaseHandle = {
  readonly leaseId: string;
  notifyLost(error: AcpSharedConnectionLostError): void;
};

export type SharedAcpConnectionEntry = {
  readonly key: string;
  readonly router: AcpSessionRouter;
  readonly advertised: AcpLeaseAdvertisedCapabilities;
  readonly closed: Promise<void>;
  state(): SharedAcpConnectionEntryState;
  connection(): AcpConnection;
  processId(): number | null;
  initialize(options?: AcpOperationOptions): Promise<InitializeResponse>;
  authenticate(
    request: AuthenticateRequest,
    options?: AcpOperationOptions
  ): Promise<AuthenticateResponse>;
  addLease(handle: SharedAcpLeaseHandle): void;
  removeLease(handle: SharedAcpLeaseHandle): void;
  bindSession(leaseId: string, sessionId: string): void;
  leaseCount(): number;
  cancelIdle(): void;
  idleThenDispose(): Promise<boolean>;
  disposeImmediate(deadline?: AcpCleanupDeadline): Promise<void>;
  poison(error: unknown, exceptLeaseId?: string, deadline?: AcpCleanupDeadline): Promise<void>;
  sessionCloseBudgetMs(): number;
};

export class SharedAcpConnectionPool {
  private readonly connect: (options: CreateAcpConnectionOptions) => AcpConnection;
  private readonly idleMs: number;
  private readonly entries = new Map<string, SharedAcpPoolEntry>();
  private readonly starts = new Map<string, PendingStart>();
  private readonly cleanupFailures = new Map<string, AcpSharedConnectionCleanupError>();
  private shuttingDown = false;

  constructor(options: SharedAcpConnectionPoolOptions = {}) {
    this.connect = options.connect ?? createAcpConnection;
    this.idleMs = options.idleMs ?? SHARED_ACP_CONNECTION_IDLE_MS;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs <= 0) {
      throw new Error("ACP shared connection idle interval must be a positive integer.");
    }
  }

  async acquire(request: AcpConnectionAcquireRequest): Promise<SharedAcpConnectionEntry> {
    if (this.shuttingDown) throw new AcpSharedConnectionShutdownError();
    if (request.signal?.aborted) throw request.signal.reason;
    const key = acpSharedConnectionKey(request);
    const unsafe = this.cleanupFailures.get(key);
    if (unsafe) throw unsafe;
    const existing = this.entries.get(key);
    if (existing && existing.isReusable()) {
      existing.cancelIdle();
      return existing;
    }
    let pending = this.starts.get(key);
    if (pending?.controller.signal.aborted) {
      try {
        await (pending.cancellation ?? pending.promise);
      } catch (error) {
        if (error instanceof AcpSharedConnectionCleanupError) throw error;
      }
      const failed = this.cleanupFailures.get(key);
      if (failed) throw failed;
      return this.acquire(request);
    }
    if (!pending) {
      const controller = new AbortController();
      const cleanupBoundary: PendingStart["cleanupBoundary"] = {};
      pending = {
        cleanupBoundary,
        controller,
        waiters: 0,
        promise: this.startEntry(key, {
          ...request,
          signal: controller.signal,
          get cleanupDeadline() {
            return cleanupBoundary.deadline;
          }
        })
      };
      this.starts.set(key, pending);
      const started = pending;
      const clear = () => {
        const remove = () => {
          if (this.starts.get(key) === started) this.starts.delete(key);
        };
        if (started.cancellation) void started.cancellation.then(remove, remove);
        else remove();
      };
      void started.promise.then(clear, clear);
    }
    return this.waitForStart(key, pending, request);
  }

  private waitForStart(
    key: string,
    pending: PendingStart,
    request: AcpConnectionAcquireRequest
  ): Promise<SharedAcpPoolEntry> {
    const signal = request.signal;
    pending.waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (outcome: { entry: SharedAcpPoolEntry } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        pending.waiters -= 1;
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.entry);
      };
      const onAbort = () => {
        if (settled) return;
        if (pending.waiters > 1) {
          finish({ error: signal?.reason });
          return;
        }
        pending.cleanupBoundary.deadline =
          request.cleanupDeadline ?? createAcpCleanupDeadline(request.shutdown.cleanupDeadlineMs);
        pending.controller.abort(signal?.reason);
        pending.cancellation ??= pending.promise.then(
          async (entry) => {
            await entry.disposeImmediate(pending.cleanupBoundary.deadline);
          },
          (error) => {
            if (error instanceof AcpSharedConnectionCleanupError) throw error;
          }
        );
        void pending.cancellation.then(
          () => finish({ error: signal?.reason }),
          (error) => finish({ error: this.rememberCleanupFailure(key, error) })
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void pending.promise.then(
        (entry) => {
          if (!signal?.aborted) finish({ entry });
        },
        (error) => {
          if (!signal?.aborted) finish({ error });
        }
      );
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const entries = [...this.entries.values()];
    const starts = [...this.starts.values()];
    for (const pending of starts) pending.controller.abort(new AcpSharedConnectionShutdownError());
    this.starts.clear();
    const outcomes = await Promise.allSettled([
      ...entries.map((entry) => entry.shutdown()),
      ...starts.map((pending) => pending.cancellation ?? pending.promise)
    ]);
    const failures = new Set<unknown>(this.cleanupFailures.values());
    outcomes.forEach((outcome, index) => {
      if (outcome.status !== "rejected") return;
      if (index < entries.length || outcome.reason instanceof AcpSharedConnectionCleanupError) {
        failures.add(outcome.reason);
      }
    });
    if (failures.size === 1) throw [...failures][0];
    if (failures.size > 1) {
      throw new AggregateError([...failures], "ACP shared connection shutdown failed.");
    }
  }

  private rememberCleanupFailure(key: string, error: unknown): AcpSharedConnectionCleanupError {
    const failure =
      this.cleanupFailures.get(key) ??
      (error instanceof AcpSharedConnectionCleanupError
        ? error
        : new AcpSharedConnectionCleanupError(error));
    this.cleanupFailures.set(key, failure);
    return failure;
  }

  private async startEntry(
    key: string,
    request: AcpConnectionAcquireRequest
  ): Promise<SharedAcpPoolEntry> {
    const existing = this.entries.get(key);
    if (existing && existing.isReusable()) {
      existing.cancelIdle();
      return existing;
    }
    if (this.shuttingDown) throw new AcpSharedConnectionShutdownError();
    const entry = new SharedAcpPoolEntry(
      key,
      this.connect,
      request,
      this.idleMs,
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
      (error) => this.rememberCleanupFailure(key, error)
    );
    this.entries.set(key, entry);
    try {
      await entry.start();
      return entry;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      try {
        await entry.disposeImmediate();
      } catch (disposeError) {
        throw this.rememberCleanupFailure(
          key,
          new AggregateError(
            [error, disposeError],
            "ACP shared connection start and disposal failed."
          )
        );
      }
      throw error;
    }
  }
}

class SharedAcpPoolEntry implements SharedAcpConnectionEntry {
  readonly router = new AcpSessionRouter();
  private entryState: SharedAcpConnectionEntryState = "starting";
  private live: AcpConnection | null = null;
  private initializeResponse: InitializeResponse | undefined;
  private initializePromise: Promise<InitializeResponse> | undefined;
  private authenticateResponse: AuthenticateResponse | undefined;
  private authenticatePromise: Promise<AuthenticateResponse> | undefined;
  private advertisedCapabilities: AcpLeaseAdvertisedCapabilities = {
    loadSession: false,
    closeSession: false
  };
  private readonly leases = new Set<SharedAcpLeaseHandle>();
  private readonly sessions = new Map<string, string>();
  private readonly lostOwners = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idlePromise: Promise<void> | null = null;
  private idleSettle: { resolve(): void; reject(error: unknown): void } | null = null;
  private disposePromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private observers: AcpProtocolObserver[] = [];
  private closedPromise: Promise<void> = Promise.resolve();
  private ended = false;

  constructor(
    readonly key: string,
    private readonly connect: (options: CreateAcpConnectionOptions) => AcpConnection,
    private readonly request: AcpConnectionAcquireRequest,
    private readonly idleMs: number,
    private readonly forget: () => void,
    private readonly reportCleanupFailure: (error: unknown) => AcpSharedConnectionCleanupError
  ) {}

  state(): SharedAcpConnectionEntryState {
    return this.entryState;
  }

  get advertised(): AcpLeaseAdvertisedCapabilities {
    return this.advertisedCapabilities;
  }

  get closed(): Promise<void> {
    return this.closedPromise;
  }

  connection(): AcpConnection {
    if (!this.live) throw new Error("ACP shared connection is not started.");
    return this.live;
  }

  processId(): number | null {
    return this.live?.processId ?? null;
  }

  isReusable(): boolean {
    return this.entryState === "ready" || this.entryState === "draining";
  }

  leaseCount(): number {
    return this.leases.size;
  }

  addLease(handle: SharedAcpLeaseHandle): void {
    if (this.entryState === "failed" || this.entryState === "closed") {
      throw new AcpSharedConnectionLostError();
    }
    this.leases.add(handle);
    this.cancelIdle();
    if (this.entryState === "draining") this.entryState = "ready";
  }

  removeLease(handle: SharedAcpLeaseHandle): void {
    this.leases.delete(handle);
    this.sessions.delete(handle.leaseId);
    this.router.unbindOwner(handle.leaseId);
  }

  bindSession(leaseId: string, sessionId: string): void {
    this.sessions.set(leaseId, sessionId);
  }

  cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const settle = this.idleSettle;
    this.idleSettle = null;
    this.idlePromise = null;
    if (this.entryState === "draining") this.entryState = "ready";
    settle?.resolve();
  }

  initialize(options?: AcpOperationOptions): Promise<InitializeResponse> {
    if (this.initializeResponse) return Promise.resolve(this.initializeResponse);
    this.initializePromise ??= this.connection()
      .initialize(options)
      .then((response) => {
        this.initializeResponse = response;
        this.advertisedCapabilities = {
          loadSession: response.agentCapabilities?.loadSession === true,
          closeSession: response.agentCapabilities?.sessionCapabilities?.close != null
        };
        return response;
      })
      .catch((error: unknown) => {
        this.initializePromise = undefined;
        throw error;
      });
    return this.initializePromise;
  }

  authenticate(
    request: AuthenticateRequest,
    options?: AcpOperationOptions
  ): Promise<AuthenticateResponse> {
    if (this.authenticateResponse) return Promise.resolve(this.authenticateResponse);
    this.authenticatePromise ??= this.connection()
      .authenticate(request, options)
      .then((response) => {
        this.authenticateResponse = response;
        return response;
      })
      .catch((error: unknown) => {
        this.authenticatePromise = undefined;
        throw error;
      });
    return this.authenticatePromise;
  }

  start(): Promise<void> {
    this.startPromise ??= this.startConnection();
    return this.startPromise;
  }

  async idleThenDispose(): Promise<boolean> {
    if (this.disposePromise) {
      await this.disposePromise;
      return true;
    }
    if (this.leases.size > 0) return false;
    this.entryState = "draining";
    this.idlePromise ??= new Promise<void>((resolve, reject) => {
      this.idleSettle = { resolve, reject };
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        const settle = this.idleSettle;
        this.idleSettle = null;
        this.idlePromise = null;
        if (this.leases.size > 0 || this.entryState !== "draining") {
          settle?.resolve();
          return;
        }
        void this.disposeImmediate().then(
          () => settle?.resolve(),
          (error) => settle?.reject(error)
        );
      }, this.idleMs);
    });
    await this.idlePromise;
    if (this.disposePromise) {
      await this.disposePromise;
      return true;
    }
    return false;
  }

  disposeImmediate(deadline?: AcpCleanupDeadline): Promise<void> {
    this.disposePromise ??= this.disposeTransport(deadline);
    this.cancelIdle();
    return this.disposePromise;
  }

  sessionCloseBudgetMs(): number {
    return this.request.shutdown.eofDrainMs;
  }

  async poison(
    error: unknown,
    exceptLeaseId?: string,
    deadline?: AcpCleanupDeadline
  ): Promise<void> {
    const lost = new AcpSharedConnectionLostError(
      error instanceof Error ? error.message : "ACP shared connection was lost."
    );
    this.fanOutLost(lost, exceptLeaseId);
    await this.disposeImmediate(deadline);
  }

  async shutdown(): Promise<void> {
    this.cancelIdle();
    const failures: unknown[] = [];
    const connection = this.live;
    if (connection) {
      for (const sessionId of this.sessions.values()) {
        try {
          await connection.cancel({ sessionId });
        } catch (error) {
          failures.push(error);
        }
        if (this.advertisedCapabilities.closeSession) {
          try {
            await connection.closeSession(sessionId);
          } catch (error) {
            failures.push(error);
          }
        }
      }
    }
    this.fanOutLost(new AcpSharedConnectionShutdownError());
    try {
      await this.disposeImmediate();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "ACP shared connection provider shutdown failed.");
    }
  }

  private async startConnection(): Promise<void> {
    try {
      if (this.request.observer) this.observers.push(this.request.observer);
      const connection = this.connect({
        ...this.request,
        onSessionUpdate: (notification) => this.router.sessionUpdate(notification),
        onPermissionRequest: (request) => this.router.permission(request),
        onElicitationRequest: (request) => this.router.elicitation(request),
        ...(this.request.onTerminalOutput
          ? { onTerminalOutput: (request) => this.router.terminalOutput(request) }
          : {}),
        ...(this.observers.length > 0
          ? {
              observer: {
                redact: (payload) => this.observers[0]?.redact(payload) ?? payload,
                observe: (observation) => {
                  for (const observer of this.observers) observer.observe(observation);
                }
              }
            }
          : {})
      });
      this.live = connection;
      this.closedPromise = connection.closed.finally(() => {
        this.onConnectionEnded();
      });
      const request = this.request;
      const initialized = await this.initialize({
        signal: this.request.signal,
        get cleanupDeadline() {
          return request.cleanupDeadline;
        },
        timeoutMs: this.request.defaultTimeoutMs
      });
      if (this.request.signal?.aborted) throw this.request.signal.reason;
      await this.authenticateIfHeadless(initialized);
      if (this.request.signal?.aborted) throw this.request.signal.reason;
      this.entryState = "ready";
    } catch (error) {
      try {
        await this.disposeImmediate(this.request.cleanupDeadline);
      } catch (disposeError) {
        throw this.reportCleanupFailure(
          new AggregateError(
            [error, disposeError],
            "ACP shared connection start and disposal failed."
          )
        );
      }
      throw error;
    }
  }

  private async authenticateIfHeadless(initialized: InitializeResponse): Promise<void> {
    const request = this.request;
    const outcome = await coordinateAcpAuthentication({
      connection: this,
      initialized,
      availableEnvironmentVariables: new Set(Object.keys(request.env)),
      operationOptions: {
        signal: request.signal,
        timeoutMs: request.defaultTimeoutMs,
        get cleanupDeadline() {
          return request.cleanupDeadline;
        }
      }
    });
    if (outcome.kind === "auth_required") {
      throw new AcpSharedConnectionAuthRequiredError(outcome, initialized);
    }
  }

  private onConnectionEnded(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.entryState === "closed") return;
    this.entryState = "failed";
    this.fanOutLost(new AcpSharedConnectionLostError());
    void this.disposeImmediate().catch((error) => this.reportCleanupFailure(error));
  }

  private fanOutLost(
    error: AcpSharedConnectionLostError | AcpSharedConnectionShutdownError,
    exceptLeaseId?: string
  ): void {
    const lost =
      error instanceof AcpSharedConnectionLostError
        ? error
        : new AcpSharedConnectionLostError(error.message);
    for (const lease of this.leases) {
      if (lease.leaseId === exceptLeaseId) continue;
      if (this.lostOwners.has(lease.leaseId)) continue;
      this.lostOwners.add(lease.leaseId);
      lease.notifyLost(lost);
    }
  }

  private async disposeTransport(deadline?: AcpCleanupDeadline): Promise<void> {
    this.cancelIdle();
    this.entryState = this.entryState === "failed" ? "failed" : "closed";
    const connection = this.live;
    try {
      if (connection) {
        await connection.dispose({
          cleanupDeadline:
            deadline ?? createAcpCleanupDeadline(this.request.shutdown.cleanupDeadlineMs)
        });
      }
    } catch (error) {
      throw this.reportCleanupFailure(error);
    } finally {
      this.entryState = "closed";
      this.forget();
    }
  }
}

export function createSharedLeaseId(): string {
  return randomUUID();
}
