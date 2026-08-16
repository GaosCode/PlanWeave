import {
  agentRunControlRespondOutcomeSchema,
  cancelDesktopAgentRun,
  cancelAgentPromptTurn,
  desktopAgentPromptTurnCancelResultSchema,
  desktopAgentPromptIdentitySchema,
  desktopAgentPromptTurnIdentitySchema,
  desktopAgentPromptTurnQueryResultSchema,
  desktopAgentPromptTurnStateSchema,
  desktopAgentActionIdentitySchema,
  desktopAgentActionValueSchema,
  desktopSendAgentPromptRequestSchema,
  desktopAgentSessionActionIdentitySchema,
  listDesktopPendingAgentRequests,
  listPendingRunnerInteractions,
  listPendingRunnerInteractionsResultSchema,
  respondToDesktopAgentAuthenticationRequest,
  respondToDesktopAgentRequest,
  respondToRunnerInteractionAction,
  respondToRunnerInteractionResultSchema,
  runnerInteractionActionIdentitySchema,
  runnerInteractionAuditSchema,
  runnerInteractionCanvasRefSchema,
  runnerInteractionErrorCodeSchema,
  runnerPermissionInteractionDecisionSchema,
  RunnerInteractionApiError,
  getCurrentAgentPromptTurn,
  getAgentPromptTurn,
  sendAgentPrompt
} from "@planweave-ai/runtime";
import { z } from "zod";
import type { RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";
import {
  isRecord,
  isValidationFailure,
  validationFailureMessage
} from "./runtimeBridgeValidationFailure.js";

function runnerInteractionFailure(error: unknown) {
  const runtimeError =
    error instanceof RunnerInteractionApiError ||
    (isRecord(error) && error.name === "RunnerInteractionApiError")
      ? error
      : null;
  const errorCode = runnerInteractionErrorCodeSchema.safeParse(runtimeError?.code);
  if (runtimeError && errorCode.success && typeof runtimeError.message === "string") {
    const details = z.json().safeParse(runtimeError.details);
    return {
      ok: false as const,
      error: {
        code: errorCode.data,
        message: runtimeError.message,
        details: details.success ? details.data : null
      }
    };
  }
  if (isValidationFailure(error)) {
    return {
      ok: false as const,
      error: {
        code: "interaction_contract_invalid" as const,
        message: validationFailureMessage(error),
        details: null
      }
    };
  }
  return {
    ok: false as const,
    error: {
      code: "interaction_contract_invalid" as const,
      message: "Runner interaction IPC boundary failed.",
      details: null
    }
  };
}

export const runtimeBridgeRunnerInteractionHandlers = {
  listPendingAgentRequests: (_event, identity) =>
    listDesktopPendingAgentRequests(desktopAgentActionIdentitySchema.parse(identity)),
  listPendingRunnerInteractions: async (_event, ref) => {
    try {
      return listPendingRunnerInteractionsResultSchema.parse({
        ok: true,
        value: await listPendingRunnerInteractions(runnerInteractionCanvasRefSchema.parse(ref))
      });
    } catch (error) {
      return listPendingRunnerInteractionsResultSchema.parse(runnerInteractionFailure(error));
    }
  },
  respondToAgentRequest: (_event, ref, recordId, identity, outcome) =>
    respondToDesktopAgentRequest(
      ref,
      recordId,
      desktopAgentActionIdentitySchema.parse(identity),
      agentRunControlRespondOutcomeSchema.parse(outcome)
    ),
  respondToAgentAuthenticationRequest: (_event, identity, value) =>
    respondToDesktopAgentAuthenticationRequest(
      desktopAgentActionIdentitySchema.parse(identity),
      desktopAgentActionValueSchema.parse(value)
    ),
  respondToRunnerInteraction: async (_event, ref, action, decision, audit) => {
    try {
      return respondToRunnerInteractionResultSchema.parse({
        ok: true,
        value: await respondToRunnerInteractionAction(
          runnerInteractionCanvasRefSchema.parse(ref),
          runnerInteractionActionIdentitySchema.parse(action),
          runnerPermissionInteractionDecisionSchema.parse(decision),
          runnerInteractionAuditSchema.parse(audit)
        )
      });
    } catch (error) {
      return respondToRunnerInteractionResultSchema.parse(runnerInteractionFailure(error));
    }
  },
  cancelAgentRun: (_event, ref, recordId, identity) =>
    cancelDesktopAgentRun(ref, recordId, desktopAgentSessionActionIdentitySchema.parse(identity)),
  sendAgentPrompt: async (_event, request) =>
    desktopAgentPromptTurnStateSchema.parse(
      await sendAgentPrompt(desktopSendAgentPromptRequestSchema.parse(request))
    ),
  getAgentPromptTurn: async (_event, identity) =>
    desktopAgentPromptTurnQueryResultSchema.parse(
      await getAgentPromptTurn(desktopAgentPromptTurnIdentitySchema.parse(identity))
    ),
  getCurrentAgentPromptTurn: async (_event, identity) =>
    desktopAgentPromptTurnQueryResultSchema.parse(
      await getCurrentAgentPromptTurn(desktopAgentPromptIdentitySchema.parse(identity))
    ),
  cancelAgentPromptTurn: async (_event, identity) =>
    desktopAgentPromptTurnCancelResultSchema.parse(
      await cancelAgentPromptTurn(desktopAgentPromptTurnIdentitySchema.parse(identity))
    )
} satisfies Partial<RuntimeBridgeHandlerMap>;
