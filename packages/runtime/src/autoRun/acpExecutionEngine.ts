import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  type AgentCapabilities,
  type InitializeResponse,
  type PromptResponse,
  type SessionNotification
} from "@agentclientprotocol/sdk";
import {
  AcpAuthenticationRequiredError,
  coordinateAcpAuthentication,
  mayProbeSessionDespiteAuthRequired,
  type AcpAuthenticationOutcome
} from "./acpAuthentication.js";
import {
  AcpInboundMessageLimitError,
  AcpOperationTimeoutError,
  AcpProcessError,
  AcpProtocolError,
  AcpStderrLimitError
} from "./acpConnection.js";
import type { AcpConnectionLease, AcpOwnedSession } from "./acpConnectionProvider.js";
import { createAcpConnectionProvider } from "./acpConnectionProviderFactory.js";
import {
  AcpSharedConnectionAuthRequiredError,
  AcpSharedConnectionLostError
} from "./acpSharedConnectionErrors.js";
import { normalizeAcpSessionNotification } from "./acpEventNormalization.js";
import { normalizedRedactedContent } from "./normalizedEventContract.js";
import { AcpCleanupSequencer, createAcpCleanupDeadline } from "./acpExecutionCleanup.js";
import { assistantTextChunk } from "./acpExecutionOutput.js";
import { acpShutdownPolicySchema } from "../acpProfile/schema.js";
import {
  AcpRequiredCapabilityError,
  gateAcpCapabilities,
  type AcpCapabilitySnapshot
} from "./acpCapabilityGate.js";
import {
  AcpEngineInteractionError,
  createAcpExecutionInteractionHandlers
} from "./acpExecutionInteractions.js";
import {
  DEFAULT_ACP_EXECUTION_LIMITS,
  acpEngineSessionStartSchema,
  acpExecutionLimitsSchema,
  type AcpEngineCapabilities,
  type AcpEngineClock,
  type AcpEngineEvent,
  type AcpEngineEventPayload,
  type AcpEngineFailureReason,
  type AcpEngineResult,
  type AcpEngineTerminal,
  type AcpEngineUsage,
  type AcpEngineLifecycleEvent,
  type ExecuteAcpOptions
} from "./acpExecutionEngineContracts.js";

export class AcpEngineLimitError extends Error {
  constructor(
    readonly boundary: "prompt" | "event" | "output",
    readonly maxBytes: number
  ) {
    super(`ACP ${boundary} exceeded the ${maxBytes}-byte limit.`);
    this.name = "AcpEngineLimitError";
  }
}

export { AcpEngineInteractionError } from "./acpExecutionInteractions.js";

export class AcpEngineCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpEngineCapabilityError";
  }
}

export class AcpEngineExecutionError extends Error {
  constructor(
    readonly result: AcpEngineResult,
    readonly executionCause: unknown
  ) {
    super(
      result.terminal.state === "succeeded"
        ? "ACP execution unexpectedly reported success as an error."
        : result.terminal.message,
      executionCause === undefined ? undefined : { cause: executionCause }
    );
    this.name = "AcpEngineExecutionError";
  }
}

const systemClock: AcpEngineClock = {
  now: () => new Date(),
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const finish = (): void => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      const abort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    })
};

function normalizeCapabilities(
  initialized: InitializeResponse,
  hasBroker: boolean
): AcpEngineCapabilities {
  const capabilities = initialized.agentCapabilities;
  return {
    loadSession: capabilities?.loadSession === true,
    closeSession: capabilities?.sessionCapabilities?.close != null,
    prompt: {
      image: capabilities?.promptCapabilities?.image === true,
      audio: capabilities?.promptCapabilities?.audio === true,
      embeddedContext: capabilities?.promptCapabilities?.embeddedContext === true
    },
    mcp: {
      http: capabilities?.mcpCapabilities?.http === true,
      sse: capabilities?.mcpCapabilities?.sse === true
    },
    client: { permission: true, elicitation: hasBroker }
  };
}

function diagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    return normalizedRedactedContent(raw).content;
  } catch {
    return "ACP diagnostic was unavailable because it could not be safely normalized.";
  }
}

function failureReason(error: unknown): AcpEngineFailureReason {
  if (error instanceof AcpAuthenticationRequiredError) return "authentication_required";
  if (error instanceof AcpSharedConnectionAuthRequiredError) return "authentication_required";
  if (error instanceof AcpSharedConnectionLostError) return "process_error";
  if (
    error instanceof AcpEngineLimitError ||
    error instanceof AcpInboundMessageLimitError ||
    error instanceof AcpStderrLimitError
  ) {
    return "limit_exceeded";
  }
  if (error instanceof AcpEngineInteractionError) {
    return error.timedOut ? "interaction_timeout" : "interaction_failed";
  }
  if (error instanceof AcpEngineCapabilityError) return "capability_missing";
  if (error instanceof AcpRequiredCapabilityError) return "capability_missing";
  if (error instanceof AcpOperationTimeoutError) return "operation_timeout";
  if (error instanceof AcpProtocolError) return "protocol_error";
  if (error instanceof AcpProcessError) return "process_error";
  if (error instanceof Error && error.message === "ACP connection closed") {
    return "process_error";
  }
  return "unknown_error";
}

async function executeAcpOutcome(
  options: ExecuteAcpOptions
): Promise<{ result: AcpEngineResult; cause: unknown }> {
  if (!isAbsolute(options.workspace.cwd)) throw new Error("ACP workspace cwd must be absolute.");
  const sessionStart = acpEngineSessionStartSchema.parse(options.sessionStart);
  const shutdown = acpShutdownPolicySchema.parse(options.shutdown);
  const limits = acpExecutionLimitsSchema.parse({
    ...DEFAULT_ACP_EXECUTION_LIMITS,
    ...options.limits
  });
  if (Buffer.byteLength(options.prompt, "utf8") > limits.promptMaxBytes) {
    throw new AcpEngineLimitError("prompt", limits.promptMaxBytes);
  }

  const clock = options.clock ?? systemClock;
  const abortController = new AbortController();
  const relayAbort = (): void => abortController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  if (options.signal?.aborted) relayAbort();
  let lease: AcpConnectionLease | null = null;
  let ownedSession: AcpOwnedSession | null = null;
  let sessionId: string | null = null;
  let capabilities: AcpEngineCapabilities | null = null;
  let capabilitySnapshot: AcpCapabilitySnapshot | null = null;
  let initializedCapabilities: AgentCapabilities | undefined;
  let authentication: AcpAuthenticationOutcome | null = null;
  let output = "";
  let outputBytes = 0;
  let usage: AcpEngineUsage | null = null;
  let sequence = 0;
  let cleanupAttempted = false;
  let cleanupCompleted = false;
  let terminal: AcpEngineTerminal | null = null;
  let sinkFailure: unknown;
  let sessionUpdateFailure: unknown;
  let executionCause: unknown;
  let sessionIdentityPublished = false;
  let pendingSessionUpdates: SessionNotification[] = [];
  let pendingSessionUpdateBytes = 0;
  let sessionUpdateDrain: Promise<void> = Promise.resolve();

  const observeLifecycle = async (event: AcpEngineLifecycleEvent): Promise<void> => {
    await options.lifecycleObserver?.(event);
  };

  const emit = async (event: AcpEngineEventPayload): Promise<void> => {
    const complete = {
      ...event,
      sequence: ++sequence,
      timestamp: clock.now().toISOString()
    } as AcpEngineEvent;
    if (Buffer.byteLength(JSON.stringify(complete), "utf8") > limits.eventMaxBytes) {
      throw new AcpEngineLimitError("event", limits.eventMaxBytes);
    }
    try {
      await options.eventSink?.(complete);
    } catch (error) {
      sinkFailure = error;
      throw error;
    }
  };

  const relaySessionUpdate = async (notification: SessionNotification): Promise<void> => {
    if (sessionUpdateFailure === undefined) {
      const normalized = normalizeAcpSessionNotification(notification);
      if (!normalized) return;
      const outputChunk = assistantTextChunk(notification);
      if (outputChunk !== null) {
        const nextBytes = outputBytes + Buffer.byteLength(outputChunk, "utf8");
        if (nextBytes > limits.outputMaxBytes) {
          throw new AcpEngineLimitError("output", limits.outputMaxBytes);
        }
        output += outputChunk;
        outputBytes = nextBytes;
      }
      await emit({ kind: "session_update", sessionId: notification.sessionId, body: normalized });
    }
  };

  const queueSessionUpdate = (notification: SessionNotification): Promise<void> => {
    sessionUpdateDrain = sessionUpdateDrain.then(async () => {
      if (sessionUpdateFailure !== undefined) return;
      try {
        await relaySessionUpdate(notification);
      } catch (error) {
        sessionUpdateFailure ??= error;
      }
    });
    return sessionUpdateDrain;
  };

  const onSessionUpdate = (notification: SessionNotification): Promise<void> => {
    if (!sessionIdentityPublished) {
      const notificationBytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
      const nextBytes = pendingSessionUpdateBytes + notificationBytes;
      if (nextBytes > limits.outputMaxBytes) {
        sessionUpdateFailure ??= new AcpEngineLimitError("output", limits.outputMaxBytes);
        return Promise.resolve();
      }
      pendingSessionUpdates.push(notification);
      pendingSessionUpdateBytes = nextBytes;
      return Promise.resolve();
    }
    return queueSessionUpdate(notification);
  };

  const interactionHandlers = createAcpExecutionInteractionHandlers({
    broker: options.interactionBroker,
    deadline: options.interactionDeadline,
    clock,
    timeoutMs: limits.interactionTimeoutMs,
    signal: abortController.signal,
    emit
  });

  try {
    await emit({ kind: "lifecycle", state: "connecting" });
    const connectionMode = options.connectionMode ?? "dedicated";
    const provider =
      options.provider ??
      createAcpConnectionProvider({
        mode: connectionMode,
        ...(options.connect ? { connect: options.connect } : {})
      });
    const sessionOwnerId = randomUUID();
    const sessionHandlers = {
      onSessionUpdate,
      onPermissionRequest: interactionHandlers.onPermissionRequest,
      onElicitationRequest: interactionHandlers.onElicitationRequest
    };
    try {
      lease = await provider.acquire({
        launch: options.launch,
        cwd: options.workspace.cwd,
        env: options.env,
        clientInfo: options.clientInfo,
        shutdown,
        ...(options.interactionBroker?.advertiseElicitation !== false && options.interactionBroker
          ? { clientCapabilities: { elicitation: { form: {} } } }
          : {}),
        defaultTimeoutMs: limits.operationTimeoutMs,
        maxStderrBytes: limits.stderrMaxBytes,
        maxInboundMessageBytes: limits.inboundMessageMaxBytes,
        ...sessionHandlers,
        ...(options.poolIdentity ? { poolIdentity: options.poolIdentity } : {})
      });
    } catch (error) {
      if (error instanceof AcpSharedConnectionAuthRequiredError) {
        throw new AcpAuthenticationRequiredError(error.outcome);
      }
      throw error;
    }
    await observeLifecycle({ kind: "connection_ready", processId: lease.processId });
    const initialized = await lease.initialize({
      signal: abortController.signal,
      timeoutMs: limits.operationTimeoutMs
    });
    initializedCapabilities = initialized.agentCapabilities;
    await observeLifecycle({
      kind: "initialized",
      agentCapabilities: initialized.agentCapabilities
    });
    try {
      capabilitySnapshot = gateAcpCapabilities(options.capabilityPolicy, initialized, {
        sessionStart: sessionStart.kind,
        connectionMode
      });
    } catch (error) {
      if (error instanceof AcpRequiredCapabilityError) {
        capabilitySnapshot = error.snapshot;
        await observeLifecycle({ kind: "capability_gated", snapshot: error.snapshot });
        await emit({ kind: "capability_snapshot", snapshot: error.snapshot });
      }
      throw error;
    }
    await observeLifecycle({ kind: "capability_gated", snapshot: capabilitySnapshot });
    await emit({ kind: "capability_snapshot", snapshot: capabilitySnapshot });
    capabilities = normalizeCapabilities(
      initialized,
      options.interactionBroker !== undefined &&
        options.interactionBroker.advertiseElicitation !== false
    );
    await emit({ kind: "capabilities", capabilities });
    authentication = await coordinateAcpAuthentication({
      connection: lease,
      initialized,
      hints: options.authentication?.hints,
      availableEnvironmentVariables:
        options.authentication?.availableEnvironmentVariables ?? new Set(Object.keys(options.env)),
      operationOptions: {
        signal: abortController.signal,
        timeoutMs: limits.operationTimeoutMs
      }
    });
    await observeLifecycle({ kind: "authentication_completed", authentication });
    const openSession = async (): Promise<AcpOwnedSession> => {
      if (!lease) throw new Error("ACP connection closed before opening a session.");
      if (sessionStart.kind === "load" && initializedCapabilities?.loadSession !== true) {
        throw new AcpEngineCapabilityError(
          options.sessionLoadUnsupportedMessage ??
            "ACP agent does not advertise session/load capability."
        );
      }
      return lease.openSession(sessionStart, {
        signal: abortController.signal,
        timeoutMs: limits.operationTimeoutMs,
        ownerId: sessionOwnerId,
        handlers: sessionHandlers
      });
    };
    if (authentication.kind === "auth_required") {
      if (
        options.authentication?.requiredPolicy !== "probe_session" ||
        !mayProbeSessionDespiteAuthRequired(authentication)
      ) {
        throw new AcpAuthenticationRequiredError(authentication);
      }
      await observeLifecycle({ kind: "authentication_probe", state: "starting" });
      try {
        ownedSession = await openSession();
      } catch {
        await observeLifecycle({ kind: "authentication_probe", state: "failed" });
        throw new AcpAuthenticationRequiredError(authentication);
      }
      await observeLifecycle({ kind: "authentication_probe", state: "succeeded" });
    } else {
      ownedSession = await openSession();
    }
    sessionId = ownedSession.sessionId;
    const boundSession = ownedSession;
    await observeLifecycle({
      kind: "session_ready",
      loaded: sessionStart.kind === "load",
      session: boundSession.created,
      configurator: {
        setMode: async (modeId) => {
          await boundSession.setMode(modeId, {
            signal: abortController.signal,
            timeoutMs: limits.operationTimeoutMs
          });
        },
        setConfigOption: async ({ configId, value }) => {
          const response = await boundSession.setConfigOption(
            { configId, value },
            { signal: abortController.signal, timeoutMs: limits.operationTimeoutMs }
          );
          return response.configOptions;
        }
      }
    });
    await emit({ kind: "session_started", sessionId, loaded: sessionStart.kind === "load" });
    sessionIdentityPublished = true;
    for (const notification of pendingSessionUpdates) {
      void queueSessionUpdate(notification);
    }
    pendingSessionUpdates = [];
    pendingSessionUpdateBytes = 0;
    await sessionUpdateDrain;
    if (sessionUpdateFailure !== undefined) throw sessionUpdateFailure;
    await emit({ kind: "lifecycle", state: "running" });
    let response: PromptResponse | null = null;
    let turn = 0;
    const prompts = (async function* () {
      yield options.prompt;
      if (options.followUpPrompts) yield* options.followUpPrompts;
    })();
    for await (const prompt of prompts) {
      turn += 1;
      const followUp = turn > 1;
      if (Buffer.byteLength(prompt, "utf8") > limits.promptMaxBytes) {
        throw new AcpEngineLimitError("prompt", limits.promptMaxBytes);
      }
      await observeLifecycle({
        kind: "prompt_starting",
        sessionId,
        turn,
        followUp,
        prompt
      });
      response = await boundSession.prompt([{ type: "text", text: prompt }], {
        signal: abortController.signal,
        timeoutMs: limits.operationTimeoutMs
      });
      if (sessionUpdateFailure !== undefined) throw sessionUpdateFailure;
      if (response.usage) {
        usage = {
          totalTokens: response.usage.totalTokens,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          thoughtTokens: response.usage.thoughtTokens ?? null,
          cachedReadTokens: response.usage.cachedReadTokens ?? null,
          cachedWriteTokens: response.usage.cachedWriteTokens ?? null
        };
        await emit({ kind: "usage", usage });
      }
      await observeLifecycle({
        kind: "prompt_completed",
        sessionId,
        turn,
        followUp,
        stopReason: response.stopReason
      });
      if (response.stopReason === "cancelled" || abortController.signal.aborted) break;
    }
    if (!response) throw new Error("ACP prompt source did not produce an initial prompt.");
    await observeLifecycle({ kind: "prompts_completed", sessionId, turns: turn, output });
    terminal =
      response.stopReason === "cancelled" || abortController.signal.aborted
        ? { state: "cancelled", message: "ACP session was cancelled." }
        : response.stopReason === "end_turn"
          ? { state: "succeeded", stopReason: response.stopReason }
          : {
              state: "failed",
              reason: "incomplete_response",
              message: "ACP execution ended without a complete response."
            };
  } catch (error) {
    const executionFailure =
      interactionHandlers.failure ?? sessionUpdateFailure ?? lease?.terminalFailure ?? error;
    executionCause = sinkFailure ?? executionFailure;
    terminal = abortController.signal.aborted
      ? { state: "cancelled", message: diagnostic(abortController.signal.reason) }
      : {
          state: "failed",
          reason: sinkFailure !== undefined ? "event_sink_failed" : failureReason(executionFailure),
          message: diagnostic(sinkFailure ?? executionFailure)
        };
  } finally {
    cleanupAttempted = true;
    const cleanup = new AcpCleanupSequencer(createAcpCleanupDeadline(shutdown.cleanupDeadlineMs));
    let cleanupEventFailure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      await emit({ kind: "lifecycle", state: "cleanup" });
    } catch (error) {
      cleanupEventFailure = error;
    }
    if (terminal === null) {
      terminal = {
        state: "failed",
        reason: "unknown_error",
        message: "ACP execution ended without a terminal result."
      };
    }
    const executionTerminal = terminal;
    try {
      await observeLifecycle({ kind: "cleanup_starting", terminal });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (ownedSession && terminal.state !== "succeeded") {
      const cleanupSession = ownedSession;
      try {
        await cleanup.run(
          "session cancellation",
          (timeoutMs) => cleanupSession.cancel({ timeoutMs, cleanupDeadline: cleanup.deadline }),
          100
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (lease) {
      const cleanupLease = lease;
      try {
        const released = await cleanupLease.release({
          terminal: executionTerminal.state,
          cleanupDeadline: cleanup.deadline
        });
        cleanupFailures.push(...released.failures);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    cleanupCompleted = cleanupFailures.length === 0;
    if (cleanupFailures.length > 0) {
      const failures =
        executionCause === undefined ? cleanupFailures : [executionCause, ...cleanupFailures];
      executionCause =
        failures.length === 1
          ? failures[0]
          : new AggregateError(
              failures,
              executionTerminal.state === "failed"
                ? `${executionTerminal.message}; cleanup: ${cleanupFailures.map(diagnostic).join("; ")}`
                : `ACP execution cleanup failed: ${cleanupFailures.map(diagnostic).join("; ")}`
            );
      // Caller cancellation remains authoritative. Cleanup timeout/disposal faults are
      // reported via cleanup.completed=false without rewriting a cancelled terminal.
      if (executionTerminal.state !== "cancelled") {
        terminal = {
          state: "failed",
          reason:
            executionTerminal.state === "failed" ? executionTerminal.reason : "cleanup_failed",
          message:
            executionTerminal.state === "failed"
              ? `${executionTerminal.message}; cleanup: ${cleanupFailures.map(diagnostic).join("; ")}`
              : cleanupFailures.map(diagnostic).join("; ")
        };
      } else {
        terminal = executionTerminal;
      }
    } else if (cleanupEventFailure !== undefined && executionTerminal.state !== "cancelled") {
      executionCause = cleanupEventFailure;
      terminal = {
        state: "failed",
        reason:
          sinkFailure !== undefined ? "event_sink_failed" : failureReason(cleanupEventFailure),
        message: diagnostic(cleanupEventFailure)
      };
    } else if (cleanupEventFailure !== undefined) {
      executionCause = cleanupEventFailure;
      terminal = executionTerminal;
    }
    try {
      await observeLifecycle({
        kind: "cleanup_completed",
        cleanup: { attempted: true, completed: cleanupCompleted }
      });
    } catch (error) {
      executionCause = error;
      if (terminal?.state !== "cancelled") {
        terminal = {
          state: "failed",
          reason: "unknown_error",
          message: diagnostic(error)
        };
      }
    }
    try {
      await emit({ kind: "terminal", terminal });
    } catch (error) {
      executionCause = error;
      terminal = {
        state: "failed",
        reason: sinkFailure !== undefined ? "event_sink_failed" : failureReason(error),
        message: diagnostic(error)
      };
    }
    options.signal?.removeEventListener("abort", relayAbort);
  }

  return {
    result: {
      sessionId,
      output,
      stderr: lease?.stderr.map(diagnostic) ?? [],
      capabilities,
      capabilitySnapshot,
      authentication,
      usage,
      terminal,
      cleanup: { attempted: cleanupAttempted, completed: cleanupCompleted }
    },
    cause: executionCause
  };
}

export async function executeAcp(options: ExecuteAcpOptions): Promise<AcpEngineResult> {
  return (await executeAcpOutcome(options)).result;
}

export async function executeAcpOrThrow(options: ExecuteAcpOptions): Promise<AcpEngineResult> {
  const outcome = await executeAcpOutcome(options);
  if (outcome.result.terminal.state !== "succeeded") {
    throw new AcpEngineExecutionError(outcome.result, outcome.cause);
  }
  return outcome.result;
}
