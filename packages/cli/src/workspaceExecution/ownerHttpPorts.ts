import { createHash } from "node:crypto";
import {
  OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
  OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER,
  OUTPUT_MAX_ARTIFACT_BYTES,
  operatorOwnerTerminalResultMetadataSchema,
  type OperatorOwnerTerminalResultPayload
} from "@planweave-ai/agent-host-protocol";
import {
  ownerCanvasMaterializationHeadViewSchema,
  ownerCanvasMaterializationRequestMetadataSchema,
  ownerCanvasMaterializationResultSchema,
  ownerCanvasMaterializationScopeSchema,
  ownerCanvasMaterializationUploadCompleteFrameSchema,
  ownerCanvasMaterializationUploadHeaderFrameSchema,
  ownerCanvasMaterializationUploadLimits,
  ownerCanvasMaterializationUploadMediaType,
  ownerCanvasMaterializationUploadMemberFrameSchema,
  type OwnerCanvasMaterializationRequest,
  type OwnerCanvasMaterializationScope
} from "@planweave-ai/collaboration-protocol/owner-canvas/materialization";
import { remoteAgentEndpointListSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { humanPrincipalIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE,
  remoteDispatchIntentV3Schema,
  remoteEndpointOperationObservationSchema,
  remoteEventReplaySchema,
  remoteInteractionPageSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  remoteOperationObservationSchema
} from "@planweave-ai/collaboration-protocol/remote-run";
import {
  isOwnerCanvasRemoteAuthorityBinding,
  type RemoteAgentCatalogPort,
  type RemoteOperationCommandPort,
  type RemoteOperationQueryPort,
  type RemoteWorkspaceAuthorityBinding,
  type ValidatedWorkspaceAuthorityBinding,
  type WorkAuthorityPort,
  type WorkspaceExecutionInteractionPort
} from "@planweave-ai/runtime";
import { WorkspaceExecutionCliError } from "./errors.js";
import type { WorkspaceJsonTransport } from "./httpTransport.js";
import type { CliOwnerCredentials } from "./ownerConnection.js";

function requireOwnerBinding(
  binding: ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding
) {
  if (!isOwnerCanvasRemoteAuthorityBinding(binding)) {
    throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  }
  return binding;
}

function operationPath(operationId?: string): string {
  const base = "/api/v1/remote-operations";
  return operationId ? `${base}/${encodeURIComponent(operationId)}` : base;
}

export function ownerCanvasMaterializationIntentId(
  canonicalDigest: string,
  expectedHead: unknown
): string {
  const headDigest = createHash("sha256").update(JSON.stringify(expectedHead)).digest("hex");
  return `content:${canonicalDigest}:head:${headDigest}`;
}

const OWNER_TERMINAL_RESULT_METADATA_MAX_BYTES = 64 * 1024;

export type OwnerTerminalResult = OperatorOwnerTerminalResultPayload;

export function createCliOwnerCanvasExecutionHttpPorts(input: {
  transport: WorkspaceJsonTransport;
  credentials: CliOwnerCredentials;
}): {
  catalog: RemoteAgentCatalogPort;
  workAuthority: WorkAuthorityPort;
  command: RemoteOperationCommandPort;
  query: RemoteOperationQueryPort;
  interaction: WorkspaceExecutionInteractionPort;
  listAgentEndpoints(
    query: { projectId: string; canvasId: string },
    signal?: AbortSignal
  ): Promise<ReturnType<typeof remoteAgentEndpointListSchema.parse>>;
  inspectMaterializationHead(
    scope: OwnerCanvasMaterializationScope,
    signal?: AbortSignal
  ): Promise<ReturnType<typeof ownerCanvasMaterializationHeadViewSchema.parse>>;
  materialize(
    request: OwnerCanvasMaterializationRequest,
    signal?: AbortSignal
  ): Promise<ReturnType<typeof ownerCanvasMaterializationResultSchema.parse>>;
  readTerminalResult(operationId: string, signal?: AbortSignal): Promise<OwnerTerminalResult>;
} {
  const { transport, credentials } = input;
  const humanPrincipalId = humanPrincipalIdSchema.parse(credentials.humanPrincipalId);
  const listAgentEndpoints = (
    query: { projectId: string; canvasId: string },
    signal?: AbortSignal
  ) => {
    const params = new URLSearchParams({
      projectId: query.projectId,
      humanPrincipalId,
      canvasId: query.canvasId
    });
    return transport.json(
      "GET",
      `/api/v1/agent-endpoints?${params}`,
      remoteAgentEndpointListSchema,
      { signal }
    );
  };
  const workAuthority: WorkAuthorityPort = {
    ensure: async ({ binding }) => {
      requireOwnerBinding(binding);
      return null;
    }
  };
  return {
    listAgentEndpoints,
    inspectMaterializationHead: (scope, signal) => {
      const parsed = ownerCanvasMaterializationScopeSchema.parse(scope);
      const params = new URLSearchParams({
        ownerHumanPrincipalId: parsed.ownerHumanPrincipalId,
        projectId: parsed.projectId,
        canvasId: parsed.canvasId
      });
      return transport.json(
        "GET",
        `/api/v1/owner-canvas-materializations/head?${params}`,
        ownerCanvasMaterializationHeadViewSchema,
        { signal }
      );
    },
    materialize: (request, signal) => {
      const metadata = ownerCanvasMaterializationRequestMetadataSchema.parse({
        schemaVersion: request.schemaVersion,
        materializationId: request.materializationId,
        scope: request.scope,
        expectedHead: request.expectedHead
      });
      const lines = [
        JSON.stringify(
          ownerCanvasMaterializationUploadHeaderFrameSchema.parse({
            type: "header",
            request: metadata
          })
        ),
        ...request.content.members.map((member, index) =>
          JSON.stringify(
            ownerCanvasMaterializationUploadMemberFrameSchema.parse({
              type: "member",
              index,
              member
            })
          )
        ),
        JSON.stringify(
          ownerCanvasMaterializationUploadCompleteFrameSchema.parse({
            type: "complete",
            canonicalDigest: request.content.canonicalDigest,
            totalBytes: request.content.totalBytes,
            memberCount: request.content.members.length
          })
        )
      ];
      if (
        lines.some(
          (line) =>
            Buffer.byteLength(line, "utf8") > ownerCanvasMaterializationUploadLimits.maxFrameBytes
        )
      ) {
        throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
      }
      const body = `${lines.join("\n")}\n`;
      if (Buffer.byteLength(body, "utf8") > ownerCanvasMaterializationUploadLimits.maxWireBytes) {
        throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
      }
      return transport.json(
        "POST",
        "/api/v1/owner-canvas-materializations",
        ownerCanvasMaterializationResultSchema,
        {
          rawBody: body,
          contentType: ownerCanvasMaterializationUploadMediaType,
          signal
        }
      );
    },
    catalog: {
      list: ({ binding }, signal) => {
        const owner = requireOwnerBinding(binding);
        return listAgentEndpoints({ projectId: owner.projectId, canvasId: owner.canvasId }, signal);
      }
    },
    workAuthority,
    command: {
      dispatch: ({ binding, intent }, signal) => {
        const owner = requireOwnerBinding(binding);
        return transport.json("POST", operationPath(), remoteEndpointOperationObservationSchema, {
          body: {
            ...remoteDispatchIntentV3Schema.parse(intent),
            humanPrincipalId: owner.humanPrincipalId
          },
          accept: OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE,
          signal
        });
      }
    },
    query: {
      recover: async ({ binding }) => {
        requireOwnerBinding(binding);
        return null;
      },
      observe: ({ binding, operationId }, signal) => {
        requireOwnerBinding(binding);
        return transport.json("GET", operationPath(operationId), remoteOperationObservationSchema, {
          accept: OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE,
          signal
        });
      },
      replay: ({ binding, operationId, afterCursor }, signal) => {
        requireOwnerBinding(binding);
        const query = new URLSearchParams({ afterCursor: String(afterCursor) });
        return transport.json(
          "GET",
          `${operationPath(operationId)}/events?${query}`,
          remoteEventReplaySchema,
          { signal }
        );
      },
      interactions: ({ binding, operationId, cursor }, signal) => {
        requireOwnerBinding(binding);
        const query = new URLSearchParams({ cursor: String(cursor), limit: "50" });
        return transport.json(
          "GET",
          `${operationPath(operationId)}/interactions?${query}`,
          remoteInteractionPageSchema,
          { signal }
        );
      }
    },
    interaction: {
      respond: ({ binding, operationId, response }, signal) => {
        requireOwnerBinding(binding);
        return transport.json(
          "POST",
          `${operationPath(operationId)}/interactions/respond`,
          remoteInteractionViewSchema,
          { body: remoteInteractionResponseSchema.parse(response), signal }
        );
      }
    },
    async readTerminalResult(operationId, signal) {
      const { headers, body } = await transport.bytes(
        "GET",
        `${operationPath(operationId)}/terminal-result`,
        {
          accept: OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
          maxBytes: OUTPUT_MAX_ARTIFACT_BYTES,
          signal
        }
      );
      const mediaType = headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (mediaType !== OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE) {
        throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true);
      }
      const encodedMetadata = headers.get(OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER);
      if (
        !encodedMetadata ||
        encodedMetadata.length > OWNER_TERMINAL_RESULT_METADATA_MAX_BYTES * 2 ||
        !/^[A-Za-z0-9_-]+$/.test(encodedMetadata)
      ) {
        throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true);
      }
      let metadata: OwnerTerminalResult["metadata"];
      try {
        const metadataBytes = Buffer.from(encodedMetadata, "base64url");
        if (metadataBytes.byteLength > OWNER_TERMINAL_RESULT_METADATA_MAX_BYTES) {
          throw new Error("owner_terminal_result_metadata_too_large");
        }
        metadata = operatorOwnerTerminalResultMetadataSchema.parse(
          JSON.parse(metadataBytes.toString("utf8"))
        );
      } catch {
        throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true);
      }
      if (body.byteLength === 0) {
        throw new WorkspaceExecutionCliError("workspace_http_invalid_response", 9, true);
      }
      return { metadata, reportBytes: body };
    }
  };
}
