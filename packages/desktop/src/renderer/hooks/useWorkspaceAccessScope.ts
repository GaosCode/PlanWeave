import { useEffect, useMemo, useState } from "react";
import type { ActiveWorkspaceConnectionStatus } from "@planweave-ai/collaboration-protocol/connection";
import type {
  CollaborationSessionPhase,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { useWorkspaceCanvasDirectory } from "./useWorkspaceCanvasDirectory";
import { type CurrentCanvasAccessApi, useCurrentCanvasAccess } from "./useCurrentCanvasAccess";

export type WorkspaceAccessScopeApi = CurrentCanvasAccessApi &
  Pick<
    PlanWeaveCollaborationApi,
    | "listCollaborationAuthorizedProjects"
    | "listCollaborationAuthorizedCanvases"
    | "listWorkspaceCanvasSharingCandidates"
  >;

export type WorkspaceAccessScopeOption = {
  key: string;
  projectId: string;
  canvasId: string;
  projectLabel: string;
  canvasLabel: string;
};

type WorkspaceAccessScopeStatus = {
  profiles: Array<{ profileId: string; projectId: string }>;
  session: { phase: CollaborationSessionPhase };
  workspaceConnection: { status: ActiveWorkspaceConnectionStatus; workspaceId?: string | null };
};

function scopeKey(projectId: string, canvasId: string): string {
  return `${projectId}\0${canvasId}`;
}

export function useWorkspaceAccessScope({
  api,
  connectionKey,
  status
}: {
  api: WorkspaceAccessScopeApi | null;
  connectionKey: string | null;
  status: WorkspaceAccessScopeStatus | null;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const connected = status?.workspaceConnection.status === "connected";
  const workspaceId = status?.workspaceConnection.workspaceId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the resource choice belongs to a Workspace identity.
  useEffect(() => {
    setSelectedKey(null);
  }, [connectionKey, workspaceId]);
  const directory = useWorkspaceCanvasDirectory({ api, connectionKey, connected, workspaceId });
  const { canvases, loading, error, refresh: refreshOptions } = directory;
  const options = useMemo<WorkspaceAccessScopeOption[]>(
    () =>
      canvases.map((canvas) => {
        const local = directory.candidates.find(
          (candidate) =>
            candidate.workspaceCanvasId === canvas.registry.canvasId &&
            (candidate.localProjectId === canvas.registry.projectId ||
              candidate.localProjectId === canvas.publishSource?.localProjectId)
        );
        return {
          key: scopeKey(canvas.registry.projectId, canvas.registry.canvasId),
          projectId: canvas.registry.projectId,
          canvasId: canvas.registry.canvasId,
          projectLabel: local?.projectName ?? canvas.registry.projectId,
          canvasLabel: local?.canvasName ?? canvas.registry.canvasId
        };
      }),
    [canvases, directory.candidates]
  );

  useEffect(() => {
    setSelectedKey((current) => current ?? options[0]?.key ?? null);
  }, [options]);

  const visibleOptions = connected && connectionKey ? options : [];
  const selectedOption = useMemo(
    () => visibleOptions.find((option) => option.key === selectedKey) ?? null,
    [selectedKey, visibleOptions]
  );
  const access = useCurrentCanvasAccess({
    api,
    connectionKey: `${connectionKey}:${workspaceId}`,
    canvasId: selectedOption?.canvasId ?? null,
    projectId: selectedOption?.projectId,
    status
  });

  return {
    options: visibleOptions,
    selectedKey,
    selectedOption,
    select: setSelectedKey,
    loading,
    error,
    refreshOptions,
    access
  };
}
