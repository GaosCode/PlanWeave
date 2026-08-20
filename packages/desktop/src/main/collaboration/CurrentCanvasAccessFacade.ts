import type {
  AccessMutationRequest,
  AccessMutationResult,
  AccessScope,
  CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import {
  assertNoSmuggledCollaborationSecrets,
  collaborationAccessMutationInputSchema,
  collaborationCurrentCanvasAccessInputSchema
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";

type WorkspaceConnectionView = {
  status: string;
  workspaceId: string | null;
  profile: { serverBaseUrl: string } | null;
};

export type CurrentCanvasAccessFacadeOptions = {
  ensureWorkspaceHydrated: () => Promise<void>;
  buildWorkspaceConnectionView: () => Promise<WorkspaceConnectionView>;
  withActiveClient: <T>(operation: (client: CollaborationClient) => Promise<T>) => Promise<T>;
};

/** Enforces that access reads and mutations stay inside the active Workspace canvas scope. */
export class CurrentCanvasAccessFacade {
  constructor(private readonly options: CurrentCanvasAccessFacadeOptions) {}

  async get(input: unknown): Promise<CurrentCanvasAccessView> {
    assertNoSmuggledCollaborationSecrets(input, "getCurrentCanvasAccess");
    const parsed = collaborationCurrentCanvasAccessInputSchema.parse(input);
    return (await this.context(parsed.canvasId)).view;
  }

  async mutate(input: unknown): Promise<AccessMutationResult> {
    assertNoSmuggledCollaborationSecrets(input, "mutateCurrentCanvasAccess");
    const mutation = collaborationAccessMutationInputSchema.parse(input);
    const { scope } = await this.context(mutation.canvasId);
    const request = mutation.request;
    if (
      request.scope.workspaceId !== scope.workspaceId ||
      request.scope.projectId !== scope.projectId ||
      (request.scope.scopeKind === "canvas" && request.scope.canvasId !== scope.canvasId)
    ) {
      throw scopeMismatch("The requested access scope does not match the active Workspace canvas.");
    }
    const canonicalScope: AccessScope =
      request.scope.scopeKind === "canvas"
        ? scope
        : {
            scopeKind: "project",
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            canvasId: null
          };
    const scopedRequest: AccessMutationRequest = { ...request, scope: canonicalScope };
    return this.options.withActiveClient((client) =>
      client.mutateCurrentCanvasAccess({ canvasId: scope.canvasId, request: scopedRequest })
    );
  }

  private async context(canvasId: string): Promise<{
    scope: Extract<AccessScope, { scopeKind: "canvas" }>;
    view: CurrentCanvasAccessView;
  }> {
    await this.options.ensureWorkspaceHydrated();
    const connection = await this.options.buildWorkspaceConnectionView();
    return this.options.withActiveClient(async (client) => {
      if (
        connection.status === "connected" &&
        connection.profile?.serverBaseUrl !== client.connectionProfile.serverBaseUrl
      ) {
        throw new CollaborationClientError({
          kind: "forbidden",
          code: "collaboration_workspace_connection_mismatch",
          message:
            "The active Workspace connection does not authorize the active collaboration project."
        });
      }
      const view = await client.getCurrentCanvasAccess(canvasId);
      const scope = view.scope;
      if (
        scope.projectId !== client.projectId ||
        scope.canvasId !== canvasId ||
        (connection.status === "connected" && connection.workspaceId !== scope.workspaceId)
      ) {
        throw scopeMismatch("The Server returned access data for a different Workspace canvas.");
      }
      assertViewScope(view, scope);
      return { scope, view };
    });
  }
}

function assertViewScope(
  view: CurrentCanvasAccessView,
  scope: Extract<AccessScope, { scopeKind: "canvas" }>
): void {
  if (
    view.scope.workspaceId !== scope.workspaceId ||
    view.scope.projectId !== scope.projectId ||
    view.scope.canvasId !== scope.canvasId
  ) {
    throw scopeMismatch("The Server returned access data for a different Workspace canvas.");
  }
}

function scopeMismatch(message: string): CollaborationClientError {
  return new CollaborationClientError({
    kind: "forbidden",
    code: "collaboration_access_scope_mismatch",
    message
  });
}
