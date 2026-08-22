import { useCallback, useEffect, useMemo, useState } from "react";
import type { RemoteCollaborationCanvasBindingInput } from "../../shared/collaboration.js";
import {
  parsePersistedWorkspaceCanvasLocator,
  workspaceCanvasLocatorSchema,
  workspaceCanvasLocatorToBinding,
  type WorkspaceCanvasLocator
} from "../../shared/canvasLocator.js";
import { useCollaborationRegistryReadModels } from "./useCollaborationRegistryReadModels.js";
import type { CollaborationRegistryReadPort } from "./useCollaborationRegistryReadModels.js";
import { useCollaborationStatus } from "./useCollaborationStatus.js";
import { isCollaborationSessionConnected } from "../collaboration/sessionState.js";

function locatorMatchesAuthorizedCanvas(
  locator: Pick<WorkspaceCanvasLocator, "workspaceId" | "projectId" | "canvasId">,
  canvases: Array<{
    registry: { workspaceId: string; projectId: string; canvasId: string };
  }>
): boolean {
  return canvases.some(
    (canvas) =>
      canvas.registry.workspaceId === locator.workspaceId &&
      canvas.registry.projectId === locator.projectId &&
      canvas.registry.canvasId === locator.canvasId
  );
}

export function useRemoteCanvasWorkspace(
  input: {
    activeProjectId?: string | null;
    connectionProfileId?: string | null;
    lastOpenedWorkspaceLocator?: WorkspaceCanvasLocator | null;
    localProjectId?: string | null;
    onWorkspaceLocatorOpened?: (locator: WorkspaceCanvasLocator) => void;
    sessionConnected?: boolean;
    api?: CollaborationRegistryReadPort | null;
  } = {}
) {
  const { status } = useCollaborationStatus();
  const persistedLocator = useMemo(
    () => parsePersistedWorkspaceCanvasLocator(input.lastOpenedWorkspaceLocator ?? null),
    [input.lastOpenedWorkspaceLocator]
  );
  const activeProfile = status?.profiles.find(
    (profile) => profile.profileId === status.activeProfileId
  );
  const sessionConnected = input.sessionConnected ?? isCollaborationSessionConnected(status);
  const activeProjectId =
    input.activeProjectId ??
    activeProfile?.projectId ??
    (!sessionConnected ? persistedLocator?.projectId : null) ??
    null;
  const connectionProfileId =
    input.connectionProfileId ??
    activeProfile?.profileId ??
    (!sessionConnected ? persistedLocator?.connectionProfileId : null) ??
    null;
  const registry = useCollaborationRegistryReadModels({
    projectId: sessionConnected ? activeProjectId : null,
    api: sessionConnected ? input.api : null
  });
  const authorizedCanvases = useMemo(
    () => registry.canvases.filter((canvas) => canvas.registry.projectId === activeProjectId),
    [activeProjectId, registry.canvases]
  );
  const [locator, setLocator] = useState<WorkspaceCanvasLocator | null>(null);
  const [explicitOpen, setExplicitOpen] = useState(false);
  const binding = useMemo<RemoteCollaborationCanvasBindingInput | null>(
    () => (locator ? workspaceCanvasLocatorToBinding(locator) : null),
    [locator]
  );

  useEffect(() => {
    if (!locator) {
      return;
    }
    if (
      input.localProjectId ||
      !connectionProfileId ||
      locator.connectionProfileId !== connectionProfileId ||
      locator.projectId !== activeProjectId
    ) {
      setLocator(null);
      setExplicitOpen(false);
      return;
    }
    if (!sessionConnected) {
      return;
    }
    if (registry.phase !== "ready") {
      return;
    }
    if (locatorMatchesAuthorizedCanvas(locator, authorizedCanvases)) {
      setExplicitOpen(false);
      return;
    }
    if (!explicitOpen) {
      setLocator(null);
    }
  }, [
    activeProjectId,
    authorizedCanvases,
    connectionProfileId,
    explicitOpen,
    input.localProjectId,
    locator,
    registry.phase,
    sessionConnected
  ]);

  useEffect(() => {
    if (
      locator ||
      input.localProjectId ||
      !connectionProfileId ||
      (sessionConnected && registry.phase !== "ready")
    ) {
      return;
    }
    if (
      !persistedLocator ||
      persistedLocator.connectionProfileId !== connectionProfileId ||
      persistedLocator.projectId !== activeProjectId ||
      (sessionConnected && !locatorMatchesAuthorizedCanvas(persistedLocator, authorizedCanvases))
    ) {
      return;
    }
    setLocator(persistedLocator);
  }, [
    activeProjectId,
    authorizedCanvases,
    connectionProfileId,
    input.localProjectId,
    locator,
    persistedLocator,
    registry.phase,
    sessionConnected
  ]);

  const select = useCallback(
    (canvas: (typeof authorizedCanvases)[number]) => {
      if (!connectionProfileId) {
        return;
      }
      const next = workspaceCanvasLocatorSchema.parse({
        kind: "workspace",
        connectionProfileId,
        workspaceId: canvas.registry.workspaceId,
        projectId: canvas.registry.projectId,
        canvasId: canvas.registry.canvasId
      });
      setExplicitOpen(false);
      setLocator(next);
      input.onWorkspaceLocatorOpened?.(next);
    },
    [connectionProfileId, input.onWorkspaceLocatorOpened]
  );
  const openLocator = useCallback(
    (next: WorkspaceCanvasLocator) => {
      const parsed = workspaceCanvasLocatorSchema.parse(next);
      setExplicitOpen(true);
      setLocator(parsed);
      input.onWorkspaceLocatorOpened?.(parsed);
    },
    [input.onWorkspaceLocatorOpened]
  );
  const clear = useCallback(() => {
    setExplicitOpen(false);
    setLocator(null);
  }, []);

  return {
    ...registry,
    activeProjectId,
    connectionProfileId,
    sessionConnected,
    authorizedCanvases,
    locator,
    binding,
    clear,
    openLocator,
    select
  };
}
