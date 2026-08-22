import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createManagedProjectFromAuthoritativeContent,
  workspaceForkLineagePath,
  workspaceForkLineageSchema
} from "@planweave-ai/runtime";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { localCanvasLocatorSchema } from "../../shared/canvasLocator.js";
import {
  workspaceCanvasDownloadInputSchema,
  workspaceCanvasDownloadResultSchema,
  type WorkspaceCanvasDownloadResult
} from "../../shared/workspaceCanvasSharing.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";

function unavailable(code: string, retryable = false): CollaborationClientError {
  return new CollaborationClientError({ kind: "unknown", code, message: code, retryable });
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** Downloaded forks keep lineage only; they are not Workspace sharing sources. */
export async function localProjectHasWorkspaceForkLineage(projectRoot: string): Promise<boolean> {
  try {
    const parsed = workspaceForkLineageSchema.safeParse(
      JSON.parse(await readFile(workspaceForkLineagePath(projectRoot, join), "utf8"))
    );
    return parsed.success;
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * Downloads a specified Workspace revision into a new Local Canvas.
 * Source scope/revision is lineage only; no replica mapping or writeback is created.
 */
export async function downloadWorkspaceCanvasFork(input: {
  client: CollaborationClient;
  rawInput: unknown;
}): Promise<WorkspaceCanvasDownloadResult> {
  const requested = workspaceCanvasDownloadInputSchema.parse(input.rawInput);
  const scope = canvasScopeRefSchema.parse({
    workspaceId: requested.workspaceId,
    projectId: requested.projectId,
    canvasId: requested.canvasId
  });
  const head = await input.client.fetchContentHead(scope.canvasId);
  if (
    !head ||
    head.scope.workspaceId !== scope.workspaceId ||
    head.scope.projectId !== scope.projectId ||
    head.scope.canvasId !== scope.canvasId
  ) {
    throw unavailable("content_authoritative_head_mismatch", false);
  }
  const fetched = await input.client.fetchContentVersion({
    scope,
    content: head.content
  });
  if (
    fetched.scope.workspaceId !== scope.workspaceId ||
    fetched.scope.projectId !== scope.projectId ||
    fetched.scope.canvasId !== scope.canvasId ||
    fetched.completed.versionId !== head.content.versionId ||
    fetched.content.canonicalDigest !== head.content.canonicalDigest
  ) {
    throw unavailable("content_authoritative_head_mismatch", false);
  }
  const created = await createManagedProjectFromAuthoritativeContent({
    authorityProjectId: fetched.scope.projectId,
    content: fetched.content,
    ...(requested.projectName ? { projectName: requested.projectName } : {}),
    importMode: "fork",
    sourceLineage: {
      scope: fetched.scope,
      revision: head.revision,
      content: fetched.completed
    }
  });
  if (!created.lineage) {
    throw unavailable("content_fork_lineage_missing", false);
  }
  return workspaceCanvasDownloadResultSchema.parse({
    locator: localCanvasLocatorSchema.parse({
      kind: "local",
      projectId: created.project.projectId,
      canvasId: created.canvasId
    }),
    localProjectId: created.project.projectId,
    localCanvasId: created.canvasId,
    lineage: created.lineage,
    writeback: false
  });
}
