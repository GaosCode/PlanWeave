import { acpConversationTurns } from "../autoRun/acpConversationTurn.js";
import { continueAcpPrompt, queueLiveAcpPrompt } from "./acpPromptApi.js";
import { resolvePersistedAgentPromptTurnTarget } from "./recordsApi.js";
import {
  desktopAgentPromptIdentitySchema,
  desktopAgentPromptTurnCancelResultSchema,
  desktopAgentPromptTurnIdentitySchema,
  desktopAgentPromptTurnQueryResultSchema,
  desktopAgentPromptTurnStateSchema,
  desktopSendAgentPromptRequestSchema,
  type DesktopAgentPromptIdentity,
  type DesktopAgentPromptTurnCancelResult,
  type DesktopAgentPromptTurnIdentity,
  type DesktopAgentPromptTurnQueryResult,
  type DesktopAgentPromptTurnState,
  type DesktopSendAgentPromptRequest
} from "./types/acpBridgeTypes.js";

function stableIdentity(identity: DesktopAgentPromptIdentity): DesktopAgentPromptIdentity {
  return desktopAgentPromptIdentitySchema.parse({
    ref: identity.ref,
    recordId: identity.recordId,
    executorRunId: identity.executorRunId,
    claimRef: identity.claimRef,
    sessionId: identity.sessionId
  });
}

export async function sendAgentPrompt(
  rawRequest: DesktopSendAgentPromptRequest
): Promise<DesktopAgentPromptTurnState> {
  const request = desktopSendAgentPromptRequestSchema.parse(rawRequest);
  const { workspace, context } = await resolvePersistedAgentPromptTurnTarget(
    stableIdentity(request.identity)
  );
  if (context.mode === "live") {
    await queueLiveAcpPrompt({ context, text: request.text });
    return desktopAgentPromptTurnStateSchema.parse({
      identity: request.identity,
      phase: "terminal",
      terminal: "succeeded",
      cancellationRequested: false,
      cancellable: false
    });
  }
  return continueAcpPrompt({
    workspace,
    context,
    identity: request.identity,
    text: request.text
  });
}

export async function getCurrentAgentPromptTurn(
  rawIdentity: DesktopAgentPromptIdentity
): Promise<DesktopAgentPromptTurnQueryResult> {
  const stableIdentity = desktopAgentPromptIdentitySchema.parse(rawIdentity);
  const { context, runDir } = await resolvePersistedAgentPromptTurnTarget(stableIdentity);
  if (context.mode !== "completed") {
    return desktopAgentPromptTurnQueryResultSchema.parse({ found: false, reason: "not_found" });
  }
  return desktopAgentPromptTurnQueryResultSchema.parse(
    acpConversationTurns.current(runDir, stableIdentity)
  );
}

export async function getAgentPromptTurn(
  rawIdentity: DesktopAgentPromptTurnIdentity
): Promise<DesktopAgentPromptTurnQueryResult> {
  const identity = desktopAgentPromptTurnIdentitySchema.parse(rawIdentity);
  const { context, runDir } = await resolvePersistedAgentPromptTurnTarget(stableIdentity(identity));
  if (context.mode !== "completed") {
    return desktopAgentPromptTurnQueryResultSchema.parse({ found: false, reason: "not_found" });
  }
  return desktopAgentPromptTurnQueryResultSchema.parse(
    acpConversationTurns.query(runDir, identity)
  );
}

export async function cancelAgentPromptTurn(
  rawIdentity: DesktopAgentPromptTurnIdentity
): Promise<DesktopAgentPromptTurnCancelResult> {
  const identity = desktopAgentPromptTurnIdentitySchema.parse(rawIdentity);
  const { context, runDir } = await resolvePersistedAgentPromptTurnTarget(stableIdentity(identity));
  if (context.mode !== "completed") {
    return desktopAgentPromptTurnCancelResultSchema.parse({ outcome: "not_found", state: null });
  }
  return desktopAgentPromptTurnCancelResultSchema.parse(
    await acpConversationTurns.cancel(runDir, identity)
  );
}
