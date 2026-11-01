import type { RunnerInteractionAudit } from "./runnerInteractionContract.js";
import { acpRequestIdSchema, type PersistedPendingInteraction } from "./runnerContractSchemas.js";
import { containsUnredactedRunnerSecret, redactRunnerEventText } from "./runnerEventRedaction.js";

export type JsonRpcScalar = string | number | boolean | null;
export type JsonRpcValue =
  | JsonRpcScalar
  | JsonRpcValue[]
  | { readonly [key: string]: JsonRpcValue };

export type RunnerProcessHandle = {
  readonly pid: number | null;
  terminate: (reason: string) => Promise<void>;
};

export type RunnerConnectionHandle = {
  send: (message: JsonRpcValue) => Promise<void>;
  close: (reason: string) => Promise<void>;
  cancelSession: (sessionId: string) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  readonly supportsSessionClose: boolean;
};

type LivePendingRequestBase = {
  readonly requestId: string;
  readonly interactionId: string;
  readonly requestedAt: string;
  readonly summary: string;
  respond: (value: JsonRpcValue, audit?: RunnerInteractionAudit) => Promise<void>;
  reject: (reason: string, audit?: RunnerInteractionAudit) => Promise<void>;
};

export type LivePermissionOption = {
  readonly optionId: string;
  readonly label: string;
  readonly decision: "approve" | "deny";
};

export type LivePendingRequestHandle =
  | (LivePendingRequestBase & {
      readonly kind: "permission";
      readonly permissionOptions: readonly LivePermissionOption[];
      expire?: (reason: string) => Promise<void>;
    })
  | (LivePendingRequestBase & {
      readonly kind: "elicitation";
      readonly elicitationSchema: JsonRpcValue;
    })
  | (LivePendingRequestBase & { readonly kind: "authentication" });

export type RunnerInterventionCapabilities = {
  cancel: boolean;
  permission: boolean;
  elicitationPreview: boolean;
};

export type LivePendingOperationHandle = {
  readonly operationId: string;
  readonly operation: string;
  reject: (reason: string) => Promise<void>;
};

const liveOwnershipBrand: unique symbol = Symbol("planweave.runner.live-ownership");

export type LiveOwnership = {
  readonly runId: string;
  readonly generation: number;
  readonly [liveOwnershipBrand]: true;
};

export type RunnerLiveControl = {
  readonly ownership: LiveOwnership;
  readonly process: RunnerProcessHandle;
  readonly connection: RunnerConnectionHandle;
  sessionId: string | null;
  readonly interventionCapabilities: RunnerInterventionCapabilities;
  readonly pendingRequests: ReadonlyMap<string, LivePendingRequestHandle>;
  readonly pendingOperations: ReadonlyMap<string, LivePendingOperationHandle>;
};

export type RunnerInteractionBroker = {
  readonly mode: "interactive";
  requestAvailable: (request: LivePendingRequestHandle) => void | Promise<void>;
};

export type RunnerCleanupResult = {
  history: PersistedPendingInteraction[];
  alreadyCleaned: boolean;
};

export class RunnerCleanupError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly result: RunnerCleanupResult
  ) {
    super(errors, "Runner terminal cleanup did not complete cleanly.");
    this.name = "RunnerCleanupError";
  }
}

export const runnerCleanupSteps = [
  "pending_request",
  "pending_operation",
  "session_cancel",
  "session_close",
  "connection_close",
  "process_terminate"
] as const;

export type RunnerCleanupStep = (typeof runnerCleanupSteps)[number];

export type RunnerCleanupFailureSummary = {
  step: RunnerCleanupStep | "unknown";
  name: string;
  message: string;
};

/** Durable Auto Run / operator-visible shape for soft-stop cleanup noise. */
export type RunnerCleanupWarning = {
  alreadyCleaned: boolean;
  message: string;
  failures: RunnerCleanupFailureSummary[];
};

const cleanupStepBrand = Symbol("planweave.runnerCleanupStep");

type TaggedCleanupFailure = Error & {
  readonly [cleanupStepBrand]?: RunnerCleanupStep;
  readonly cleanupStep?: RunnerCleanupStep;
};

function taggedCleanupFailure(step: RunnerCleanupStep, reason: unknown): TaggedCleanupFailure {
  const error = sanitizedCleanupError(reason) as TaggedCleanupFailure;
  Object.defineProperty(error, cleanupStepBrand, { value: step, enumerable: false });
  Object.defineProperty(error, "cleanupStep", { value: step, enumerable: true });
  return error;
}

function cleanupFailureStep(error: unknown): RunnerCleanupStep | "unknown" {
  if (typeof error === "object" && error !== null && "cleanupStep" in error) {
    const step = (error as { cleanupStep?: unknown }).cleanupStep;
    if (typeof step === "string" && (runnerCleanupSteps as readonly string[]).includes(step)) {
      return step as RunnerCleanupStep;
    }
  }
  return "unknown";
}

function isIgnorableCleanupFailure(step: RunnerCleanupStep, reason: unknown): boolean {
  if (step !== "connection_close" && step !== "process_terminate" && step !== "session_close") {
    return false;
  }
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  const code =
    typeof reason === "object" && reason !== null && "code" in reason
      ? String((reason as { code?: unknown }).code ?? "")
      : "";
  return (
    code === "ESRCH" ||
    code === "ECHILD" ||
    /already (exited|closed|disposed|terminated|killed)/i.test(message) ||
    /no such process/i.test(message) ||
    /process does not exist/i.test(message)
  );
}

function collectCleanupFailures(
  step: RunnerCleanupStep,
  results: readonly PromiseSettledResult<unknown>[],
  failures: Error[]
): void {
  for (const result of results) {
    if (result.status !== "rejected") continue;
    if (isIgnorableCleanupFailure(step, result.reason)) continue;
    failures.push(taggedCleanupFailure(step, result.reason));
  }
}

export function summarizeRunnerCleanupError(error: RunnerCleanupError): RunnerCleanupWarning {
  return {
    alreadyCleaned: error.result.alreadyCleaned,
    message: error.message,
    failures: error.errors.map((item) => {
      const sanitized = sanitizedCleanupError(item);
      return {
        step: cleanupFailureStep(item),
        name: sanitized.name,
        message: sanitized.message
      };
    })
  };
}

/**
 * Soft-stop may continue after RunnerCleanupError (or an AggregateError of only those).
 * Returns a durable warning payload, or null when the failure must still abort stop.
 */
export function softStopAgentCleanupWarning(error: unknown): RunnerCleanupWarning | null {
  if (error instanceof RunnerCleanupError) {
    return summarizeRunnerCleanupError(error);
  }
  if (error instanceof AggregateError && error.errors.length > 0) {
    const nested = error.errors.map((item) => softStopAgentCleanupWarning(item));
    if (nested.every((item) => item !== null)) {
      return {
        alreadyCleaned: nested.some((item) => item!.alreadyCleaned),
        message: error.message,
        failures: nested.flatMap((item) => item!.failures)
      };
    }
  }
  return null;
}

const cleanupByControl = new WeakMap<RunnerLiveControl, Promise<RunnerCleanupResult>>();
const respondingRequests = new WeakSet<LivePendingRequestHandle>();
const respondingRequestPromises = new WeakMap<LivePendingRequestHandle, Promise<void>>();
const settledRequests = new WeakSet<LivePendingRequestHandle>();
const settledRequestIds = new WeakMap<RunnerLiveControl, Set<string>>();

export const RUNNER_CANCEL_GRACE_MS = 100;

function sanitizedCleanupError(error: unknown): Error {
  let message = "Runner cleanup operation failed.";
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  }
  let sanitized: string;
  try {
    sanitized = redactRunnerEventText(message).text;
  } catch {
    return new Error("Runner cleanup operation failed with a redacted diagnostic.");
  }
  if (containsUnredactedRunnerSecret(sanitized)) {
    return new Error("Runner cleanup operation failed with a redacted diagnostic.");
  }
  const result = new Error(sanitized);
  result.name = "RunnerCleanupOperationError";
  return result;
}

function repeatedCleanupError(error: unknown): never {
  if (error instanceof RunnerCleanupError) {
    throw new RunnerCleanupError(error.errors, { ...error.result, alreadyCleaned: true });
  }
  throw sanitizedCleanupError(error);
}

export function createLiveOwnership(runId: string, generation: number): LiveOwnership {
  if (!runId || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Live runner ownership requires a run id and positive generation.");
  }
  return { runId, generation, [liveOwnershipBrand]: true };
}

export function assertLiveOwnership(expected: LiveOwnership, actual: LiveOwnership): void {
  if (
    expected !== actual ||
    expected.runId !== actual.runId ||
    expected.generation !== actual.generation
  ) {
    throw new Error(
      "Runner live ownership was lost; persisted interaction history is not actionable."
    );
  }
}

export function persistedInteractionHistory(
  request: LivePendingRequestHandle,
  reason: PersistedPendingInteraction["nonActionableReason"]
): PersistedPendingInteraction {
  return {
    version: "planweave.runner/v1",
    interactionId: request.interactionId,
    requestId: acpRequestIdSchema.parse(request.requestId),
    kind: request.kind,
    requestedAt: request.requestedAt,
    summary: redactRunnerEventText(request.summary).text,
    status: reason === "terminal_cleanup" ? "cancelled" : "pending",
    actionable: false,
    nonActionableReason: reason
  };
}

async function settlePendingRunnerRequest(options: {
  control: RunnerLiveControl;
  ownership: LiveOwnership;
  requestId: string;
  settle: (request: LivePendingRequestHandle) => Promise<void>;
}): Promise<void> {
  assertLiveOwnership(options.control.ownership, options.ownership);
  if (cleanupByControl.has(options.control)) {
    throw new Error("Runner live control is terminal and no longer actionable.");
  }
  if (settledRequestIds.get(options.control)?.has(options.requestId)) {
    throw new Error(`Live runner request '${options.requestId}' was already answered.`);
  }
  const request = options.control.pendingRequests.get(options.requestId);
  if (!request) {
    throw new Error(`Live runner request '${options.requestId}' does not exist.`);
  }
  if (respondingRequests.has(request) || settledRequests.has(request)) {
    throw new Error(`Live runner request '${options.requestId}' was already answered.`);
  }
  respondingRequests.add(request);
  const response = Promise.resolve().then(() => options.settle(request));
  respondingRequestPromises.set(request, response);
  try {
    await response;
    settledRequests.add(request);
    const ids = settledRequestIds.get(options.control) ?? new Set<string>();
    ids.add(options.requestId);
    settledRequestIds.set(options.control, ids);
  } catch (error) {
    respondingRequests.delete(request);
    throw error;
  } finally {
    respondingRequestPromises.delete(request);
  }
}

export function respondToPendingRunnerRequest(options: {
  control: RunnerLiveControl;
  ownership: LiveOwnership;
  requestId: string;
  value: JsonRpcValue;
  audit?: RunnerInteractionAudit;
}): Promise<void> {
  return settlePendingRunnerRequest({
    ...options,
    settle: (request) =>
      options.audit === undefined
        ? request.respond(options.value)
        : request.respond(options.value, options.audit)
  });
}

export function rejectPendingRunnerRequest(options: {
  control: RunnerLiveControl;
  ownership: LiveOwnership;
  requestId: string;
  reason: string;
  audit?: RunnerInteractionAudit;
}): Promise<void> {
  return settlePendingRunnerRequest({
    ...options,
    settle: (request) =>
      options.audit === undefined
        ? request.reject(options.reason)
        : request.reject(options.reason, options.audit)
  });
}

async function boundedGrace(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function performRunnerCleanup(
  control: RunnerLiveControl,
  reason: string,
  cancelSession: boolean
): Promise<RunnerCleanupResult> {
  const requests = [...control.pendingRequests.values()];
  const operations = control.pendingOperations ? [...control.pendingOperations.values()] : [];
  const history = requests.map((request) =>
    persistedInteractionHistory(request, "terminal_cleanup")
  );
  const requestResults = await Promise.allSettled(
    requests.map(async (request) => {
      const response = respondingRequestPromises.get(request);
      if (response) {
        try {
          await response;
        } catch {
          // A failed response remains pending and must still be cancelled by terminal cleanup.
        }
      }
      if (settledRequests.has(request)) return;
      respondingRequests.add(request);
      try {
        if (request.kind === "permission" && request.expire) {
          await request.expire(reason);
        } else {
          await request.reject(reason);
        }
        settledRequests.add(request);
        const ids = settledRequestIds.get(control) ?? new Set<string>();
        ids.add(request.requestId);
        settledRequestIds.set(control, ids);
      } finally {
        respondingRequests.delete(request);
      }
    })
  );
  const failures: Error[] = [];
  collectCleanupFailures("pending_request", requestResults, failures);

  if (cancelSession && control.sessionId) {
    const cancelResults = await Promise.allSettled([
      control.connection.cancelSession(control.sessionId)
    ]);
    collectCleanupFailures("session_cancel", cancelResults, failures);
    await boundedGrace(RUNNER_CANCEL_GRACE_MS);
    if (control.connection.supportsSessionClose) {
      const closeSessionResults = await Promise.allSettled([
        control.connection.closeSession(control.sessionId)
      ]);
      collectCleanupFailures("session_close", closeSessionResults, failures);
    }
  }

  const operationResults = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(() => operation.reject(reason)))
  );
  collectCleanupFailures("pending_operation", operationResults, failures);

  const connectionCloseResults = await Promise.allSettled([
    Promise.resolve().then(() => control.connection.close(reason))
  ]);
  collectCleanupFailures("connection_close", connectionCloseResults, failures);
  const processTerminateResults = await Promise.allSettled([
    Promise.resolve().then(() => control.process.terminate(reason))
  ]);
  collectCleanupFailures("process_terminate", processTerminateResults, failures);

  const cleanupResult = { history, alreadyCleaned: false };
  if (failures.length > 0) {
    throw new RunnerCleanupError(failures, cleanupResult);
  }
  return cleanupResult;
}

export async function cleanupRunnerLiveControl(
  control: RunnerLiveControl,
  ownership: LiveOwnership,
  reason: string,
  options: { cancelSession?: boolean } = {}
): Promise<RunnerCleanupResult> {
  assertLiveOwnership(control.ownership, ownership);
  const existing = cleanupByControl.get(control);
  if (existing) {
    try {
      const result = await existing;
      return { ...result, alreadyCleaned: true };
    } catch (error) {
      repeatedCleanupError(error);
    }
  }
  const cleanup = Promise.resolve().then(() =>
    performRunnerCleanup(
      control,
      redactRunnerEventText(reason).text,
      options.cancelSession !== false
    )
  );
  cleanupByControl.set(control, cleanup);
  return cleanup;
}
