import { randomUUID } from "node:crypto";
import type { AcpConversationAction, AcpConversationPage } from "@planweave-ai/agent-host-protocol";
import type { CollaborationService } from "./collaboration/collaborationService.js";
import type { OperatorControlService } from "./operatorControl/operatorControlService.js";
import {
  desktopRemoteAcpConversationInputSchema,
  desktopRemoteAcpConversationPageSchema
} from "../shared/remoteAcpConversation.js";
import {
  remoteHumanExecutionActionCommandSchema,
  type RemoteHumanExecutionActionCommand,
  type RemoteOperationObservation,
  type RemoteInteractionPage,
  type RemoteInteractionResponse
} from "@planweave-ai/collaboration-protocol/remote-run";

type ScopedClient = {
  observe(): Promise<RemoteOperationObservation>;
  conversation(action?: AcpConversationAction): Promise<AcpConversationPage>;
  interactions(cursor: number): Promise<RemoteInteractionPage>;
  cancel(command: RemoteHumanExecutionActionCommand): Promise<unknown>;
  respond(response: RemoteInteractionResponse): Promise<unknown>;
};
export async function remoteAcpConversation(
  raw: unknown,
  collaboration: CollaborationService,
  operator: OperatorControlService
) {
  const input = desktopRemoteAcpConversationInputSchema.parse(raw);
  const locator = input.locator;
  const execute = async (client: ScopedClient) => {
    const operation = await client.observe();
    if (
      operation.projectId !== locator.projectId ||
      operation.canvasId !== locator.canvasId ||
      operation.blockRef !== input.blockRef
    )
      throw new Error("acp_conversation_scope_mismatch");
    const action = input.action;
    if (action?.kind === "execution_cancel") {
      const command = action.command;
      if (
        command.operationId !== operation.operationId ||
        command.executionAttemptId !== operation.executionAttemptId ||
        command.dispatchId !== operation.dispatchId
      )
        throw new Error("acp_conversation_attempt_mismatch");
      await client.cancel(command);
    } else if (action?.kind === "execution_respond") {
      if (
        action.response.executionAttemptId !== operation.executionAttemptId ||
        action.response.dispatchId !== operation.dispatchId
      )
        throw new Error("acp_conversation_attempt_mismatch");
      await client.respond(action.response);
    }
    const page = await client.conversation(
      action?.kind === "execution_cancel" || action?.kind === "execution_respond"
        ? undefined
        : action
    );
    const terminal = ["completed", "failed", "cancelled"].includes(operation.state);
    const interactions: RemoteInteractionPage["items"] = [];
    if (!terminal) {
      let cursor = 0;
      do {
        const result = await client.interactions(cursor);
        interactions.push(...result.items.filter((item) => item.status === "pending"));
        if (result.nextCursor === null) break;
        if (result.nextCursor <= cursor) throw new Error("acp_conversation_cursor_stalled");
        cursor = result.nextCursor;
      } while (cursor > 0);
    }
    const cancel =
      !terminal && operation.attempt.leaseId
        ? remoteHumanExecutionActionCommandSchema.parse({
            kind: "cancel",
            actionId: randomUUID(),
            operationId: operation.operationId,
            dispatchId: operation.dispatchId,
            executionAttemptId: operation.executionAttemptId,
            expectedAttemptVersion: operation.attempt.stateVersion,
            leaseId: operation.attempt.leaseId,
            reason: "User cancelled the remote ACP execution."
          })
        : null;
    return desktopRemoteAcpConversationPageSchema.parse({
      ...page,
      execution: { state: operation.state, cancel, interactions }
    });
  };
  if (locator.kind === "workspace") {
    return collaboration.withWorkspaceExecutionClient(locator, async (client) => {
      const remote = client.remoteOperations();
      return execute({
        observe: () => remote.observeRemoteOperation(input.operationId),
        conversation: (action) =>
          remote.acpConversation(input.operationId, input.afterCursor, action),
        interactions: (cursor) =>
          remote.listRemoteOperationInteractions(input.operationId, { cursor }),
        cancel: (command) => remote.executeRemoteOperationAction(input.operationId, command),
        respond: (response) => remote.settleRemoteOperationInteraction(input.operationId, response)
      });
    });
  }
  return operator.withExecutionProfile(locator.operatorProfileId, (client) =>
    execute({
      observe: () => client.observeRemoteOperation(input.operationId, locator.humanPrincipalId),
      conversation: (action) =>
        client.acpConversation(
          input.operationId,
          input.afterCursor,
          locator.humanPrincipalId,
          action
        ),
      interactions: (cursor) =>
        client.listRemoteOperationInteractions(input.operationId, cursor, locator.humanPrincipalId),
      cancel: (command) =>
        client.executeRemoteOperationAction(input.operationId, command, locator.humanPrincipalId),
      respond: (response) =>
        client.settleRemoteOperationInteraction(
          input.operationId,
          response,
          locator.humanPrincipalId
        )
    })
  );
}
