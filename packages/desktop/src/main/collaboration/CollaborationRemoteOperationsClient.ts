import {
  remoteActionViewSchema,
  remoteDispatchIntentV3Schema,
  remoteEventQuerySchema,
  remoteEventReplaySchema,
  remoteHumanExecutionActionCommandSchema,
  remoteInteractionPageQuerySchema,
  remoteInteractionPageSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  remoteEndpointOperationObservationSchema,
  remoteOperationLookupQuerySchema,
  remoteOperationObservationSchema,
  type RemoteActionView,
  type RemoteDispatchIntentV3,
  type RemoteEventReplay,
  type RemoteHumanExecutionActionCommand,
  type RemoteInteractionPage,
  type RemoteInteractionResponse,
  type RemoteInteractionView,
  type RemoteOperationLookupQuery,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import {
  remoteAgentEndpointListSchema,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import type { z, ZodType } from "zod";
import type { JsonMethod } from "./collaborationHttpTransport.js";
import type { CollaborationListAgentEndpointsInput } from "../../shared/collaboration.js";

export interface CollaborationRemoteOperationsTransportPort {
  json<T>(
    method: JsonMethod,
    path: string,
    schema: ZodType<T>,
    options: { body?: unknown; signal?: AbortSignal }
  ): Promise<T>;
}

export interface CollaborationRemoteOperationsPort {
  listAgentEndpoints(
    query?: CollaborationListAgentEndpointsInput,
    signal?: AbortSignal
  ): Promise<RemoteAgentEndpointList>;
  dispatchRemoteOperation(
    command: RemoteDispatchIntentV3,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation>;
  observeRemoteOperation(
    operationId: string,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation>;
  lookupRemoteOperation(
    query: RemoteOperationLookupQuery,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation | null>;
  executeRemoteOperationAction(
    operationId: string,
    action: RemoteHumanExecutionActionCommand,
    signal?: AbortSignal
  ): Promise<RemoteActionView>;
  replayRemoteOperationEvents(
    operationId: string,
    query?: z.input<typeof remoteEventQuerySchema>,
    signal?: AbortSignal
  ): Promise<RemoteEventReplay>;
  listRemoteOperationInteractions(
    operationId: string,
    query?: z.input<typeof remoteInteractionPageQuerySchema>,
    signal?: AbortSignal
  ): Promise<RemoteInteractionPage>;
  settleRemoteOperationInteraction(
    operationId: string,
    settlement: RemoteInteractionResponse,
    signal?: AbortSignal
  ): Promise<RemoteInteractionView>;
}

export class CollaborationRemoteOperationsClient implements CollaborationRemoteOperationsPort {
  constructor(
    private readonly projectId: string,
    private readonly transport: CollaborationRemoteOperationsTransportPort
  ) {}

  listAgentEndpoints(
    query?: CollaborationListAgentEndpointsInput,
    signal?: AbortSignal
  ): Promise<RemoteAgentEndpointList> {
    if (query?.projectId !== undefined && query.projectId !== this.projectId) {
      throw new Error("collaboration_project_scope_mismatch");
    }
    const params = new URLSearchParams();
    if (query?.canvasId) params.set("canvasId", query.canvasId);
    if (query?.workspaceId) params.set("workspaceId", query.workspaceId);
    if (query?.humanPrincipalId) params.set("humanPrincipalId", query.humanPrincipalId);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/agent-endpoints${suffix}`,
      remoteAgentEndpointListSchema,
      { signal }
    );
  }

  dispatchRemoteOperation(
    command: RemoteDispatchIntentV3,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation> {
    const body = remoteDispatchIntentV3Schema.parse(command);
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations`,
      remoteEndpointOperationObservationSchema,
      { body, signal }
    );
  }

  observeRemoteOperation(
    operationId: string,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation> {
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}`,
      remoteOperationObservationSchema,
      { signal }
    );
  }

  lookupRemoteOperation(
    query: RemoteOperationLookupQuery,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation | null> {
    const parsed = remoteOperationLookupQuerySchema.parse(query);
    if (!parsed.canvasId || !parsed.blockRef) {
      throw new Error("remote_operation_lookup_scope_required");
    }
    const params = new URLSearchParams({ canvasId: parsed.canvasId, blockRef: parsed.blockRef });
    if (parsed.operationId) params.set("operationId", parsed.operationId);
    if (parsed.idempotencyKey) params.set("idempotencyKey", parsed.idempotencyKey);
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations?${params}`,
      remoteOperationObservationSchema.nullable(),
      { signal }
    );
  }

  executeRemoteOperationAction(
    operationId: string,
    action: RemoteHumanExecutionActionCommand,
    signal?: AbortSignal
  ): Promise<RemoteActionView> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}/actions`,
      remoteActionViewSchema,
      { body: remoteHumanExecutionActionCommandSchema.parse(action), signal }
    );
  }

  replayRemoteOperationEvents(
    operationId: string,
    query: z.input<typeof remoteEventQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<RemoteEventReplay> {
    const parsed = remoteEventQuerySchema.parse(query);
    const params = new URLSearchParams({ afterCursor: String(parsed.afterCursor) });
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}/events?${params}`,
      remoteEventReplaySchema,
      { signal }
    );
  }

  listRemoteOperationInteractions(
    operationId: string,
    query: z.input<typeof remoteInteractionPageQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<RemoteInteractionPage> {
    const parsed = remoteInteractionPageQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(parsed.cursor),
      limit: String(parsed.limit)
    });
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}/interactions?${params}`,
      remoteInteractionPageSchema,
      { signal }
    );
  }

  settleRemoteOperationInteraction(
    operationId: string,
    settlement: RemoteInteractionResponse,
    signal?: AbortSignal
  ): Promise<RemoteInteractionView> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}/interactions/respond`,
      remoteInteractionViewSchema,
      { body: remoteInteractionResponseSchema.parse(settlement), signal }
    );
  }
}
