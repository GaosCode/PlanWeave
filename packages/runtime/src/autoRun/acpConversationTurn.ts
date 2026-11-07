import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { ResolvedAcpProfile } from "../acpProfile/resolver.js";
import type { ResolvedAgentEnvironment } from "../process/agentProcessEnv.js";
import { prepareExecutionHostInvocation } from "../process/wslExecutionHost.js";
import type {
  AcpConnection,
  AcpDisposeOptions,
  CreateAcpConnectionOptions
} from "./acpConnection.js";
import type {
  AcpConnectionLease,
  AcpConnectionProvider,
  AcpOwnedSession,
  AcpSessionHandlerPort
} from "./acpConnectionProvider.js";
import { createAcpConnectionProvider } from "./acpConnectionProviderFactory.js";
import {
  AcpAuthenticationRequiredError,
  coordinateAcpAuthentication,
  mayProbeSessionDespiteAuthRequired,
  type AcpAuthenticationHints
} from "./acpAuthentication.js";
import { gateAcpCapabilities } from "./acpCapabilityGate.js";
import {
  acpConversationTurnCancelResultSchema,
  acpConversationTurnQueryResultSchema,
  acpConversationTurnStateSchema,
  type AcpConversationTurnCancelResult,
  type AcpConversationTurnAdmission,
  type AcpConversationTurnIdentity,
  type AcpConversationTurnPhase,
  type AcpConversationTurnQueryResult,
  type AcpConversationTurnState
} from "./acpConversationTurnContract.js";
import { createAcpSessionNotificationNormalizer } from "./acpEventNormalization.js";
import { AcpSharedConnectionCleanupError } from "./acpSharedConnectionErrors.js";
import {
  AcpCleanupSequencer,
  createAcpCleanupDeadline,
  type AcpCleanupDeadline
} from "./acpExecutionCleanup.js";
import { createAcpEventSubscriptionCloseResult } from "./acpEventPublisher.js";
import type { AcpCompletedConversationWriter } from "./acpEventStore.js";
import {
  normalizedRedactedContent,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import { acpCorrelationSchema } from "./runnerContractSchemas.js";
import { redactAcpProtocolPayload, redactRunnerEventText } from "./runnerEventRedaction.js";

export type AcpConversationTurnConnection = Pick<
  AcpConnection,
  | "initialize"
  | "authenticate"
  | "loadSession"
  | "newSession"
  | "prompt"
  | "cancel"
  | "closeSession"
  | "setSessionMode"
  | "setSessionConfigOption"
  | "processId"
  | "pendingOperationCount"
  | "pendingOperations"
  | "stderr"
  | "closed"
> & { dispose(options?: AcpDisposeOptions): Promise<void> };

export type AcpConversationTurnConnectionOptions = Pick<
  CreateAcpConnectionOptions,
  | "launch"
  | "cwd"
  | "spawnCwd"
  | "env"
  | "decorateProcessTree"
  | "cleanupExitedProcessTree"
  | "clientInfo"
  | "onSessionUpdate"
  | "onPermissionRequest"
  | "onElicitationRequest"
  | "observer"
  | "defaultTimeoutMs"
  | "shutdown"
>;

export type AcpConversationTurnInput = {
  key: string;
  identity: AcpConversationTurnIdentity;
  cwd: string;
  profile: ResolvedAcpProfile;
  environment: ResolvedAgentEnvironment;
  authenticationHints?: AcpAuthenticationHints;
  text: string;
  timeoutMs: number;
  eventStore:
    | AcpCompletedConversationWriter
    | ((signal: AbortSignal) => Promise<AcpCompletedConversationWriter>);
};

export type AcpConversationTurnNotification = {
  readonly identity: AcpConversationTurnIdentity;
  readonly signal: AbortSignal;
};
export type TurnStateSubscriber = (
  notification: AcpConversationTurnNotification
) => void | Promise<void>;
type PendingTurnNotification = {
  dirty: boolean;
  promise: Promise<void>;
  fail(error: unknown): void;
};
type ConnectionFactory = (options: CreateAcpConnectionOptions) => AcpConnection;
type ActiveConversationTurn = {
  input: AcpConversationTurnInput;
  controller: AbortController;
  phase: AcpConversationTurnPhase;
  lease: AcpConnectionLease | null;
  session: AcpOwnedSession | null;
  sessionLoaded: boolean;
  cancellationRequested: boolean;
  cancelPromise: Promise<void> | null;
  cancellationDiagnostic: string | null;
  cleanupDeadline?: AcpCleanupDeadline;
  finalizationDeadline?: AcpCleanupDeadline;
  cleanupFailed: boolean;
  notifications: AbortController;
  persistenceErrors: unknown[];
  pendingPersistence: Set<Promise<void>>;
  pendingNotifications: Map<TurnStateSubscriber, PendingTurnNotification>;
};
type StableConversationTurnIdentity = Omit<AcpConversationTurnIdentity, "version" | "turnId">;
type TerminalConversationTurn = { state: AcpConversationTurnState; expiresAt: number };
type TurnNotificationScope = Pick<
  ActiveConversationTurn,
  "input" | "notifications" | "pendingNotifications"
>;

const DEFAULT_TERMINAL_TURN_LIMIT = 256;
const DEFAULT_TERMINAL_TURN_TTL_MS = 5 * 60_000;

class AcpConversationTurnCancelledError extends Error {
  constructor() {
    super("ACP conversation turn was cancelled by the user.");
    this.name = "AcpConversationTurnCancelledError";
  }
}

function diagnostic(error: unknown): string {
  return redactRunnerEventText(error instanceof Error ? error.message : String(error)).text;
}

function sameIdentity(
  left: AcpConversationTurnIdentity,
  right: AcpConversationTurnIdentity
): boolean {
  return (
    left.version === right.version &&
    left.ref.projectRoot === right.ref.projectRoot &&
    left.ref.canvasId === right.ref.canvasId &&
    left.recordId === right.recordId &&
    left.executorRunId === right.executorRunId &&
    left.claimRef === right.claimRef &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId
  );
}

function sameStableIdentity(
  left: StableConversationTurnIdentity,
  right: StableConversationTurnIdentity
): boolean {
  return (
    left.ref.projectRoot === right.ref.projectRoot &&
    left.ref.canvasId === right.ref.canvasId &&
    left.recordId === right.recordId &&
    left.executorRunId === right.executorRunId &&
    left.claimRef === right.claimRef &&
    left.sessionId === right.sessionId
  );
}

function stateOf(
  turn: ActiveConversationTurn,
  terminal: AcpConversationTurnState["terminal"] = null
): AcpConversationTurnState {
  return acpConversationTurnStateSchema.parse({
    identity: turn.input.identity,
    phase: terminal ? "terminal" : turn.phase,
    terminal,
    cancellationRequested: turn.cancellationRequested,
    cancellable: terminal === null && !turn.cancellationRequested && turn.phase !== "cleaning"
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AcpConversationTurnCancelledError();
}

async function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: ((error: Error) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function combineTurnErrors(primary: unknown, secondary: readonly unknown[]): unknown {
  const errors = [...new Set([...(primary === undefined ? [] : [primary]), ...secondary])];
  if (errors.length === 1) return errors[0];
  const cause = primary ?? errors[0];
  return new AggregateError(errors, diagnostic(cause), { cause });
}

export class AcpConversationTurnCoordinator {
  private readonly active = new Map<string, ActiveConversationTurn>();
  private readonly finalizing = new Set<string>();
  private readonly pendingCleanup = new Map<string, Promise<void>>();
  private readonly pendingWrites = new Map<string, Set<Promise<void>>>();
  private readonly terminal = new Map<string, TerminalConversationTurn>();
  private readonly subscribers = new Map<string, Set<TurnStateSubscriber>>();
  private readonly settledNotifications = new Map<string, TurnNotificationScope>();
  private readonly terminalLimit: number;
  private readonly terminalTtlMs: number;

  private readonly injectedProvider?: AcpConnectionProvider;
  private readonly connect?: ConnectionFactory;
  private dedicatedProvider?: AcpConnectionProvider;
  private sharedProvider?: AcpConnectionProvider;

  constructor(
    connect?: ConnectionFactory,
    options: {
      terminalLimit?: number;
      terminalTtlMs?: number;
      provider?: AcpConnectionProvider;
    } = {}
  ) {
    this.injectedProvider = options.provider;
    this.connect = connect;
    this.terminalLimit = options.terminalLimit ?? DEFAULT_TERMINAL_TURN_LIMIT;
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TURN_TTL_MS;
    if (!Number.isSafeInteger(this.terminalLimit) || this.terminalLimit <= 0) {
      throw new Error("ACP conversation terminal turn limit must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.terminalTtlMs) || this.terminalTtlMs <= 0) {
      throw new Error("ACP conversation terminal turn TTL must be a positive integer.");
    }
  }

  private providerFor(mode: ResolvedAcpProfile["connection"]["mode"]): AcpConnectionProvider {
    if (this.injectedProvider) return this.injectedProvider;
    if (mode === "shared-project") {
      this.sharedProvider ??= createAcpConnectionProvider({
        mode,
        ...(this.connect ? { connect: this.connect } : {})
      });
      return this.sharedProvider;
    }
    this.dedicatedProvider ??= createAcpConnectionProvider({
      mode,
      ...(this.connect ? { connect: this.connect } : {})
    });
    return this.dedicatedProvider;
  }

  isInFlight(key: string): boolean {
    return this.active.has(key);
  }

  admission(key: string): AcpConversationTurnAdmission {
    if (this.active.has(key)) {
      return {
        available: false,
        inFlight: true,
        reason: "An ACP conversation turn is already in progress."
      };
    }
    if (this.pendingCleanup.has(key)) {
      return {
        available: false,
        inFlight: false,
        reason:
          "ACP conversation cleanup has not been confirmed. This run cannot accept another turn."
      };
    }
    if (this.pendingWrites.has(key)) {
      return {
        available: false,
        inFlight: false,
        reason:
          "ACP conversation persistence is still pending. This run cannot accept another turn yet."
      };
    }
    if (this.finalizing.has(key)) {
      return {
        available: false,
        inFlight: false,
        reason: "The ACP conversation turn is finalizing. Please wait before sending another turn."
      };
    }
    return { available: true, inFlight: false, reason: null };
  }

  subscriberCount(key: string): number {
    return this.subscribers.get(key)?.size ?? 0;
  }

  terminalCount(): number {
    this.pruneTerminalTurns();
    return this.terminal.size;
  }

  current(key: string, identity: StableConversationTurnIdentity): AcpConversationTurnQueryResult {
    const active = this.active.get(key);
    return acpConversationTurnQueryResultSchema.parse(
      active && sameStableIdentity(active.input.identity, identity)
        ? { found: true, state: stateOf(active) }
        : active
          ? { found: false, reason: "identity_mismatch" }
          : { found: false, reason: "not_found" }
    );
  }

  query(key: string, identity: AcpConversationTurnIdentity): AcpConversationTurnQueryResult {
    this.pruneTerminalTurns();
    const active = this.active.get(key);
    if (active) {
      return acpConversationTurnQueryResultSchema.parse(
        sameIdentity(active.input.identity, identity)
          ? { found: true, state: stateOf(active) }
          : { found: false, reason: "identity_mismatch" }
      );
    }
    const terminal = this.terminal.get(key)?.state;
    return acpConversationTurnQueryResultSchema.parse(
      terminal && sameIdentity(terminal.identity, identity)
        ? { found: true, state: terminal }
        : { found: false, reason: "not_found" }
    );
  }

  async cancel(
    key: string,
    identity: AcpConversationTurnIdentity
  ): Promise<AcpConversationTurnCancelResult> {
    this.pruneTerminalTurns();
    const turn = this.active.get(key);
    if (!turn) {
      const terminal = this.terminal.get(key)?.state;
      return acpConversationTurnCancelResultSchema.parse(
        terminal && sameIdentity(terminal.identity, identity)
          ? { outcome: "already_terminal", state: terminal }
          : { outcome: "not_found", state: null }
      );
    }
    if (!sameIdentity(turn.input.identity, identity)) {
      return acpConversationTurnCancelResultSchema.parse({
        outcome: "identity_mismatch",
        state: stateOf(turn)
      });
    }
    if (turn.cancellationRequested) {
      await turn.cancelPromise;
      return acpConversationTurnCancelResultSchema.parse({
        outcome: "already_cancelling",
        state: stateOf(turn)
      });
    }
    if (turn.phase === "cleaning") {
      return acpConversationTurnCancelResultSchema.parse({
        outcome: "not_cancellable",
        state: stateOf(turn)
      });
    }
    turn.cancellationRequested = true;
    const cleanupDeadline = createAcpCleanupDeadline(turn.input.profile.shutdown.cleanupDeadlineMs);
    turn.cleanupDeadline = cleanupDeadline;
    turn.phase = "cancelling";
    turn.cancelPromise = this.dispatchCancellation(turn, cleanupDeadline);
    this.notify(turn);
    await turn.cancelPromise;
    return acpConversationTurnCancelResultSchema.parse({
      outcome: "cancel_requested",
      state: stateOf(turn)
    });
  }

  subscribe(key: string, subscriber: TurnStateSubscriber): () => void {
    const subscribers = this.subscribers.get(key) ?? new Set<TurnStateSubscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(key, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.subscribers.delete(key);
    };
  }

  async send(input: AcpConversationTurnInput): Promise<AcpConversationTurnState> {
    const admission = this.admission(input.key);
    if (!admission.available) {
      throw new Error(
        `An ACP conversation turn is already in progress for this run record. ${admission.reason}`
      );
    }
    this.settledNotifications.get(input.key)?.notifications.abort();
    const turn: ActiveConversationTurn = {
      input,
      controller: new AbortController(),
      phase: "starting",
      lease: null,
      session: null,
      sessionLoaded: false,
      cancellationRequested: false,
      cancelPromise: null,
      cancellationDiagnostic: null,
      cleanupFailed: false,
      notifications: new AbortController(),
      persistenceErrors: [],
      pendingPersistence: new Set(),
      pendingNotifications: new Map()
    };
    this.active.set(input.key, turn);
    this.terminal.delete(input.key);
    let terminal: AcpConversationTurnState["terminal"] = "failed";
    let executionError: unknown;
    try {
      this.notify(turn);
      await this.execute(turn);
      terminal = "succeeded";
    } catch (error) {
      if (turn.cleanupFailed || error instanceof AcpSharedConnectionCleanupError) {
        executionError = error;
      } else if (error instanceof AcpConversationTurnCancelledError) {
        terminal = "cancelled";
      } else {
        executionError = error;
      }
    }
    const cleanup = new AcpCleanupSequencer(
      turn.finalizationDeadline ??
        turn.cleanupDeadline ??
        createAcpCleanupDeadline(input.profile.shutdown.cleanupDeadlineMs)
    );
    const saveTerminal = () => {
      const state = stateOf(turn, terminal);
      this.terminal.set(input.key, { state, expiresAt: Date.now() + this.terminalTtlMs });
      this.pruneTerminalTurns();
      return state;
    };
    const terminalState = saveTerminal();
    this.finalizing.add(input.key);
    this.active.delete(input.key);
    try {
      if (cleanup.deadline.remainingMs() > 0) this.notify(turn);
      await this.finishNotifications(turn, cleanup);
    } finally {
      turn.notifications.abort();
      this.finalizing.delete(input.key);
      this.notifySettled(turn);
    }
    if (executionError !== undefined) throw executionError;
    return terminalState;
  }

  private async dispatchCancellation(
    turn: ActiveConversationTurn,
    deadline: AcpCleanupDeadline
  ): Promise<void> {
    if (turn.sessionLoaded && turn.session) {
      const dispatchMs = Math.min(500, turn.input.profile.shutdown.cleanupDeadlineMs);
      try {
        const session = turn.session;
        await new AcpCleanupSequencer(deadline).run(
          "continuation cancellation",
          (timeoutMs) => session.cancel({ timeoutMs, cleanupDeadline: deadline }),
          dispatchMs
        );
      } catch (error) {
        turn.cancellationDiagnostic = `ACP continuation cancel notification failed: ${diagnostic(error)}`;
      }
    }
    turn.controller.abort(new AcpConversationTurnCancelledError());
  }

  private async execute(turn: ActiveConversationTurn): Promise<void> {
    const { input } = turn;
    const signal = turn.controller.signal;
    const eventStore =
      typeof input.eventStore === "function"
        ? await waitWithSignal(input.eventStore(signal), signal)
        : input.eventStore;
    let persistNotifications = false;
    let protocolObserverError: unknown;
    const correlation = acpCorrelationSchema.parse({ sessionId: input.identity.sessionId });
    const append = async (body: NormalizedRunnerEvent["body"]): Promise<void> => {
      await waitWithSignal(
        this.trackPersistence(turn, () => eventStore.append(body, correlation)),
        signal
      );
      signal.throwIfAborted();
      this.notify(turn);
    };
    signal.throwIfAborted();
    const preparedLaunch = await waitWithSignal(
      prepareExecutionHostInvocation({
        host: input.profile.host,
        command: input.profile.launch.command,
        args: input.profile.launch.args,
        cwd: input.cwd,
        env: input.environment.env
      }),
      signal
    );
    signal.throwIfAborted();
    const normalizeSessionNotification = createAcpSessionNotificationNormalizer(
      input.profile.agentId
    );
    const sessionHandlers: AcpSessionHandlerPort = {
      onSessionUpdate: async (notification: SessionNotification) => {
        if (!persistNotifications || notification.sessionId !== input.identity.sessionId) return;
        const normalized = normalizeSessionNotification(notification);
        if (normalized) await append(normalized);
      },
      onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
      onElicitationRequest: async () => ({ action: "cancel" })
    };
    const lease = await this.providerFor(input.profile.connection.mode).acquire({
      signal,
      get cleanupDeadline() {
        return turn.cleanupDeadline;
      },
      launch: { trusted: true, command: preparedLaunch.command, args: preparedLaunch.args },
      cwd: input.cwd,
      spawnCwd: preparedLaunch.spawnCwd ?? null,
      env: preparedLaunch.spawnEnvironment,
      decorateProcessTree: preparedLaunch.decorateProcessTree,
      ...(preparedLaunch.cleanupExitedProcessTree
        ? { cleanupExitedProcessTree: preparedLaunch.cleanupExitedProcessTree }
        : {}),
      clientInfo: { name: "planweave", version: "1" },
      shutdown: input.profile.shutdown,
      ...sessionHandlers,
      observer: {
        redact: redactAcpProtocolPayload,
        observe: (observation) => {
          if (!persistNotifications) return;
          void this.trackPersistence(turn, () =>
            eventStore.appendProtocol(observation.direction, observation.payload)
          ).catch((error) => {
            protocolObserverError ??= error;
          });
        }
      },
      defaultTimeoutMs: input.timeoutMs,
      poolIdentity: {
        projectRoot: input.identity.ref.projectRoot,
        profileFingerprint: input.profile.fingerprint,
        host: input.profile.host
      }
    });
    turn.lease = lease;
    let executionError: unknown;
    const secondaryErrors: unknown[] = [];
    const operationOptions = {
      signal,
      get cleanupDeadline() {
        return turn.cleanupDeadline;
      }
    };
    try {
      turn.phase = "initializing";
      signal.throwIfAborted();
      this.notify(turn);
      const initialized = await lease.initialize(operationOptions);
      gateAcpCapabilities(input.profile.capabilities, initialized, {
        sessionStart: "load",
        connectionMode: input.profile.connection.mode
      });
      turn.phase = "authenticating";
      signal.throwIfAborted();
      this.notify(turn);
      const authenticationOutcome = await coordinateAcpAuthentication({
        connection: lease,
        initialized,
        hints: input.authenticationHints,
        availableEnvironmentVariables: new Set(input.environment.availableNames),
        operationOptions
      });
      if (
        authenticationOutcome.kind === "auth_required" &&
        !mayProbeSessionDespiteAuthRequired(authenticationOutcome)
      ) {
        throw new AcpAuthenticationRequiredError(authenticationOutcome);
      }
      turn.phase = "loading";
      signal.throwIfAborted();
      this.notify(turn);
      try {
        turn.session = await lease.openSession(
          { kind: "load", sessionId: input.identity.sessionId },
          {
            ...operationOptions,
            get cleanupDeadline() {
              return operationOptions.cleanupDeadline;
            },
            cwd: preparedLaunch.sessionCwd,
            ownerId: input.key,
            handlers: sessionHandlers
          }
        );
      } catch (error) {
        if (
          authenticationOutcome.kind === "auth_required" &&
          mayProbeSessionDespiteAuthRequired(authenticationOutcome)
        ) {
          throw new AcpAuthenticationRequiredError(authenticationOutcome);
        }
        throw error;
      }
      const session = turn.session;
      if (!session) throw new Error("ACP conversation turn opened a session without binding it.");
      turn.sessionLoaded = true;
      persistNotifications = true;
      const userContent = normalizedRedactedContent(input.text);
      await append({
        kind: "message",
        role: "user",
        messageId: `desktop-turn-${randomUUID()}`,
        chunk: false,
        ...userContent
      });
      turn.phase = "prompting";
      signal.throwIfAborted();
      this.notify(turn);
      const response = await session.prompt([{ type: "text", text: input.text }], operationOptions);
      if (response.stopReason === "cancelled") {
        if (turn.cancellationRequested) throw new AcpConversationTurnCancelledError();
        throw new Error("ACP agent cancelled the conversation turn.");
      }
      await waitWithSignal(
        this.trackPersistence(turn, () => eventStore.drain()),
        signal
      );
      if (protocolObserverError !== undefined) throw protocolObserverError;
    } catch (error) {
      executionError =
        error instanceof AcpConversationTurnCancelledError
          ? error
          : new Error(`ACP conversation turn failed: ${diagnostic(error)}`, { cause: error });
    } finally {
      persistNotifications = false;
      turn.phase = "cleaning";
      turn.finalizationDeadline =
        turn.cleanupDeadline ?? createAcpCleanupDeadline(input.profile.shutdown.cleanupDeadlineMs);
      const cleanup = new AcpCleanupSequencer(turn.finalizationDeadline);
      const release = lease.release({
        terminal:
          executionError === undefined
            ? "succeeded"
            : executionError instanceof AcpConversationTurnCancelledError
              ? "cancelled"
              : "failed",
        cleanupDeadline: cleanup.deadline
      });
      const released = release.then((result) => {
        if (result.failures.length > 0) {
          throw combineTurnErrors(undefined, result.failures);
        }
        this.pendingCleanup.delete(input.key);
        this.notifySettled(turn);
      });
      this.pendingCleanup.set(input.key, released);
      void released.catch((error) => {
        if (!secondaryErrors.includes(error)) secondaryErrors.push(error);
      });
      const disposal = (async () => {
        try {
          await cleanup.run("continuation lease release", () => released);
        } catch (error) {
          turn.cleanupFailed = true;
          secondaryErrors.push(error);
        }
      })();
      const observations = (async () => {
        this.notify(turn);
        const tasks: Promise<void>[] = [];
        if (executionError !== undefined) {
          tasks.push(
            cleanup.run("continuation diagnostic persistence", async () => {
              await this.trackPersistence(turn, () =>
                eventStore.append(
                  {
                    kind: "diagnostic",
                    code: "protocol_error",
                    message:
                      executionError instanceof AcpConversationTurnCancelledError
                        ? [diagnostic(executionError), turn.cancellationDiagnostic]
                            .filter(Boolean)
                            .join(" ")
                        : diagnostic(executionError)
                  },
                  correlation
                )
              );
              if (cleanup.deadline.remainingMs() <= 0) return;
              await this.trackPersistence(turn, () => eventStore.drain());
            })
          );
        }
        tasks.push(
          cleanup.run("continuation persistence", async () => {
            while (turn.pendingPersistence.size > 0) {
              await Promise.allSettled([...turn.pendingPersistence]);
            }
          })
        );
        const results = await Promise.allSettled(tasks);
        for (const result of results) {
          if (result.status === "rejected") secondaryErrors.push(result.reason);
        }
      })();
      await Promise.all([disposal, observations]);
      if (turn.cleanupFailed && cleanup.deadline.remainingMs() > 0) {
        try {
          await cleanup.run("continuation cleanup diagnostic", async () => {
            await this.trackPersistence(turn, () =>
              eventStore.append(
                {
                  kind: "diagnostic",
                  code: "protocol_error",
                  message: `ACP conversation turn cleanup failed: ${diagnostic(secondaryErrors[0])}`
                },
                correlation
              )
            );
            if (cleanup.deadline.remainingMs() > 0) {
              await this.trackPersistence(turn, () => eventStore.drain());
            }
          });
        } catch (error) {
          secondaryErrors.push(error);
        }
      }
      if (protocolObserverError !== undefined) secondaryErrors.push(protocolObserverError);
    }
    const errors = [...new Set([...secondaryErrors, ...turn.persistenceErrors])];
    turn.persistenceErrors.length = 0;
    if (errors.length > 0) throw combineTurnErrors(executionError, errors);
    if (executionError !== undefined) throw executionError;
  }

  private trackPersistence(
    turn: ActiveConversationTurn,
    operation: () => Promise<void>
  ): Promise<void> {
    const pending = Promise.resolve().then(operation);
    turn.pendingPersistence.add(pending);
    const writes = this.pendingWrites.get(turn.input.key) ?? new Set<Promise<void>>();
    writes.add(pending);
    this.pendingWrites.set(turn.input.key, writes);
    const settled = () => {
      turn.pendingPersistence.delete(pending);
      writes.delete(pending);
      if (writes.size === 0) this.pendingWrites.delete(turn.input.key);
      this.notifySettled(turn);
    };
    void pending.then(settled, (error) => {
      turn.persistenceErrors.push(error);
      settled();
    });
    return pending;
  }

  private notifySettled(turn: ActiveConversationTurn): void {
    const key = turn.input.key;
    if (this.active.has(key) || this.finalizing.has(key)) return;
    const terminal = this.terminal.get(key);
    if (terminal && !sameIdentity(terminal.state.identity, turn.input.identity)) return;
    this.settledNotifications.get(key)?.notifications.abort();
    const scope: TurnNotificationScope = {
      input: turn.input,
      notifications: new AbortController(),
      pendingNotifications: new Map()
    };
    this.settledNotifications.set(key, scope);
    this.notify(scope);
    void this.finishNotifications(
      scope,
      new AcpCleanupSequencer(
        createAcpCleanupDeadline(turn.input.profile.shutdown.cleanupDeadlineMs)
      )
    ).finally(() => {
      scope.notifications.abort();
      if (this.settledNotifications.get(key) === scope) this.settledNotifications.delete(key);
    });
  }

  private notify(turn: TurnNotificationScope): void {
    for (const subscriber of [...(this.subscribers.get(turn.input.key) ?? [])]) {
      const existing = turn.pendingNotifications.get(subscriber);
      if (existing) {
        existing.dirty = true;
        continue;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([turn.notifications.signal, controller.signal]);
      let finish = (): void => undefined;
      const promise = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const job: PendingTurnNotification = {
        dirty: true,
        promise,
        fail: (error) => {
          const subscribers = this.subscribers.get(turn.input.key);
          subscribers?.delete(subscriber);
          if (subscribers?.size === 0) this.subscribers.delete(turn.input.key);
          controller.abort(
            createAcpEventSubscriptionCloseResult(
              "subscriber_callback_failed",
              0,
              `ACP conversation subscriber failed: ${diagnostic(error)}`
            )
          );
        }
      };
      turn.pendingNotifications.set(subscriber, job);
      void (async () => {
        try {
          while (job.dirty && !signal.aborted) {
            job.dirty = false;
            await waitWithSignal(
              Promise.resolve(subscriber({ identity: turn.input.identity, signal })),
              signal
            );
          }
        } catch (error) {
          if (!signal.aborted) job.fail(error);
        } finally {
          controller.abort();
          turn.pendingNotifications.delete(subscriber);
          finish();
        }
      })();
    }
  }

  private async finishNotifications(
    turn: TurnNotificationScope,
    cleanup: AcpCleanupSequencer
  ): Promise<void> {
    try {
      await cleanup.run("continuation notification", async () => {
        while (turn.pendingNotifications.size > 0) {
          await Promise.all([...turn.pendingNotifications.values()].map((job) => job.promise));
        }
      });
    } catch (error) {
      const pending = [...turn.pendingNotifications.values()];
      for (const job of pending) job.fail(error);
      await Promise.all(pending.map((job) => job.promise));
    }
  }

  private pruneTerminalTurns(): void {
    const now = Date.now();
    for (const [key, terminal] of this.terminal) {
      if (terminal.expiresAt <= now) this.terminal.delete(key);
    }
    while (this.terminal.size > this.terminalLimit) {
      const oldest = this.terminal.keys().next().value;
      if (oldest === undefined) break;
      this.terminal.delete(oldest);
    }
  }
}

export const acpConversationTurns = new AcpConversationTurnCoordinator();
