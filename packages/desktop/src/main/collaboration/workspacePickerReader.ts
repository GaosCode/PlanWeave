import type { WorkspacePickerPage } from "@planweave-ai/collaboration-protocol/connection";
import { CollaborationClientError } from "./collaborationErrors.js";

export async function findAuthorizedWorkspace(
  workspaceId: string,
  readPage: (cursor: number) => Promise<WorkspacePickerPage>
): Promise<WorkspacePickerPage["items"][number] | null> {
  let cursor = 0;
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const page = await readPage(cursor);
    const match = page.items.find(
      (item) =>
        item.workspaceId === workspaceId && item.membershipActive && item.archivedAt === null
    );
    if (match) return match;
    if (page.nextCursor === null) return null;
    if (page.nextCursor <= cursor)
      throw new CollaborationClientError({
        kind: "protocol",
        code: "workspace_connection_pagination_invalid",
        message: "Workspace picker pagination was invalid.",
        retryable: false
      });
    cursor = page.nextCursor;
  }
  throw new CollaborationClientError({
    kind: "protocol",
    code: "workspace_connection_picker_limit_exceeded",
    message: "Workspace picker exceeded the supported page limit.",
    retryable: false
  });
}
