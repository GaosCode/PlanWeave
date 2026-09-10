import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActiveWorkspaceConnectionStatus } from "@planweave-ai/collaboration-protocol/connection";
import type {
  CollaborationSessionPhase,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import type { CanvasAccessRecord } from "@planweave-ai/collaboration-protocol/access/project";
import { readWorkspaceCanvasDirectory } from "./useWorkspaceCanvasDirectory";
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
  const [canvases, setCanvases] = useState<CanvasAccessRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Workspace profile invalidates its authorized directory.
  const refreshOptions = useCallback(async () => {
    const id = ++generation.current;
    setError(null);
    if (!api || !connected) {
      setCanvases([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await readWorkspaceCanvasDirectory(
        api,
        () => id === generation.current,
        workspaceId
      );
      if (id === generation.current) setCanvases(rows);
    } catch (cause) {
      if (id === generation.current) {
        setCanvases([]);
        setError(collaborationErrorMessage(cause));
      }
    } finally {
      if (id === generation.current) setLoading(false);
    }
  }, [api, connected, connectionKey, workspaceId]);
  useEffect(() => {
    setCanvases([]);
    void refreshOptions();
    return () => {
      generation.current += 1;
    };
  }, [refreshOptions]);
  const options = useMemo<WorkspaceAccessScopeOption[]>(
    () =>
      canvases.map((canvas) => ({
        key: scopeKey(canvas.registry.projectId, canvas.registry.canvasId),
        projectId: canvas.registry.projectId,
        canvasId: canvas.registry.canvasId,
        projectLabel: canvas.registry.projectId,
        canvasLabel: canvas.registry.canvasId
      })),
    [canvases]
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
