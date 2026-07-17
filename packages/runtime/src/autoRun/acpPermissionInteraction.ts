import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { acpCorrelationSchema } from "./runnerContractSchemas.js";
import type { AcpEventStore } from "./acpEventStore.js";
import { normalizeAcpPermissionHistorySummary } from "./acpEventNormalization.js";
import type { RunnerInteractionBroker, LivePendingRequestHandle } from "./liveControl.js";
import {
  PersistentRunnerInteractionChannel,
  RunnerInteractionChannelError,
  type RunnerPermissionChannelDecision
} from "./persistentRunnerInteractionChannel.js";
import {
  runnerPermissionInteractionRequestSchema,
  runnerPermissionInteractionResponseSchema,
  type RunnerPermissionOption
} from "./runnerInteractionContract.js";
import { PersistentRunnerInteractionStore } from "./runnerInteractionStore.js";
import { redactRunnerEventText } from "./runnerEventRedaction.js";
import {
  createRunnerInteractionRequiredEvent,
  createRunnerInteractionResolvedEvent,
  type RunnerInteractionObserver
} from "./runnerInteractionObserver.js";

type PermissionInteractionContext = {
  runDir: string;
  identity: {
    projectId: string | undefined;
    canvasId: string | undefined;
    claimRef: string;
    executorRunId: string;
    ownerLeaseId: string;
    ownerGeneration: number;
  };
  eventStore: AcpEventStore | null;
  signal: AbortSignal;
  deadline: () => Date | null;
  interactionBroker?: RunnerInteractionBroker;
  interactionObserver?: RunnerInteractionObserver;
  setWaiting: (requestId: string, waiting: boolean) => Promise<void>;
  addPending: (request: LivePendingRequestHandle) => void;
  releasePending: (requestId: string) => void;
  recordFailure: (error: RunnerInteractionChannelError) => void;
  pollIntervalMs?: number;
};

function permissionDecision(
  kind: RequestPermissionRequest["options"][number]["kind"]
): "approve" | "deny" {
  switch (kind) {
    case "allow_once":
    case "allow_always":
      return "approve";
    case "reject_once":
    case "reject_always":
      return "deny";
  }
}

function permissionOptions(request: RequestPermissionRequest): RunnerPermissionOption[] {
  return request.options.map((option) => ({
    optionId: option.optionId,
    label: redactRunnerEventText(option.name).text,
    decision: permissionDecision(option.kind)
  }));
}

function interactionResult(decision: RunnerPermissionChannelDecision): {
  outcome: "approved" | "denied" | "cancelled" | "expired";
  message: string;
} {
  if (decision.kind === "cancel") {
    return { outcome: "cancelled", message: "Permission request was cancelled." };
  }
  if (decision.kind === "expired") {
    return {
      outcome: "expired",
      message:
        decision.reason === "deadline"
          ? "Permission request expired at the ACP operation deadline."
          : decision.reason === "establishment_failed"
            ? "Permission request expired because durable interaction establishment failed."
            : decision.reason === "terminal_cleanup"
              ? "Permission request expired during owner terminal cleanup."
              : "Permission request expired because the ACP operation was aborted."
    };
  }
  return decision.option.decision === "deny"
    ? { outcome: "denied", message: "Permission request was denied." }
    : { outcome: "approved", message: "Permission request was approved." };
}

function sdkResponse(decision: RunnerPermissionChannelDecision): RequestPermissionResponse {
  return decision.kind === "select"
    ? { outcome: { outcome: "selected", optionId: decision.option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function createPersistentAcpPermissionHandler(context: PermissionInteractionContext) {
  const store = new PersistentRunnerInteractionStore(context.runDir);
  const channel = new PersistentRunnerInteractionChannel({
    store,
    pollIntervalMs: context.pollIntervalMs,
    publishPending: async (request) => {
      if (!context.eventStore) {
        throw new Error("ACP permission interaction requires an auditable event store.");
      }
      await context.eventStore.append(
        normalizeAcpPermissionHistorySummary(
          request.summary,
          request.identity.requestId,
          request.requestedAt
        ),
        acpCorrelationSchema.parse({ sessionId: request.identity.sessionId })
      );
    },
    publishResult: async (request, decision) => {
      if (!context.eventStore) {
        throw new Error("ACP permission interaction requires an auditable event store.");
      }
      const result = interactionResult(decision);
      await context.eventStore.append(
        {
          kind: "interaction_result",
          requestId: request.identity.requestId,
          interactionId: request.identity.requestId,
          interactionKind: "permission",
          outcome: result.outcome,
          message: result.message
        },
        acpCorrelationSchema.parse({ sessionId: request.identity.sessionId })
      );
    },
    setWaiting: context.setWaiting,
    notifyRequired: async (request) => {
      const pending: LivePendingRequestHandle = {
        requestId: request.identity.requestId,
        interactionId: request.identity.requestId,
        kind: "permission",
        requestedAt: request.requestedAt,
        summary: request.summary,
        permissionOptions: request.options,
        respond: async (value) => {
          if (typeof value !== "string") {
            throw new Error(
              `Permission response for '${request.identity.requestId}' must select an advertised option id.`
            );
          }
          await store.createResponse(
            runnerPermissionInteractionResponseSchema.parse({
              version: "planweave.runner-interaction-response/v1",
              identity: request.identity,
              decision: { kind: "select", optionId: value },
              respondedAt: new Date().toISOString(),
              decisionSource: "planweave-desktop",
              reason: null
            })
          );
        },
        reject: async (reason) => {
          await store.createResponse(
            runnerPermissionInteractionResponseSchema.parse({
              version: "planweave.runner-interaction-response/v1",
              identity: request.identity,
              decision: { kind: "cancel" },
              respondedAt: new Date().toISOString(),
              decisionSource: "planweave-desktop",
              reason: redactRunnerEventText(reason).text || "Permission request was cancelled."
            })
          );
        },
        expire: async (reason) => {
          await store.settleOwnerResult({
            version: "planweave.runner-interaction-owner-result/v1",
            identity: request.identity,
            outcome: "expired",
            reason: "terminal_cleanup",
            recordedAt: new Date().toISOString(),
            message: redactRunnerEventText(reason).text
          });
        }
      };
      context.addPending(pending);
      await Promise.all([
        context.interactionBroker?.requestAvailable(pending),
        context.interactionObserver?.interactionRequired(
          createRunnerInteractionRequiredEvent(request)
        )
      ]);
    },
    publishDiagnostic: async (code, message) => {
      await context.eventStore?.append({
        kind: "diagnostic",
        code: code === "interaction_observer_failed" ? code : "interaction_observer_failed",
        message: redactRunnerEventText(message).text
      });
    }
  });

  return async (
    request: RequestPermissionRequest,
    requestId: string,
    requestedAt: string
  ): Promise<RequestPermissionResponse> => {
    try {
      const options = permissionOptions(request);
      const toolTitle = request.toolCall.title
        ? redactRunnerEventText(request.toolCall.title).text
        : "ACP tool call";
      const summary = `Permission requested for: ${toolTitle}`;
      const persisted = runnerPermissionInteractionRequestSchema.parse({
        version: "planweave.runner-interaction/v1",
        kind: "permission",
        identity: {
          ...context.identity,
          sessionId: request.sessionId,
          requestId
        },
        requestedAt,
        summary,
        toolCallId: request.toolCall.toolCallId,
        options
      });
      const decision = await channel.requestPermission(persisted, {
        signal: context.signal,
        deadline: context.deadline()
      });
      const response = sdkResponse(decision);
      context.releasePending(requestId);
      try {
        await context.interactionObserver?.interactionResolved(
          createRunnerInteractionResolvedEvent(persisted, decision)
        );
      } catch (observerError) {
        await context.eventStore?.append({
          kind: "diagnostic",
          code: "interaction_observer_failed",
          message: redactRunnerEventText(
            observerError instanceof Error
              ? observerError.message
              : "Runner interaction observer failed."
          ).text
        });
      }
      return response;
    } catch (error) {
      const failure =
        error instanceof RunnerInteractionChannelError
          ? error
          : new RunnerInteractionChannelError(
              "interaction_persistence_failed",
              "ACP permission request did not satisfy the persistent interaction contract.",
              { cause: error }
            );
      context.releasePending(requestId);
      context.recordFailure(failure);
      try {
        await context.eventStore?.append({
          kind: "diagnostic",
          code: failure.code,
          message: failure.message
        });
      } catch (diagnosticError) {
        context.recordFailure(
          new RunnerInteractionChannelError(
            "interaction_persistence_failed",
            "ACP permission persistence and its diagnostic audit both failed.",
            { cause: new AggregateError([failure, diagnosticError]) }
          )
        );
      }
      return { outcome: { outcome: "cancelled" } };
    }
  };
}
