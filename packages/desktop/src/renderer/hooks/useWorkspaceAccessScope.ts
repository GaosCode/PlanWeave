import { useEffect, useMemo, useState } from "react";
import type { ActiveWorkspaceConnectionStatus } from "@planweave-ai/collaboration-protocol/connection";
import type {
  CollaborationSessionPhase,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import { useCollaborationRegistryReadModels } from "./useCollaborationRegistryReadModels";
import { type CurrentCanvasAccessApi, useCurrentCanvasAccess } from "./useCurrentCanvasAccess";

export type WorkspaceAccessScopeApi = CurrentCanvasAccessApi &
  Pick<
    PlanWeaveCollaborationApi,
    "listCollaborationAuthorizedProjects" | "listCollaborationAuthorizedCanvases"
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
  workspaceConnection: { status: ActiveWorkspaceConnectionStatus };
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
  const connected = isCollaborationSessionConnected(status);
  const projectId =
    status && connectionKey
      ? (status.profiles.find((profile) => profile.profileId === connectionKey)?.projectId ?? null)
      : null;
  const registry = useCollaborationRegistryReadModels({
    api: connected ? api : null,
    projectId,
    refreshKey: connectionKey ?? undefined
  });
  const options = useMemo<WorkspaceAccessScopeOption[]>(
    () =>
      registry.canvases.map((canvas) => ({
        key: scopeKey(canvas.registry.projectId, canvas.registry.canvasId),
        projectId: canvas.registry.projectId,
        canvasId: canvas.registry.canvasId,
        projectLabel: canvas.registry.projectId,
        canvasLabel: canvas.registry.canvasId
      })),
    [registry.canvases]
  );

  useEffect(() => {
    setSelectedKey((current) =>
      current && options.some((option) => option.key === current)
        ? current
        : (options[0]?.key ?? null)
    );
  }, [options]);

  const visibleOptions = connected && connectionKey ? options : [];
  const selectedOption = useMemo(
    () => visibleOptions.find((option) => option.key === selectedKey) ?? null,
    [selectedKey, visibleOptions]
  );
  const access = useCurrentCanvasAccess({
    api,
    canvasId: selectedOption?.canvasId ?? null,
    status
  });

  return {
    options: visibleOptions,
    selectedKey,
    selectedOption,
    select: setSelectedKey,
    loading: registry.phase === "loading",
    error: registry.error ? collaborationErrorMessage(registry.error) : null,
    refreshOptions: registry.refresh,
    access
  };
}
