import { acpPermissionOptionsSchema } from "@planweave-ai/agent-host-protocol";
import {
  CreateElicitationRequest as CreateElicitationRequestGuard,
  RequestError,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse
} from "@agentclientprotocol/sdk";
import {
  AcpElicitationSettlementError,
  createAcpElicitationSettlement
} from "./acpElicitationSettlement.js";
import { createAcpInteractionRequestId } from "./acpEventNormalization.js";
import type {
  AcpEngineClock,
  AcpEngineEventPayload,
  AcpEngineInteractionBroker,
  AcpEnginePermissionDecision
} from "./acpExecutionEngineContracts.js";
import { normalizedRedactedContent } from "./normalizedEventContract.js";
import { redactRunnerEventPayload } from "./runnerEventRedaction.js";

export class AcpEngineInteractionError extends Error {
  constructor(
    readonly timedOut: boolean,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AcpEngineInteractionError";
  }
}

/**
 * Protocol/schema failures must keep a recoverable message (Invalid params / unsupported type).
 * Only opaque broker faults collapse into the generic engine interaction error.
 */
function asInteractionFailure(error: unknown, opaqueMessage: string): AcpEngineInteractionError {
  if (error instanceof AcpEngineInteractionError) return error;
  if (error instanceof RequestError || error instanceof AcpElicitationSettlementError) {
    return new AcpEngineInteractionError(false, error.message, error);
  }
  if (error instanceof Error && /unsupported property type|Invalid params/i.test(error.message)) {
    return new AcpEngineInteractionError(false, error.message, error);
  }
  return new AcpEngineInteractionError(false, opaqueMessage, error);
}

type InteractionHandlersOptions = {
  readonly broker?: AcpEngineInteractionBroker;
  readonly deadline?: () => Date | null;
  readonly clock: AcpEngineClock;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly emit: (event: AcpEngineEventPayload) => Promise<void>;
};

function deadline(options: InteractionHandlersOptions): { at: Date; timeoutMs: number } {
  const now = options.clock.now();
  const configured = options.deadline?.() ?? null;
  const at = configured ?? new Date(now.getTime() + options.timeoutMs);
  return { at, timeoutMs: Math.max(0, at.getTime() - now.getTime()) };
}

function withDeadline<T>(options: {
  work: Promise<T>;
  clock: AcpEngineClock;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<T> {
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", relayAbort, { once: true });
  if (options.signal.aborted) relayAbort();
  const timeout = options.clock.sleep(options.timeoutMs, controller.signal).then(() => {
    throw new AcpEngineInteractionError(
      true,
      `ACP interaction timed out after ${options.timeoutMs}ms.`
    );
  });
  return Promise.race([options.work, timeout]).finally(() => {
    options.signal.removeEventListener("abort", relayAbort);
    controller.abort(new Error("ACP interaction deadline settled."));
  });
}

async function validatedElicitationResponse(
  broker: AcpEngineInteractionBroker,
  request: CreateElicitationRequest,
  requestId: string,
  signal: AbortSignal,
  at: Date,
  clock: AcpEngineClock,
  timeoutMs: number
): Promise<CreateElicitationResponse> {
  if (!CreateElicitationRequestGuard.isForm(request)) return { action: "cancel" };
  const raw = await withDeadline({
    work: Promise.resolve(
      broker.requestElicitation(
        {
          requestId,
          sessionId:
            "sessionId" in request && typeof request.sessionId === "string"
              ? request.sessionId
              : null,
          message: normalizedRedactedContent(request.message).content,
          requestedSchema: redactRunnerEventPayload(request.requestedSchema)
        },
        { signal, deadline: at }
      )
    ),
    clock,
    timeoutMs,
    signal
  });
  return new Promise<CreateElicitationResponse>((resolve, reject) => {
    try {
      const settlement = createAcpElicitationSettlement({
        requestId,
        requestedSchema: request.requestedSchema,
        publishResult: async () => undefined,
        complete: resolve
      });
      void settlement.respond(raw as Parameters<typeof settlement.respond>[0]).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

type AcpExecutionInteractionHandlers = {
  readonly onPermissionRequest: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly onElicitationRequest: (
    request: CreateElicitationRequest
  ) => Promise<CreateElicitationResponse>;
  readonly drain: () => Promise<void>;
  readonly close: () => void;
  readonly stopAcceptingRequests: () => void;
  readonly failure: AcpEngineInteractionError | null;
};

export function createAcpExecutionInteractionHandlers(
  options: InteractionHandlersOptions
): AcpExecutionInteractionHandlers {
  const parentSignal = options.signal;
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", relayAbort, { once: true });
  if (parentSignal.aborted) relayAbort();
  options = { ...options, signal: controller.signal };
  const assertActive = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  let acceptingRequests = true;
  const stopAcceptingRequests = (): void => {
    acceptingRequests = false;
  };
  const close = (): void => {
    stopAcceptingRequests();
    parentSignal.removeEventListener("abort", relayAbort);
    controller.abort(new AcpEngineInteractionError(false, "ACP interaction scope closed."));
  };
  let ordinal = 0;
  let failure: AcpEngineInteractionError | null = null;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: () => Promise<T>, message: string): Promise<T> => {
    if (!acceptingRequests) {
      return Promise.reject(new AcpEngineInteractionError(false, "ACP interaction scope closed."));
    }
    const operation = work().catch((error: unknown) => {
      failure ??= asInteractionFailure(error, message);
      throw failure;
    });
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation)
    );
    return operation;
  };

  const onPermissionRequest = async (
    request: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> => {
    assertActive();
    const requestId = createAcpInteractionRequestId("permission", ++ordinal);
    await options.emit({
      kind: "interaction",
      requestId,
      interaction: "permission",
      state: "requested"
    });
    assertActive();
    if (!options.broker) {
      await options.emit({
        kind: "interaction",
        requestId,
        interaction: "permission",
        state: "resolved",
        outcome: "cancelled"
      });
      assertActive();
      return { outcome: { outcome: "cancelled" } };
    }
    const interaction = deadline(options);
    let decision: AcpEnginePermissionDecision;
    try {
      decision = await withDeadline({
        work: Promise.resolve(
          options.broker.requestPermission(
            {
              requestId,
              sessionId: request.sessionId,
              toolCallId: request.toolCall.toolCallId,
              summary: normalizedRedactedContent(
                request.toolCall.title ?? `Permission requested for ${request.toolCall.toolCallId}.`
              ).content,
              options: acpPermissionOptionsSchema.parse(
                request.options.map((option) => ({
                  optionId: option.optionId,
                  label: normalizedRedactedContent(option.name).content,
                  kind: option.kind
                }))
              )
            },
            { signal: options.signal, deadline: interaction.at }
          )
        ),
        clock: options.clock,
        timeoutMs: interaction.timeoutMs,
        signal: options.signal
      });
    } catch (error) {
      failure ??=
        error instanceof AcpEngineInteractionError
          ? error
          : new AcpEngineInteractionError(false, "ACP permission broker failed.", error);
      throw failure;
    }
    assertActive();
    if (
      decision.kind === "select" &&
      !request.options.some((item) => item.optionId === decision.optionId)
    ) {
      failure ??= new AcpEngineInteractionError(
        false,
        "ACP permission broker selected an unknown option."
      );
      throw failure;
    }
    await options.emit({
      kind: "interaction",
      requestId,
      interaction: "permission",
      state: "resolved",
      outcome: decision.kind === "select" ? "selected" : "cancelled"
    });
    assertActive();
    return decision.kind === "select"
      ? { outcome: { outcome: "selected", optionId: decision.optionId } }
      : { outcome: { outcome: "cancelled" } };
  };

  const onElicitationRequest = async (
    request: CreateElicitationRequest
  ): Promise<CreateElicitationResponse> => {
    assertActive();
    const requestId = createAcpInteractionRequestId("elicitation", ++ordinal);
    await options.emit({
      kind: "interaction",
      requestId,
      interaction: "elicitation",
      state: "requested"
    });
    assertActive();
    if (!options.broker || !CreateElicitationRequestGuard.isForm(request)) {
      await options.emit({
        kind: "interaction",
        requestId,
        interaction: "elicitation",
        state: "resolved",
        outcome: "cancelled"
      });
      assertActive();
      return { action: "cancel" };
    }
    const interaction = deadline(options);
    let response: CreateElicitationResponse;
    try {
      response = await validatedElicitationResponse(
        options.broker,
        request,
        requestId,
        options.signal,
        interaction.at,
        options.clock,
        interaction.timeoutMs
      );
    } catch (error) {
      failure ??= asInteractionFailure(error, "ACP elicitation broker failed.");
      throw failure;
    }
    assertActive();
    await options.emit({
      kind: "interaction",
      requestId,
      interaction: "elicitation",
      state: "resolved",
      outcome:
        response.action === "accept"
          ? "accepted"
          : response.action === "decline"
            ? "declined"
            : "cancelled"
    });
    assertActive();
    return response;
  };

  return {
    onPermissionRequest: (request: RequestPermissionRequest) =>
      track(() => onPermissionRequest(request), "ACP permission broker failed."),
    onElicitationRequest: (request: CreateElicitationRequest) =>
      track(() => onElicitationRequest(request), "ACP elicitation broker failed."),
    close,
    stopAcceptingRequests,
    drain: async (): Promise<void> => {
      if (pending.size === 0) return;
      const interaction = deadline(options);
      try {
        await withDeadline({
          work: (async () => {
            while (pending.size > 0) await Promise.allSettled([...pending]);
          })(),
          clock: options.clock,
          timeoutMs: interaction.timeoutMs,
          signal: options.signal
        });
      } catch (error) {
        failure ??= asInteractionFailure(error, "ACP interaction settlement failed.");
        close();
      }
    },
    get failure(): AcpEngineInteractionError | null {
      return failure;
    }
  };
}
