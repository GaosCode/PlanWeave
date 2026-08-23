import { type CanvasAccessRecord } from "@planweave-ai/collaboration-protocol/access/project";
import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  canvasRuntimeResetRequestSchema,
  type CanvasRuntimeResetOutcome,
  type CanvasRuntimeResetRequest
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import { getProjectOverview, listProjects } from "@planweave-ai/runtime";
import {
  collaborationCanvasBindingInputSchema,
  collaborationCanvasScopeResolutionSchema,
  type CollaborationCanvasScopeResolution,
  type RemoteCollaborationCanvasBindingInput
} from "../../shared/collaboration.js";
import {
  type WorkspaceCanvasRuntimeResetRequest,
  workspaceCanvasRuntimeResetRequestSchema
} from "../../shared/collaborationRuntimeAvailability.js";
import {
  workspaceCanvasSharingCandidateSchema,
  type WorkspaceCanvasSharingCandidate,
  type WorkspaceCanvasSharingState
} from "../../shared/workspaceCanvasSharing.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import {
  WorkspaceCanvasPublishReceiptStore,
  type WorkspaceCanvasPublishReceipt,
  type WorkspaceCanvasPublishReceiptStorePort
} from "./WorkspaceCanvasPublishReceiptStore.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import {
  downloadWorkspaceCanvasFork,
  localProjectHasWorkspaceForkLineage
} from "./workspaceCanvasDownload.js";
import {
  publishLocalCanvasToWorkspace,
  type CommittedWorkspaceCanvasPublish
} from "./workspaceCanvasPublish.js";
import { workspaceRemoteAuthorityId } from "./WorkspaceRemoteAuthorityIdentity.js";

export type ResolvedCollaborationCanvasBinding = RemoteCollaborationCanvasBindingInput & {
  remoteProjectId: string;
  remoteCanvasId: string;
};

function unavailable(code: string, retryable = false): CollaborationClientError {
  return new CollaborationClientError({ kind: "unknown", code, message: code, retryable });
}

function sharingState(
  visibility: CanvasAccessRecord["visibility"],
  published: boolean
): WorkspaceCanvasSharingState {
  if (!published) return "registered_unpublished";
  return visibility === "shared" ? "published_shared" : "published_private";
}

/**
 * Main-only Workspace authority operations. Local Canvas is accepted only by the explicit
 * publish/download use cases; remote reads and Runtime operations require a remote binding.
 */
export class ContentVersionFacade {
  constructor(
    private readonly resolveClient: () => CollaborationClient | null,
    private readonly publishReceipts: WorkspaceCanvasPublishReceiptStorePort = new WorkspaceCanvasPublishReceiptStore()
  ) {}

  async resolveCanvasBinding(input: unknown): Promise<ResolvedCollaborationCanvasBinding | null> {
    const requested = this.requireRemoteBinding(input);
    const client = this.resolveClient();
    if (!client || requested.projectId !== client.projectId) return null;
    const canvas = await this.authorizeRemoteCanvas(client, requested);
    return {
      ...requested,
      remoteProjectId: canvas.registry.projectId,
      remoteCanvasId: canvas.registry.canvasId
    };
  }

  async resolveCanvasScope(input: unknown): Promise<CollaborationCanvasScopeResolution | null> {
    const requested = this.requireRemoteBinding(input);
    const client = this.resolveClient();
    if (!client || requested.projectId !== client.projectId) return null;
    const canvas = await this.authorizeRemoteCanvas(client, requested);
    return collaborationCanvasScopeResolutionSchema.parse({
      workspaceId: canvas.registry.workspaceId,
      projectId: canvas.registry.projectId,
      canvasId: canvas.registry.canvasId
    });
  }

  /** Public authority fingerprint for remote projection scope keys. */
  authorityIdForClient(client: CollaborationClient = this.requireClient()): string {
    const profile = client.connectionProfile;
    return workspaceRemoteAuthorityId({
      connectionProfileId: profile.profileId,
      serverOrigin: this.serverOrigin(client),
      projectId: client.projectId
    });
  }

  async readRuntimeAvailability(input: unknown): Promise<CanvasRuntimeAvailability | null> {
    const requested = this.requireRemoteBinding(input);
    const client = this.requireClient();
    const scope = await this.resolveCanvasScope(requested);
    if (!scope) return null;
    const availability = await client.readRuntimeAvailability(scope.canvasId);
    const statuses = [
      availability.state.kind === "initialized" ? availability.state.status : null,
      availability.execution.kind === "available" ? availability.execution.status : null
    ];
    for (const status of statuses) {
      if (
        status &&
        (status.scope.workspaceId !== scope.workspaceId ||
          status.scope.projectId !== scope.projectId ||
          status.scope.canvasId !== scope.canvasId)
      ) {
        throw unavailable("runtime_availability_scope_mismatch", false);
      }
    }
    return availability;
  }

  async resetRuntime(
    input: unknown,
    request: WorkspaceCanvasRuntimeResetRequest
  ): Promise<CanvasRuntimeResetOutcome> {
    const requested = this.requireRemoteBinding(input);
    const client = this.requireClient();
    const scope = await this.resolveCanvasScope(requested);
    if (!scope) throw unavailable("runtime_status_scope_unavailable", false);
    const head = await client.fetchContentHead(scope.canvasId);
    if (!head) throw unavailable("content_authoritative_head_unavailable", false);
    this.assertRemoteScope(head.scope, requested);
    const parsed = workspaceCanvasRuntimeResetRequestSchema.parse(request);
    const protocolRequest: CanvasRuntimeResetRequest = {
      ...parsed,
      expectedContentRevision: head.revision
    };
    return client.resetRuntime(
      scope.canvasId,
      canvasRuntimeResetRequestSchema.parse(protocolRequest)
    );
  }

  async listWorkspaceCanvasSharingCandidates(): Promise<WorkspaceCanvasSharingCandidate[]> {
    const client = this.requireClient();
    const [localProjects, registeredCanvases] = await Promise.all([
      listProjects(),
      this.listAuthorizedCanvases(client)
    ]);
    const registeredByCanvasId = new Map(
      registeredCanvases
        .filter((canvas) => canvas.registry.projectId === client.projectId)
        .map((canvas) => [canvas.registry.canvasId, canvas] as const)
    );
    const candidates: WorkspaceCanvasSharingCandidate[] = [];
    for (const project of localProjects) {
      const overview = await getProjectOverview(project.rootPath);
      if (await localProjectHasWorkspaceForkLineage(overview.rootPath)) continue;
      for (const canvas of overview.taskCanvases) {
        const receipt = await this.publishReceipts.find({
          serverOrigin: this.serverOrigin(client),
          projectId: client.projectId,
          localProjectId: overview.projectId,
          localCanvasId: canvas.canvasId
        });
        const registeredRecord =
          receipt?.status === "committed"
            ? (registeredByCanvasId.get(receipt.canvasId) ?? null)
            : overview.projectId === client.projectId
              ? (registeredByCanvasId.get(canvas.canvasId) ?? null)
              : null;
        candidates.push(
          await this.workspaceCanvasSharingCandidate(
            client,
            overview.projectId,
            overview.name,
            canvas.canvasId,
            canvas.name,
            registeredRecord,
            receipt?.status === "committed" ? receipt : null
          )
        );
      }
    }
    return candidates.sort(
      (left, right) =>
        left.projectName.localeCompare(right.projectName) ||
        left.canvasName.localeCompare(right.canvasName)
    );
  }

  async publishWorkspaceCanvas(input: unknown): Promise<CommittedWorkspaceCanvasPublish> {
    return publishLocalCanvasToWorkspace({
      client: this.requireClient(),
      rawInput: input,
      receipts: this.publishReceipts
    });
  }

  async downloadWorkspaceCanvasFork(input: unknown) {
    return downloadWorkspaceCanvasFork({
      client: this.requireClient(),
      rawInput: input
    });
  }

  private requireRemoteBinding(input: unknown): RemoteCollaborationCanvasBindingInput {
    const requested = collaborationCanvasBindingInputSchema.parse(input);
    if (requested.kind !== "remote") {
      throw unavailable("workspace_canvas_remote_binding_required", false);
    }
    return requested;
  }

  private requireClient(): CollaborationClient {
    const client = this.resolveClient();
    if (!client) throw unavailable("collaboration_content_offline", true);
    return client;
  }

  private serverOrigin(client: CollaborationClient): string {
    return new URL(client.connectionProfile.serverBaseUrl).origin;
  }

  private assertRemoteScope(
    actual: { workspaceId: string; projectId: string; canvasId: string },
    expected: RemoteCollaborationCanvasBindingInput
  ): void {
    if (
      actual.workspaceId !== expected.workspaceId ||
      actual.projectId !== expected.projectId ||
      actual.canvasId !== expected.canvasId
    ) {
      throw unavailable("content_authoritative_scope_mismatch", false);
    }
  }

  private async listAuthorizedCanvases(client: CollaborationClient): Promise<CanvasAccessRecord[]> {
    const items: CanvasAccessRecord[] = [];
    const cursors = new Set<number>();
    let cursor = 0;
    while (true) {
      if (cursors.has(cursor)) throw unavailable("content_registry_pagination_invalid", false);
      cursors.add(cursor);
      const page = await client.registry().listCanvases({
        projectId: client.projectId,
        cursor,
        limit: 100
      });
      items.push(...page.items);
      if (page.nextCursor === null) return items;
      cursor = page.nextCursor;
    }
  }

  private async workspaceCanvasSharingCandidate(
    client: CollaborationClient,
    localProjectId: string,
    projectName: string,
    canvasId: string,
    canvasName: string,
    registered: CanvasAccessRecord | null,
    receipt: Extract<WorkspaceCanvasPublishReceipt, { status: "committed" }> | null
  ): Promise<WorkspaceCanvasSharingCandidate> {
    const serverCanvasId = registered?.registry.canvasId ?? receipt?.canvasId ?? null;
    const visibility = registered?.visibility ?? receipt?.visibility ?? null;
    if (serverCanvasId === null || visibility === null) {
      return workspaceCanvasSharingCandidateSchema.parse({
        localProjectId,
        projectName,
        canvasId,
        canvasName,
        state: "local_only",
        workspaceCanvasId: null,
        visibility: null
      });
    }
    const head = await client.fetchContentHead(serverCanvasId);
    return workspaceCanvasSharingCandidateSchema.parse({
      localProjectId,
      projectName,
      canvasId,
      canvasName,
      state: sharingState(visibility, head !== null),
      workspaceCanvasId: serverCanvasId,
      visibility
    });
  }

  private async authorizeRemoteCanvas(
    client: CollaborationClient,
    requested: RemoteCollaborationCanvasBindingInput
  ): Promise<CanvasAccessRecord> {
    if (requested.projectId !== client.projectId) {
      throw unavailable("content_remote_project_profile_mismatch", false);
    }
    const matches = (await this.listAuthorizedCanvases(client)).filter(
      (candidate) =>
        candidate.registry.workspaceId === requested.workspaceId &&
        candidate.registry.projectId === requested.projectId &&
        candidate.registry.canvasId === requested.canvasId
    );
    if (matches.length > 1) throw unavailable("content_remote_canvas_scope_ambiguous", false);
    const canvas = matches[0];
    if (!canvas) throw unavailable("content_remote_canvas_not_authorized", false);
    return canvas;
  }
}
