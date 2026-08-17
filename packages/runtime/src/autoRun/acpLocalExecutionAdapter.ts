import type {
  AcpEngineEvent,
  AcpEngineInteractionBroker,
  AcpEngineLifecycleObserver
} from "./acpExecutionEngineContracts.js";
import { AcpEngineExecutionError, executeAcpOrThrow } from "./acpExecutionEngine.js";
import {
  DEFAULT_ACP_OPERATION_TIMEOUT_MS,
  type AcpConnection,
  type CreateAcpConnectionOptions
} from "./acpConnection.js";
import {
  type AcpConnectionLease,
  type AcpConnectionProvider,
  type AcpLiveRunTransport,
  type AcpSharedPoolIdentity
} from "./acpConnectionProvider.js";
import { createAcpConnectionProvider } from "./acpConnectionProviderFactory.js";
import { createAcpCleanupDeadline } from "./acpExecutionCleanup.js";
import {
  planWeaveAcpExecutionAuthentication,
  type AcpAuthenticationHints
} from "./acpAuthentication.js";
import type { AcpSessionStart } from "./acpRunRecovery.js";
import type {
  AcpCapabilityPolicy,
  AcpConnectionMode,
  AcpShutdownPolicy
} from "../acpProfile/schema.js";

type PromptDelivery = {
  readonly text: string;
  resolve(): void;
  reject(error: Error): void;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function liveTransportFromLease(lease: AcpConnectionLease): AcpLiveRunTransport {
  return {
    get processId() {
      return lease.processId;
    },
    get pendingOperationCount() {
      return lease.pendingOperationCount;
    },
    get pendingOperations() {
      return lease.pendingOperations;
    },
    cancel: (notification, operationOptions) => lease.cancel(notification, operationOptions)
  };
}

export function createLocalAcpPromptSource(
  drain: (deliver: (text: string) => Promise<void>) => Promise<void>
): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      const queued: PromptDelivery[] = [];
      let wake: (() => void) | null = null;
      let completed = false;
      let failure: Error | null = null;
      const draining = drain(
        (text) =>
          new Promise<void>((resolve, reject) => {
            queued.push({ text, resolve, reject });
            wake?.();
            wake = null;
          })
      ).then(
        () => {
          completed = true;
          wake?.();
          wake = null;
        },
        (error) => {
          failure = asError(error);
          completed = true;
          wake?.();
          wake = null;
        }
      );
      let active: PromptDelivery | null = null;
      try {
        while (true) {
          active = queued.shift() ?? null;
          if (!active) {
            if (completed) break;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          yield active.text;
          active.resolve();
          active = null;
        }
        await draining;
        if (failure) throw failure;
      } catch (error) {
        const rejected = asError(error);
        active?.reject(rejected);
        for (const pending of queued.splice(0)) pending.reject(rejected);
        throw rejected;
      } finally {
        if (active) active.reject(new Error("ACP prompt source closed during delivery."));
      }
    }
  };
}

export async function executeLocalAcpAdapter(options: {
  readonly launch: { readonly command: string; readonly args: readonly string[] };
  readonly cwd: string;
  readonly spawnCwd?: string | null;
  readonly decorateProcessTree?: CreateAcpConnectionOptions["decorateProcessTree"];
  readonly cleanupExitedProcessTree?: CreateAcpConnectionOptions["cleanupExitedProcessTree"];
  readonly agentId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shutdown: AcpShutdownPolicy;
  readonly capabilityPolicy: AcpCapabilityPolicy;
  readonly availableEnvironmentVariables?: ReadonlySet<string>;
  readonly prompt: string;
  readonly sessionStart: AcpSessionStart;
  readonly authenticationHints?: AcpAuthenticationHints;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly connect?: (options: CreateAcpConnectionOptions) => AcpConnection;
  readonly provider?: AcpConnectionProvider;
  readonly connectionMode?: AcpConnectionMode;
  readonly poolIdentity?: AcpSharedPoolIdentity;
  readonly onConnection: (connection: AcpLiveRunTransport) => void;
  readonly connectionExtensions?: Pick<CreateAcpConnectionOptions, "observer" | "onTerminalOutput">;
  readonly interactionBroker: AcpEngineInteractionBroker;
  readonly interactionDeadline: () => Date | null;
  readonly followUpPrompts: AsyncIterable<string>;
  readonly eventSink: (event: AcpEngineEvent) => void | Promise<void>;
  readonly lifecycleObserver: AcpEngineLifecycleObserver;
}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACP_OPERATION_TIMEOUT_MS;
  const connectionMode = options.connectionMode ?? "dedicated";
  const innerProvider =
    options.provider ??
    createAcpConnectionProvider({
      mode: connectionMode,
      ...(options.connect ? { connect: options.connect } : {})
    });
  let registrationCleanup: Promise<void> | null = null;
  const provider: AcpConnectionProvider = {
    async acquire(request) {
      const lease = await innerProvider.acquire({
        ...request,
        ...(options.spawnCwd !== undefined ? { spawnCwd: options.spawnCwd } : {}),
        ...(options.decorateProcessTree
          ? { decorateProcessTree: options.decorateProcessTree }
          : {}),
        ...(options.cleanupExitedProcessTree
          ? { cleanupExitedProcessTree: options.cleanupExitedProcessTree }
          : {}),
        ...options.connectionExtensions
      });
      try {
        options.onConnection(liveTransportFromLease(lease));
      } catch (error) {
        registrationCleanup = lease
          .release({
            terminal: "failed",
            cleanupDeadline: createAcpCleanupDeadline(options.shutdown.cleanupDeadlineMs)
          })
          .then(() => undefined);
        throw error;
      }
      return lease;
    },
    shutdown: () => innerProvider.shutdown()
  };
  try {
    return await executeAcpOrThrow({
      launch: { trusted: true, ...options.launch },
      workspace: { cwd: options.cwd },
      env: options.env,
      clientInfo: { name: "planweave", version: "1" },
      shutdown: options.shutdown,
      capabilityPolicy: options.capabilityPolicy,
      prompt: options.prompt,
      sessionStart:
        options.sessionStart.kind === "load"
          ? { kind: "load", sessionId: options.sessionStart.sessionId }
          : { kind: "new" },
      sessionLoadUnsupportedMessage: `ACP agent '${options.agentId}' no longer advertises session/load for recovery.`,
      authentication: planWeaveAcpExecutionAuthentication({
        hints: options.authenticationHints,
        availableEnvironmentVariables:
          options.availableEnvironmentVariables ?? new Set(Object.keys(options.env))
      }),
      interactionBroker: options.interactionBroker,
      interactionDeadline: options.interactionDeadline,
      followUpPrompts: options.followUpPrompts,
      eventSink: options.eventSink,
      lifecycleObserver: options.lifecycleObserver,
      signal: options.signal,
      limits: {
        operationTimeoutMs: timeoutMs,
        interactionTimeoutMs: timeoutMs
      },
      provider,
      connectionMode,
      ...(options.poolIdentity ? { poolIdentity: options.poolIdentity } : {})
    });
  } catch (error) {
    const executionCause =
      error instanceof AcpEngineExecutionError && error.executionCause !== undefined
        ? error.executionCause
        : error;
    if (registrationCleanup) {
      try {
        await registrationCleanup;
      } catch (cleanupError) {
        throw new AggregateError(
          [executionCause, cleanupError],
          "ACP connection registration and cleanup failed."
        );
      }
    }
    throw executionCause;
  }
}
