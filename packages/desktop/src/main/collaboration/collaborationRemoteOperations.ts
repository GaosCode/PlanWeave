import { opaqueIdentifierSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  remoteDispatchIntentV3Schema,
  remoteEventQuerySchema,
  remoteInteractionPageQuerySchema,
  type RemoteActionView,
  type RemoteEventReplay,
  type RemoteInteractionPage,
  type RemoteInteractionView,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { RemoteAgentEndpointList } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { z } from "zod";
import {
  collaborationRemoteActionInputSchema,
  collaborationRemoteInteractionRespondInputSchema,
  collaborationRemoteOperationLookupInputSchema,
  collaborationRemoteOperationIdInputSchema,
  collaborationWorkspaceRemoteEventReplayInputSchema,
  collaborationWorkspaceRemoteOperationIdInputSchema,
  collaborationWorkspaceRemoteOperationLookupInputSchema
} from "../../shared/collaborationReadModels.js";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator.js";
import type { CollaborationRemoteOperationsPort } from "./CollaborationRemoteOperationsClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";

/**
 * Service-facing seam for remote-run dispatch/observe/action paths.
 * Keeps durable remote execution orchestration out of the profile/session service body.
 */
export class CollaborationRemoteOperationsFacade {
  constructor(
    private readonly withActiveClient: <T>(
      operation: (client: CollaborationRemoteOperationsPort) => Promise<T>
    ) => Promise<T>,
    private readonly withWorkspaceClient: <T>(
      locator: WorkspaceCanvasLocator,
      operation: (client: CollaborationRemoteOperationsPort) => Promise<T>
    ) => Promise<T>
  ) {}

  async listAgentEndpoints(): Promise<RemoteAgentEndpointList> {
    return this.withActiveClient((client) => client.listAgentEndpoints());
  }

  async dispatch(input: unknown): Promise<RemoteOperationObservation> {
    const command = remoteDispatchIntentV3Schema.parse(input);
    return this.withActiveClient((client) => client.dispatchRemoteOperation(command));
  }

  async observe(input: unknown): Promise<RemoteOperationObservation> {
    const { operationId } = collaborationRemoteOperationIdInputSchema.parse(input);
    return this.withActiveClient((client) => client.observeRemoteOperation(operationId));
  }

  async lookup(input: unknown): Promise<RemoteOperationObservation | null> {
    const query = collaborationRemoteOperationLookupInputSchema.parse(input);
    return this.withActiveClient((client) => client.lookupRemoteOperation(query));
  }

  async lookupWorkspace(input: unknown): Promise<RemoteOperationObservation | null> {
    const { locator, blockRef, operationId } =
      collaborationWorkspaceRemoteOperationLookupInputSchema.parse(input);
    const observation = await this.withWorkspaceClient(locator, (client) =>
      client.lookupRemoteOperation({
        canvasId: locator.canvasId,
        blockRef,
        ...(operationId ? { operationId } : {})
      })
    );
    return observation ? assertWorkspaceOperation(locator, blockRef, observation) : null;
  }

  async observeWorkspace(input: unknown): Promise<RemoteOperationObservation> {
    const { locator, blockRef, operationId } =
      collaborationWorkspaceRemoteOperationIdInputSchema.parse(input);
    const observation = await this.withWorkspaceClient(locator, (client) =>
      client.observeRemoteOperation(operationId)
    );
    return assertWorkspaceOperation(locator, blockRef, observation);
  }

  async replayWorkspaceEvents(input: unknown): Promise<RemoteEventReplay> {
    const { locator, blockRef, operationId, query } =
      collaborationWorkspaceRemoteEventReplayInputSchema.parse(input);
    return this.withWorkspaceClient(locator, async (client) => {
      const observation = await client.observeRemoteOperation(operationId);
      assertWorkspaceOperation(locator, blockRef, observation);
      return client.replayRemoteOperationEvents(operationId, query ?? {});
    });
  }

  async executeAction(input: unknown): Promise<RemoteActionView> {
    const { operationId, action } = collaborationRemoteActionInputSchema.parse(input);
    return this.withActiveClient((client) =>
      client.executeRemoteOperationAction(operationId, action)
    );
  }

  async replayEvents(input: unknown): Promise<RemoteEventReplay> {
    const parsed = z
      .object({
        operationId: opaqueIdentifierSchema,
        query: remoteEventQuerySchema.optional()
      })
      .strict()
      .parse(input);
    return this.withActiveClient((client) =>
      client.replayRemoteOperationEvents(parsed.operationId, parsed.query ?? {})
    );
  }

  async listInteractions(input: unknown): Promise<RemoteInteractionPage> {
    const parsed = z
      .object({
        operationId: opaqueIdentifierSchema,
        query: remoteInteractionPageQuerySchema.optional()
      })
      .strict()
      .parse(input);
    return this.withActiveClient((client) =>
      client.listRemoteOperationInteractions(parsed.operationId, parsed.query ?? {})
    );
  }

  async settleInteraction(input: unknown): Promise<RemoteInteractionView> {
    const { operationId, settlement } =
      collaborationRemoteInteractionRespondInputSchema.parse(input);
    return this.withActiveClient((client) =>
      client.settleRemoteOperationInteraction(operationId, settlement)
    );
  }
}

function assertWorkspaceOperation(
  locator: WorkspaceCanvasLocator,
  blockRef: string,
  observation: RemoteOperationObservation
): RemoteOperationObservation {
  if (
    observation.projectId !== locator.projectId ||
    observation.canvasId !== locator.canvasId ||
    observation.blockRef !== blockRef
  ) {
    throw new Error("workspace_remote_operation_authority_mismatch");
  }
  return observation;
}

export function requireActiveCollaborationClient(
  client: CollaborationRemoteOperationsPort | null,
  clientProfileId: string | null
): CollaborationRemoteOperationsPort {
  if (!client || !clientProfileId) {
    throw new CollaborationClientError({
      kind: "offline",
      code: "collaboration_session_inactive",
      message: "No active collaboration session. Connect a profile before loading read models.",
      retryable: false
    });
  }
  return client;
}
