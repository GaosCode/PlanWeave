import type { ProjectAccessPage } from "@planweave-ai/collaboration-protocol/access/project";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationWorkScope } from "@planweave-ai/collaboration-protocol/work/responsibility";
import { CollaborationClientError } from "./collaborationErrors.js";

export const AUTHORITY_PROJECT_MAX_PAGES = 100;

type AuthorityProjectRegistry = {
  listProjects(input: { limit: number; cursor: number }): Promise<ProjectAccessPage>;
};

function unresolvedProjectError(): CollaborationClientError {
  return new CollaborationClientError({
    kind: "forbidden",
    code: "collaboration_workspace_unresolved",
    message: "Active project has no authorized Workspace registry entry.",
    retryable: false
  });
}

/** Resolves an authority scope only from a complete, bounded registry traversal. */
export async function resolveCollaborationAuthorityScope(input: {
  registry: AuthorityProjectRegistry;
  projectId: string;
  workItem: WorkItemRef;
}): Promise<CollaborationWorkScope> {
  let cursor = 0;

  for (let pageCount = 0; pageCount < AUTHORITY_PROJECT_MAX_PAGES; pageCount += 1) {
    const page = await input.registry.listProjects({ limit: 100, cursor });
    const match = page.items.find((item) => item.registry.projectId === input.projectId);
    if (match) {
      const base = {
        workspaceId: match.registry.workspaceId,
        projectId: input.projectId,
        canvasId: input.workItem.canvasId
      };
      return input.workItem.kind === "task"
        ? { kind: "task", ...base, taskId: input.workItem.taskId }
        : { kind: "block", ...base, blockRef: input.workItem.blockRef };
    }
    if (page.nextCursor === null) throw unresolvedProjectError();
    if (page.nextCursor <= cursor) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_authority_project_pagination_invalid",
        message: "Authority project pagination cursor did not advance.",
        retryable: false
      });
    }
    cursor = page.nextCursor;
  }

  throw new CollaborationClientError({
    kind: "protocol",
    code: "collaboration_authority_project_pagination_limit_exceeded",
    message: "Authority project pagination exceeded the supported page limit.",
    retryable: false
  });
}
