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
  AcpOwnedSession
} from "./acpConnectionProvider.js";
import { createDedicatedAcpConnectionProvider } from "./acpDedicatedConnectionProvider.js";
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
  type AcpConversationTurnIdentity,
  type AcpConversationTurnPhase,
  type AcpConversationTurnQueryResult,
  type AcpConversationTurnState
} from "./acpConversationTurnContract.js";
import { normalizeAcpSessionNotification } from "./acpEventNormalization.js";
import { AcpCleanupSequencer, createAcpCleanupDeadline } from "./acpExecutionCleanup.js";
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

type TurnStateSubscriber = () => void | Promise<void>;
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
};
type StableConversationTurnIdentity = Omit<AcpConversationTurnIdentity, "version" | "turnId">;
type TerminalConversationTurn = { state: AcpConversationTurnState; expiresAt: number };

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

export class AcpConversationTurnCoordinator {
  private readonly active = new Map<string, ActiveConversationTurn>();
  private readonly terminal = new Map<string, TerminalConversationTurn>();
  private readonly subscribers = new Map<string, Set<TurnStateSubscriber>>();
  private readonly terminalLimit: number;
  private readonly terminalTtlMs: number;

  private readonly provider: AcpConnectionProvider;

  constructor(
    connect?: ConnectionFactory,
    options: {
      terminalLimit?: number;
      terminalTtlMs?: number;
      provider?: AcpConnectionProvider;
    } = {}
  ) {
    this.provider =
      options.provider ?? createDedicatedAcpConnectionProvider(connect ? { connect } : {});
    this.terminalLimit = options.terminalLimit ?? DEFAULT_TERMINAL_TURN_LIMIT;
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TURN_TTL_MS;
    if (!Number.isSafeInteger(this.terminalLimit) || this.terminalLimit <= 0) {
      throw new Error("ACP conversation terminal turn limit must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.terminalTtlMs) || this.terminalTtlMs <= 0) {
      throw new Error("ACP conversation terminal turn TTL must be a positive integer.");
    }
  }

  isInFlight(key: string): boolean {
    return this.active.has(key);
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
    turn.phase = "cancelling";
    turn.cancelPromise = Promise.resolve().then(() => this.dispatchCancellation(turn));
    await this.notify(key);
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
    if (this.active.has(input.key)) {
      throw new Error("An ACP conversation turn is already in progress for this run record.");
    }
    const turn: ActiveConversationTurn = {
      input,
      controller: new AbortController(),
      phase: "starting",
      lease: null,
      session: null,
      sessionLoaded: false,
      cancellationRequested: false,
      cancelPromise: null,
      cancellationDiagnostic: null
    };
    this.active.set(input.key, turn);
    this.terminal.delete(input.key);
    await this.notify(input.key);
    let terminal: AcpConversationTurnState["terminal"] = "failed";
    let executionError: unknown;
    try {
      await this.execute(turn);
      terminal = "succeeded";
    } catch (error) {
      if (turn.cancellationRequested || error instanceof AcpConversationTurnCancelledError) {
        terminal = "cancelled";
      } else {
        executionError = error;
      }
    } finally {
      const terminalState = stateOf(turn, terminal);
      this.terminal.set(input.key, {
        state: terminalState,
        expiresAt: Date.now() + this.terminalTtlMs
      });
      this.pruneTerminalTurns();
      this.active.delete(input.key);
      await this.notify(input.key);
    }
    if (executionError !== undefined) throw executionError;
    return this.terminal.get(input.key)!.state;
  }

  private async dispatchCancellation(turn: ActiveConversationTurn): Promise<void> {
    if (turn.sessionLoaded && turn.session) {
      const dispatchMs = Math.min(500, turn.input.profile.shutdown.cleanupDeadlineMs);
      try {
        await turn.session.cancel({ timeoutMs: dispatchMs });
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
      await eventStore.append(body, correlation);
      await this.notify(input.key);
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
    const lease = await this.provider.acquire({
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
      onSessionUpdate: async (notification: SessionNotification) => {
        if (!persistNotifications || notification.sessionId !== input.identity.sessionId) return;
        const normalized = normalizeAcpSessionNotification(notification);
        if (normalized) await append(normalized);
      },
      onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
      onElicitationRequest: async () => ({ action: "cancel" }),
      observer: {
        redact: redactAcpProtocolPayload,
        observe: (observation) => {
          if (!persistNotifications) return;
          void eventStore
            .appendProtocol(observation.direction, observation.payload)
            .catch((error) => {
              protocolObserverError ??= error;
            });
        }
      },
      defaultTimeoutMs: input.timeoutMs
    });
    turn.lease = lease;
    let executionError: unknown;
    const secondaryErrors: unknown[] = [];
    const operationOptions = { signal };
    try {
      turn.phase = "initializing";
      await this.notify(input.key);
      const initialized = await lease.initialize(operationOptions);
      gateAcpCapabilities(input.profile.capabilities, initialized, {
        sessionStart: "load",
        connectionMode: input.profile.connection.mode
      });
      turn.phase = "authenticating";
      await this.notify(input.key);
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
      await this.notify(input.key);
      try {
        turn.session = await lease.openSession(
          { kind: "load", sessionId: input.identity.sessionId },
          { ...operationOptions, cwd: preparedLaunch.sessionCwd }
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
      await this.notify(input.key);
      const response = await session.prompt([{ type: "text", text: input.text }], operationOptions);
      if (response.stopReason === "cancelled") {
        throw new Error("ACP agent cancelled the conversation turn.");
      }
      await eventStore.drain();
      if (protocolObserverError !== undefined) throw protocolObserverError;
    } catch (error) {
      const cancelled =
        turn.cancellationRequested || error instanceof AcpConversationTurnCancelledError;
      executionError = cancelled
        ? new AcpConversationTurnCancelledError()
        : new Error(`ACP conversation turn failed: ${diagnostic(error)}`, { cause: error });
      try {
        await append({
          kind: "diagnostic",
          code: "protocol_error",
          message: cancelled
            ? [
                "ACP conversation continuation was cancelled by the user.",
                turn.cancellationDiagnostic
              ]
                .filter((value): value is string => value !== null)
                .join(" ")
            : diagnostic(executionError)
        });
        await eventStore.drain();
      } catch (diagnosticError) {
        secondaryErrors.push(diagnosticError);
      }
    } finally {
      turn.phase = "cleaning";
      await this.notify(input.key);
      const cleanup = new AcpCleanupSequencer(
        createAcpCleanupDeadline(input.profile.shutdown.cleanupDeadlineMs)
      );
      try {
        const released = await lease.release({
          terminal:
            executionError === undefined
              ? "succeeded"
              : turn.cancellationRequested ||
                  executionError instanceof AcpConversationTurnCancelledError
                ? "cancelled"
                : "failed",
          cleanupDeadline: cleanup.deadline
        });
        if (released.failures.length > 0) {
          const cleanupError =
            released.failures.length === 1
              ? released.failures[0]
              : new AggregateError(released.failures, "ACP conversation turn cleanup failed.");
          secondaryErrors.push(cleanupError);
          try {
            await append({
              kind: "diagnostic",
              code: "protocol_error",
              message: `ACP conversation turn cleanup failed: ${diagnostic(cleanupError)}`
            });
            await eventStore.drain();
          } catch (diagnosticError) {
            secondaryErrors.push(diagnosticError);
          }
        }
      } catch (cleanupError) {
        secondaryErrors.push(cleanupError);
        try {
          await append({
            kind: "diagnostic",
            code: "protocol_error",
            message: `ACP conversation turn cleanup failed: ${diagnostic(cleanupError)}`
          });
          await eventStore.drain();
        } catch (diagnosticError) {
          secondaryErrors.push(diagnosticError);
        }
      }
    }
    if (executionError !== undefined) {
      if (secondaryErrors.length > 0) {
        throw new AggregateError([executionError, ...secondaryErrors], diagnostic(executionError), {
          cause: executionError
        });
      }
      throw executionError;
    }
    if (secondaryErrors.length > 0) {
      throw secondaryErrors.length === 1
        ? secondaryErrors[0]
        : new AggregateError(secondaryErrors, "ACP conversation turn cleanup failed.");
    }
  }

  private async notify(key: string): Promise<void> {
    const subscribers = [...(this.subscribers.get(key) ?? [])];
    await Promise.allSettled(subscribers.map(async (subscriber) => subscriber()));
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
