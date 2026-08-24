import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import {
  parsePersistedWorkspaceCanvasLocator,
  type CanvasLocator,
  type WorkspaceCanvasLocator
} from "../../shared/canvasLocator";
import { collaborationBridge } from "../bridge";
import { canvasReplicaProjectionToDesktopGraph } from "../collaboration/canvasReplicaGraphAdapter";
import { collaborationSurfaceCanvasIdForView } from "../collaboration/workspaceCollaborationScope";
import type { createTranslator } from "../i18n";
import type { AppView, DesktopSettingsUpdate, DesktopUiSettings } from "../types";
import { useCollaborationSurface } from "./useCollaborationSurface";
import { useDesktopProject } from "./useDesktopProject";
import { useRemoteCanvasWorkspace } from "./useRemoteCanvasWorkspace";
import { useWorkspaceCanvasCommands } from "./useWorkspaceCanvasCommands";
import { useWorkspaceRuntime } from "./useWorkspaceRuntime";

type UseProjectWorkspaceAuthorityInput = {
  activeView: AppView;
  settings: Pick<DesktopUiSettings, "lastOpenedWorkspaceLocator" | "runtimePath">;
  settingsHydrated: boolean;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setError: (message: string | null) => void;
  setSuccessMessage: Dispatch<SetStateAction<string | null>>;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

/** Selects exactly one startup Canvas authority and composes its renderer session. */
export function useProjectWorkspaceAuthority(input: UseProjectWorkspaceAuthorityInput) {
  const persistedWorkspaceLocator = useMemo(
    () => parsePersistedWorkspaceCanvasLocator(input.settings.lastOpenedWorkspaceLocator),
    [input.settings.lastOpenedWorkspaceLocator]
  );
  const desktopProject = useDesktopProject({
    autoSelectInitialProject: persistedWorkspaceLocator === null,
    initialProjectPath: input.settings.runtimePath,
    setError: input.setError,
    settingsHydrated: input.settingsHydrated,
    t: input.t,
    updateSettings: input.updateSettings
  });
  const {
    graph: localGraph,
    layout: localLayout,
    projectLoading,
    selectedCanvasId,
    selectedProject,
    setSelectedCanvasId,
    setSelectedProject
  } = desktopProject;

  const persistWorkspaceLocator = useCallback(
    (locator: WorkspaceCanvasLocator) => {
      input.updateSettings({ lastOpenedWorkspaceLocator: locator });
    },
    [input.updateSettings]
  );
  const clearPersistedWorkspaceLocator = useCallback(() => {
    input.updateSettings({ lastOpenedWorkspaceLocator: null });
  }, [input.updateSettings]);
  const remoteWorkspace = useRemoteCanvasWorkspace({
    lastOpenedWorkspaceLocator: persistedWorkspaceLocator,
    localProjectId: selectedProject?.projectId,
    onWorkspaceLocatorCleared: clearPersistedWorkspaceLocator,
    onWorkspaceLocatorOpened: persistWorkspaceLocator
  });
  const selectRemoteCanvas = useCallback(
    (canvas: Parameters<typeof remoteWorkspace.select>[0]) => {
      setSelectedProject(null);
      setSelectedCanvasId(null);
      remoteWorkspace.select(canvas);
      input.setActiveView("graph");
    },
    [input.setActiveView, remoteWorkspace.select, setSelectedCanvasId, setSelectedProject]
  );
  const openWorkspaceCanvasLocator = useCallback(
    (locator: WorkspaceCanvasLocator) => {
      setSelectedProject(null);
      setSelectedCanvasId(null);
      remoteWorkspace.openLocator(locator);
      input.setActiveView("graph");
    },
    [input.setActiveView, remoteWorkspace.openLocator, setSelectedCanvasId, setSelectedProject]
  );
  const canvasLocator = useMemo<CanvasLocator | null>(
    () =>
      remoteWorkspace.locator ??
      (selectedProject && selectedCanvasId
        ? {
            kind: "local",
            projectId: selectedProject.projectId,
            canvasId: selectedCanvasId
          }
        : null),
    [remoteWorkspace.locator, selectedCanvasId, selectedProject]
  );
  const canvasBinding = useMemo(
    () =>
      canvasLocator?.kind === "workspace"
        ? {
            kind: "remote" as const,
            workspaceId: canvasLocator.workspaceId,
            projectId: canvasLocator.projectId,
            canvasId: canvasLocator.canvasId
          }
        : null,
    [canvasLocator]
  );
  const activeCanvasId = canvasLocator?.canvasId ?? selectedCanvasId;
  const projectLoadingForAuthority = canvasLocator?.kind === "workspace" ? false : projectLoading;
  const collaborationSurface = useCollaborationSurface({
    binding: canvasBinding,
    canvasId: collaborationSurfaceCanvasIdForView(input.activeView, activeCanvasId),
    localProjectId: selectedProject?.projectId ?? null,
    t: input.t
  });
  const workspaceCanvasCommands = useWorkspaceCanvasCommands({
    api: collaborationBridge,
    locator: canvasLocator?.kind === "workspace" ? canvasLocator : null,
    sessionConnected: collaborationSurface.sessionConnected,
    t: input.t
  });
  useEffect(() => {
    if (canvasLocator?.kind === "workspace" && workspaceCanvasCommands.snapshot.lastError) {
      input.setError(workspaceCanvasCommands.snapshot.lastError);
    }
  }, [canvasLocator?.kind, input.setError, workspaceCanvasCommands.snapshot.lastError]);
  const graph = useMemo(
    () =>
      workspaceCanvasCommands.projection
        ? canvasReplicaProjectionToDesktopGraph(workspaceCanvasCommands.projection, localGraph)
        : remoteWorkspace.binding
          ? null
          : localGraph,
    [localGraph, remoteWorkspace.binding, workspaceCanvasCommands.projection]
  );
  const layout =
    workspaceCanvasCommands.projection?.content.layout ??
    (remoteWorkspace.binding ? null : localLayout);
  const collaborationRuntime = useWorkspaceRuntime({
    activeProfileId: collaborationSurface.activeProfileId,
    activeProjectId: collaborationSurface.activeProjectId,
    graph,
    sessionConnected:
      collaborationSurface.status === null ? null : collaborationSurface.sessionConnected,
    binding: canvasBinding,
    initialRuntimeAvailability: workspaceCanvasCommands.initialRuntimeAvailability,
    locator: canvasLocator,
    setError: input.setError,
    setSuccessMessage: input.setSuccessMessage,
    t: input.t
  });

  return {
    activeCanvasId,
    canvasBinding,
    canvasLocator,
    collaborationRuntime,
    collaborationSurface,
    desktopProject,
    graph: collaborationRuntime.graph,
    layout,
    openWorkspaceCanvasLocator,
    projectLoadingForAuthority,
    remoteWorkspace,
    selectRemoteCanvas,
    workspaceCanvasCommands: workspaceCanvasCommands
  };
}
