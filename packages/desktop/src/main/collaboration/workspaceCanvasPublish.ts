import { randomUUID } from "node:crypto";
import {
  captureAuthorizedCanvasContent,
  getProjectOverview,
  listProjects,
  resolveTaskCanvasWorkspace
} from "@planweave-ai/runtime";
import { workspaceCanvasLocatorSchema } from "../../shared/canvasLocator.js";
import {
  workspaceCanvasPublishInputSchema,
  workspaceCanvasPublishResultSchema,
  workspaceCanvasSharingCandidateSchema,
  type WorkspaceCanvasPublishResult,
  type WorkspaceCanvasSharingCandidate
} from "../../shared/workspaceCanvasSharing.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { WorkspaceCanvasPublishReceiptStorePort } from "./WorkspaceCanvasPublishReceiptStore.js";

function unavailable(code: string, retryable = false): CollaborationClientError {
  return new CollaborationClientError({ kind: "unknown", code, message: code, retryable });
}

function serverOrigin(client: CollaborationClient): string {
  return new URL(client.connectionProfile.serverBaseUrl).origin;
}

export type CommittedWorkspaceCanvasPublish = Omit<WorkspaceCanvasPublishResult, "authoritySwitch">;

export async function publishLocalCanvasToWorkspace(input: {
  client: CollaborationClient;
  rawInput: unknown;
  receipts: WorkspaceCanvasPublishReceiptStorePort;
}): Promise<CommittedWorkspaceCanvasPublish> {
  const requested = workspaceCanvasPublishInputSchema.parse(input.rawInput);
  const receiptKey = {
    serverOrigin: serverOrigin(input.client),
    projectId: input.client.projectId,
    localProjectId: requested.localProjectId,
    localCanvasId: requested.canvasId
  };
  const existing = await input.receipts.find(receiptKey);
  if (existing?.status === "adopted") {
    throw unavailable("content_workspace_publish_source_already_adopted", false);
  }
  const remembered = await input.receipts.rememberPending({
    ...receiptKey,
    operationId: requested.operationId ?? existing?.operationId ?? `publish-${randomUUID()}`
  });
  if (remembered.status === "adopted") {
    throw unavailable("content_workspace_publish_source_already_adopted", false);
  }
  const operationId = remembered.operationId;
  const projects = (await listProjects()).filter(
    (project) => project.projectId === requested.localProjectId
  );
  if (projects.length !== 1) throw unavailable("content_local_project_binding_invalid", false);
  const overview = await getProjectOverview(projects[0]!.rootPath);
  const canvas = overview.taskCanvases.find(
    (candidate) => candidate.canvasId === requested.canvasId
  );
  if (!canvas) throw unavailable("content_local_canvas_binding_invalid", false);
  const workspace = await resolveTaskCanvasWorkspace(overview.rootPath, requested.canvasId);
  const captured = await captureAuthorizedCanvasContent({
    projectRoot: overview.rootPath,
    canvasId: requested.canvasId,
    expectedPackageDir: workspace.packageDir,
    authorityProjectId: input.client.projectId
  });
  const published = await input.client.publishWorkspaceCanvas({
    operationId,
    localSource: {
      localProjectId: requested.localProjectId,
      localCanvasId: requested.canvasId
    },
    content: captured.content
  });
  if (published.outcome === "rejected") {
    throw unavailable(`content_workspace_publish_${published.reason}`, published.retryable);
  }
  try {
    await input.receipts.commit({
      ...receiptKey,
      operationId: published.operationId,
      recoveryToken: published.recoveryToken,
      workspaceId: published.scope.workspaceId,
      canvasId: published.scope.canvasId,
      visibility: published.visibility
    });
  } catch (error) {
    // Server already committed; the returned locator is the recovery handle.
    console.error("Failed to persist workspace canvas publish receipt.", error);
  }
  const locator = workspaceCanvasLocatorSchema.parse({
    kind: "workspace",
    connectionProfileId: input.client.connectionProfile.profileId,
    workspaceId: published.scope.workspaceId,
    projectId: published.scope.projectId,
    canvasId: published.scope.canvasId
  });
  const candidateBase = {
    localProjectId: overview.projectId,
    projectName: overview.name,
    canvasId: canvas.canvasId,
    canvasName: canvas.name,
    workspaceCanvasId: published.scope.canvasId
  };
  const candidate = workspaceCanvasSharingCandidateSchema.parse(
    published.visibility === "shared"
      ? { ...candidateBase, state: "published_shared", visibility: "shared" }
      : { ...candidateBase, state: "published_private", visibility: "private" }
  ) satisfies WorkspaceCanvasSharingCandidate;
  return workspaceCanvasPublishResultSchema.omit({ authoritySwitch: true }).parse({
    outcome: published.outcome,
    operationId: published.operationId,
    recoveryToken: published.recoveryToken,
    locator,
    revision: published.revision,
    content: published.content,
    visibility: published.visibility,
    localSourceRetained: true,
    candidate
  });
}
