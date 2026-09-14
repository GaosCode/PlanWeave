import { z } from "zod";
import type {
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse
} from "@agentclientprotocol/sdk";
import {
  CreateElicitationRequest as CreateElicitationRequestGuard,
  RequestError
} from "@agentclientprotocol/sdk";
import type { AcpEventStore } from "./acpEventStore.js";
import { createAcpElicitationSettlement } from "./acpElicitationSettlement.js";
import { normalizeAcpElicitationHistory } from "./acpEventNormalization.js";
import type { AcpEngineInteractionBroker } from "./acpExecutionEngineContracts.js";
import type { LivePendingRequestHandle, RunnerInteractionBroker } from "./liveControl.js";
import { acpCorrelationSchema, acpRequestIdSchema } from "./runnerContractSchemas.js";
import { redactRunnerEventPayload, redactRunnerEventText } from "./runnerEventRedaction.js";

type PermissionHandler = (
  request: RequestPermissionRequest,
  requestId: string,
  requestedAt: string
) => Promise<RequestPermissionResponse>;

function diagnostic(error: unknown): string {
  return redactRunnerEventText(error instanceof Error ? error.message : String(error)).text;
}

export function createLocalAcpInteractionBroker(options: {
  readonly permissionHandler: PermissionHandler;
  readonly eventStore: AcpEventStore | null;
  readonly interactionBroker?: RunnerInteractionBroker;
  readonly setOperationDeadline: (deadline: Date) => void;
  readonly addPending: (pending: LivePendingRequestHandle) => void;
  readonly releasePending: (requestId: string) => void;
}): AcpEngineInteractionBroker {
  return {
    advertiseElicitation: options.interactionBroker != null,
    requestPermission: async (request, context) => {
      options.setOperationDeadline(context.deadline);
      const response = await options.permissionHandler(
        {
          sessionId: request.sessionId,
          toolCall: { toolCallId: request.toolCallId, title: request.summary },
          options: request.options.map((option) => ({
            optionId: option.optionId,
            name: option.label,
            kind: option.kind
          }))
        },
        request.requestId,
        new Date().toISOString()
      );
      return response.outcome.outcome === "selected"
        ? { kind: "select", optionId: response.outcome.optionId }
        : { kind: "cancel" };
    },
    requestElicitation: async (request) => {
      const requestId = acpRequestIdSchema.parse(request.requestId);
      const requestedAt = new Date().toISOString();
      const candidate = {
        mode: "form" as const,
        requestId,
        message: request.message,
        requestedSchema: request.requestedSchema,
        ...(request.sessionId ? { sessionId: request.sessionId } : {})
      };
      if (!CreateElicitationRequestGuard.isForm(candidate)) {
        throw RequestError.invalidParams(undefined, "Invalid ACP elicitation form schema.");
      }
      if (options.eventStore) {
        await options.eventStore.append(
          normalizeAcpElicitationHistory(candidate, requestId, requestedAt),
          request.sessionId
            ? acpCorrelationSchema.parse({ sessionId: request.sessionId })
            : undefined
        );
      }
      if (!options.interactionBroker) {
        if (options.eventStore) {
          await options.eventStore.append(
            {
              kind: "interaction_result",
              requestId,
              interactionId: requestId,
              interactionKind: "elicitation",
              outcome: "cancelled",
              message: "Elicitation was cancelled by the headless default-safe policy."
            },
            request.sessionId
              ? acpCorrelationSchema.parse({ sessionId: request.sessionId })
              : undefined
          );
        }
        return { action: "cancel" };
      }
      const interactionBroker = options.interactionBroker;
      return new Promise<CreateElicitationResponse>((resolve, reject) => {
        const complete = (response: CreateElicitationResponse): void => {
          options.releasePending(requestId);
          resolve(response);
        };
        let settlement: ReturnType<typeof createAcpElicitationSettlement>;
        try {
          settlement = createAcpElicitationSettlement({
            requestId,
            requestedSchema: candidate.requestedSchema,
            complete,
            publishResult: async (result) => {
              if (options.eventStore) {
                await options.eventStore.append(
                  {
                    kind: "interaction_result",
                    requestId,
                    interactionId: requestId,
                    interactionKind: "elicitation",
                    outcome: result.outcome,
                    message: result.message
                  },
                  request.sessionId
                    ? acpCorrelationSchema.parse({ sessionId: request.sessionId })
                    : undefined
                );
              }
            }
          });
        } catch (error) {
          throw RequestError.invalidParams(undefined, diagnostic(error));
        }
        const pending: LivePendingRequestHandle = {
          requestId,
          interactionId: requestId,
          kind: "elicitation",
          requestedAt,
          summary: JSON.stringify(redactRunnerEventPayload(candidate)),
          respond: settlement.respond,
          reject: settlement.cancel,
          elicitationSchema: z.json().parse(redactRunnerEventPayload(candidate.requestedSchema))
        };
        options.addPending(pending);
        Promise.resolve(interactionBroker.requestAvailable(pending)).catch((error) => {
          options.releasePending(requestId);
          reject(error);
        });
      });
    }
  };
}
