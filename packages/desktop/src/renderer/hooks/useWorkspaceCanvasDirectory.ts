import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasAccessRecord } from "@planweave-ai/collaboration-protocol/access/project";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { WorkspaceCanvasSharingCandidate } from "../../shared/workspaceCanvasSharing";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";

export async function readWorkspaceCanvasDirectory(
  api: Pick<
    PlanWeaveCollaborationApi,
    "listCollaborationAuthorizedProjects" | "listCollaborationAuthorizedCanvases"
  >,
  isCurrent: () => boolean,
  workspaceId?: string | null
): Promise<CanvasAccessRecord[]> {
  const canvases: CanvasAccessRecord[] = [];
  let projectCursor: number | null = 0;
  const projectCursors = new Set<number>();
  while (projectCursor !== null && isCurrent()) {
    if (projectCursors.has(projectCursor))
      throw new Error("collaboration_registry_pagination_invalid");
    projectCursors.add(projectCursor);
    const page = await api.listCollaborationAuthorizedProjects({
      cursor: projectCursor,
      limit: 100
    });
    for (const project of page.items) {
      if (workspaceId && project.registry.workspaceId !== workspaceId) continue;
      let cursor: number | null = 0;
      const cursors = new Set<number>();
      while (cursor !== null && isCurrent()) {
        if (cursors.has(cursor)) throw new Error("collaboration_registry_pagination_invalid");
        cursors.add(cursor);
        const canvasPage = await api.listCollaborationAuthorizedCanvases({
          projectId: project.registry.projectId,
          cursor,
          limit: 100
        });
        canvases.push(...canvasPage.items);
        cursor = canvasPage.nextCursor;
      }
    }
    projectCursor = page.nextCursor;
  }
  return canvases;
}

export type WorkspaceCanvasDirectoryApi = Pick<
  PlanWeaveCollaborationApi,
  | "listCollaborationAuthorizedProjects"
  | "listCollaborationAuthorizedCanvases"
  | "listWorkspaceCanvasSharingCandidates"
>;

export function useWorkspaceCanvasDirectory({
  api,
  connectionKey,
  workspaceId,
  connected
}: {
  api: WorkspaceCanvasDirectoryApi | null;
  connectionKey: string | null;
  workspaceId?: string | null;
  connected: boolean;
}) {
  const [canvases, setCanvases] = useState<CanvasAccessRecord[]>([]);
  const [candidates, setCandidates] = useState<WorkspaceCanvasSharingCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    const isCurrent = () => id === request.current;
    setError(null);
    if (!api || !connected || !connectionKey) {
      setCanvases([]);
      setCandidates([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [directory, local] = await Promise.allSettled([
        readWorkspaceCanvasDirectory(api, isCurrent, workspaceId),
        Promise.resolve().then(() => api.listWorkspaceCanvasSharingCandidates())
      ]);
      if (!isCurrent()) return;
      if (directory.status === "rejected") throw directory.reason;
      setCanvases(directory.value);
      setCandidates(local.status === "fulfilled" ? local.value : []);
      if (local.status === "rejected") setError(collaborationErrorMessage(local.reason));
    } catch (cause) {
      if (isCurrent()) {
        setCanvases([]);
        setError(collaborationErrorMessage(cause));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [api, connected, connectionKey, workspaceId]);
  useEffect(() => {
    setCanvases([]);
    setCandidates([]);
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);
  return { canvases, candidates, loading, error, refresh };
}
