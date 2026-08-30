import { canvasRuntimeAvailabilityV2Schema } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  remoteAgentEndpointListSchema,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  remoteDispatchIntentV3Schema,
  remoteEndpointOperationObservationSchema,
  remoteEventReplaySchema,
  remoteInteractionPageSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  remoteOperationObservationSchema
} from "@planweave-ai/collaboration-protocol/remote-run";
import { workAuthorityProjectionSchema } from "@planweave-ai/collaboration-protocol/work/authority";
import type {
  RemoteAgentCatalogPort,
  RemoteOperationCommandPort,
  RemoteOperationQueryPort,
  RemoteWorkspaceAuthoritySourcePort,
  WorkAuthorityPort,
  WorkspaceExecutionInteractionPort
} from "@planweave-ai/runtime";
import type { CliWorkspaceConnection } from "./connection.js";
import type { WorkspaceJsonTransport } from "./httpTransport.js";

function projectPath(projectId: string, suffix: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}${suffix}`;
}

function operationPath(projectId: string, operationId?: string): string {
  const base = projectPath(projectId, "/remote-operations");
  return operationId ? `${base}/${encodeURIComponent(operationId)}` : base;
}

export function createCliWorkspaceExecutionHttpPorts(input: {
  connection: CliWorkspaceConnection;
  transport: WorkspaceJsonTransport;
}): {
  authoritySource: RemoteWorkspaceAuthoritySourcePort;
  catalog: RemoteAgentCatalogPort;
  workAuthority: WorkAuthorityPort;
  command: RemoteOperationCommandPort;
  query: RemoteOperationQueryPort;
  interaction: WorkspaceExecutionInteractionPort;
  listAgentEndpoints(canvasId: string, signal?: AbortSignal): Promise<RemoteAgentEndpointList>;
} {
  const { connection, transport } = input;
  const getWorkAuthority = (blockRef: string, signal?: AbortSignal) => {
    const scope = { kind: "block" as const, blockRef };
    const query = new URLSearchParams({ scope: JSON.stringify(scope) });
    return transport.json(
      "GET",
      projectPath(connection.projectId, `/assignments/authority?${query}`),
      workAuthorityProjectionSchema,
      { signal }
    );
  };
  const listAgentEndpoints = (canvasId: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({
      canvasId,
      workspaceId: connection.workspaceId
    });
    return transport.json(
      "GET",
      projectPath(connection.projectId, `/agent-endpoints?${query}`),
      remoteAgentEndpointListSchema,
      { signal }
    );
  };
  const workAuthority: WorkAuthorityPort = {
    ensure: ({ binding }, signal) => getWorkAuthority(binding.blockRef, signal)
  };
  return {
    listAgentEndpoints,
    authoritySource: {
      async inspect(locator, blockRef, signal) {
        const authority = await getWorkAuthority(blockRef, signal);
        const availability = await transport.json(
          "GET",
          projectPath(
            connection.projectId,
            `/canvases/${encodeURIComponent(locator.canvasId)}/runtime-availability?view=canvas-runtime-view%2Fv2`
          ),
          canvasRuntimeAvailabilityV2Schema,
          { signal }
        );
        return {
          connectionProfileId: connection.profileId,
          serverOrigin: connection.serverOrigin,
          workspaceId: connection.workspaceId,
          projectId: connection.projectId,
          canvasId: locator.canvasId,
          blockRef,
          contentRevision: availability.authority.sourceRevision,
          graphFingerprint: availability.authority.graphFingerprint,
          authorityRevisions: authority.revisions
        };
      }
    },
    catalog: {
      list: ({ binding }, signal) => listAgentEndpoints(binding.canvasId, signal)
    },
    workAuthority,
    command: {
      dispatch: ({ binding, intent }, signal) =>
        transport.json(
          "POST",
          operationPath(binding.projectId),
          remoteEndpointOperationObservationSchema,
          { body: remoteDispatchIntentV3Schema.parse(intent), signal }
        )
    },
    query: {
      recover: ({ binding, idempotencyKey }, signal) => {
        const query = new URLSearchParams({
          canvasId: binding.canvasId,
          blockRef: binding.blockRef,
          idempotencyKey
        });
        return transport.json(
          "GET",
          `${operationPath(binding.projectId)}?${query}`,
          remoteOperationObservationSchema.nullable(),
          { signal }
        );
      },
      observe: ({ binding, operationId }, signal) =>
        transport.json(
          "GET",
          operationPath(binding.projectId, operationId),
          remoteOperationObservationSchema,
          { signal }
        ),
      replay: ({ binding, operationId, afterCursor }, signal) => {
        const query = new URLSearchParams({ afterCursor: String(afterCursor) });
        return transport.json(
          "GET",
          `${operationPath(binding.projectId, operationId)}/events?${query}`,
          remoteEventReplaySchema,
          { signal }
        );
      },
      interactions: ({ binding, operationId, cursor }, signal) => {
        const query = new URLSearchParams({ cursor: String(cursor), limit: "50" });
        return transport.json(
          "GET",
          `${operationPath(binding.projectId, operationId)}/interactions?${query}`,
          remoteInteractionPageSchema,
          { signal }
        );
      }
    },
    interaction: {
      respond: ({ binding, operationId, response }, signal) =>
        transport.json(
          "POST",
          `${operationPath(binding.projectId, operationId)}/interactions/respond`,
          remoteInteractionViewSchema,
          { body: remoteInteractionResponseSchema.parse(response), signal }
        )
    }
  };
}
