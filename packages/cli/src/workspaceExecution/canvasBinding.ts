import { canvasAccessPageSchema } from "@planweave-ai/collaboration-protocol/access/project";
import { resolveProjectWorkspace, type PackageWorkspaceRef } from "@planweave-ai/runtime";
import type { CliWorkspaceConnection } from "./connection.js";
import { WorkspaceExecutionCliError } from "./errors.js";
import type { WorkspaceJsonTransport } from "./httpTransport.js";

const registryPageLimit = 100;

function localProjectId(workspace: PackageWorkspaceRef): Promise<string> | string {
  return typeof workspace === "string"
    ? resolveProjectWorkspace(workspace).then((resolved) => resolved.id)
    : workspace.id;
}

export async function resolveCliRemoteCanvasId(input: {
  packageWorkspace: PackageWorkspaceRef;
  localCanvasId: string;
  connection: CliWorkspaceConnection;
  transport: WorkspaceJsonTransport;
  signal?: AbortSignal;
}): Promise<string> {
  const projectId = await localProjectId(input.packageWorkspace);
  const matches: string[] = [];
  const visitedCursors = new Set<number>();
  let cursor = 0;
  while (true) {
    if (visitedCursors.has(cursor)) {
      throw new WorkspaceExecutionCliError("workspace_canvas_registry_pagination_invalid", 9);
    }
    visitedCursors.add(cursor);
    const query = new URLSearchParams({
      cursor: String(cursor),
      limit: String(registryPageLimit)
    });
    const page = await input.transport.json(
      "GET",
      `/api/v1/registry/projects/${encodeURIComponent(input.connection.projectId)}/canvases?${query}`,
      canvasAccessPageSchema,
      { signal: input.signal }
    );
    for (const canvas of page.items) {
      if (
        canvas.registry.workspaceId === input.connection.workspaceId &&
        canvas.registry.projectId === input.connection.projectId &&
        canvas.publishSource?.localProjectId === projectId &&
        canvas.publishSource.localCanvasId === input.localCanvasId
      ) {
        matches.push(canvas.registry.canvasId);
      }
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  if (matches.length === 0) {
    throw new WorkspaceExecutionCliError(
      "workspace_canvas_binding_not_found",
      5,
      false,
      undefined,
      "not_found"
    );
  }
  if (matches.length > 1) {
    throw new WorkspaceExecutionCliError(
      "workspace_canvas_binding_ambiguous",
      5,
      false,
      undefined,
      "conflict"
    );
  }
  return matches[0];
}
