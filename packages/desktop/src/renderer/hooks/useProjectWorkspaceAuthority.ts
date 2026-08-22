import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import {
  canvasLocatorToCollaborationBinding,
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
import { useSharedCanvasCommands } from "./useSharedCanvasCommands";
import { useWorkspaceRuntimeState } from "./useWorkspaceRuntimeState";

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
    refreshProjectDerivedState,
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
    () => (canvasLocator ? canvasLocatorToCollaborationBinding(canvasLocator) : null),
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
  const sharedCanvasCommands = useSharedCanvasCommands({
    api: collaborationBridge,
    binding: canvasBinding,
    locator: canvasLocator,
    enabled: canvasBinding !== null || canvasLocator?.kind === "workspace",
    sessionConnected: collaborationSurface.sessionConnected,
    profileId: remoteWorkspace.connectionProfileId,
    activeProjectId: remoteWorkspace.activeProjectId,
    localOwnerDirectWriteAvailable: collaborationSurface.localOwnerDirectWriteAvailable,
    t: input.t,
    onAuthoritativeChange: async () => {
      await refreshProjectDerivedState();
    }
  });
  useEffect(() => {
    if (canvasLocator?.kind === "workspace" && sharedCanvasCommands.snapshot.lastError) {
      input.setError(sharedCanvasCommands.snapshot.lastError);
    }
  }, [canvasLocator?.kind, input.setError, sharedCanvasCommands.snapshot.lastError]);
  const graph = useMemo(
    () =>
      sharedCanvasCommands.projection
        ? canvasReplicaProjectionToDesktopGraph(sharedCanvasCommands.projection, localGraph)
        : remoteWorkspace.binding
          ? null
          : localGraph,
    [localGraph, remoteWorkspace.binding, sharedCanvasCommands.projection]
  );
  const layout =
    sharedCanvasCommands.projection?.content.layout ??
    (remoteWorkspace.binding ? null : localLayout);
  const collaborationRuntime = useWorkspaceRuntimeState({
    activeProfileId: collaborationSurface.activeProfileId,
    activeProjectId: collaborationSurface.activeProjectId,
    graph,
    sessionConnected: collaborationSurface.sessionConnected,
    binding: canvasBinding,
    locator: canvasLocator,
    sharedAuthorityMode: sharedCanvasCommands.authorityMode,
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
    sharedCanvasCommands
  };
}
