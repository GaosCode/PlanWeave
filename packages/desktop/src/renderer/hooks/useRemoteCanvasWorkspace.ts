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
  const activeProfile = status?.profiles.find(
    (profile) => profile.profileId === status.activeProfileId
  );
  const activeProjectId = input.activeProjectId ?? activeProfile?.projectId ?? null;
  const connectionProfileId = input.connectionProfileId ?? activeProfile?.profileId ?? null;
  const sessionConnected = input.sessionConnected ?? isCollaborationSessionConnected(status);
  const registry = useCollaborationRegistryReadModels({
    projectId: sessionConnected ? activeProjectId : null,
    api: sessionConnected ? input.api : null
  });
  const authorizedCanvases = useMemo(
    () => registry.canvases.filter((canvas) => canvas.registry.projectId === activeProjectId),
    [activeProjectId, registry.canvases]
  );
  const [locator, setLocator] = useState<WorkspaceCanvasLocator | null>(null);
  const binding = useMemo<RemoteCollaborationCanvasBindingInput | null>(
    () => (locator ? workspaceCanvasLocatorToBinding(locator) : null),
    [locator]
  );

  useEffect(() => {
    if (!locator) {
      return;
    }
    if (
      !sessionConnected ||
      input.localProjectId ||
      !connectionProfileId ||
      locator.connectionProfileId !== connectionProfileId ||
      locator.projectId !== activeProjectId
    ) {
      setLocator(null);
      return;
    }
    if (registry.phase !== "ready") {
      return;
    }
    if (!locatorMatchesAuthorizedCanvas(locator, authorizedCanvases)) {
      setLocator(null);
    }
  }, [
    activeProjectId,
    authorizedCanvases,
    connectionProfileId,
    input.localProjectId,
    locator,
    registry.phase,
    sessionConnected
  ]);

  useEffect(() => {
    if (
      locator ||
      input.localProjectId ||
      !sessionConnected ||
      !connectionProfileId ||
      registry.phase !== "ready"
    ) {
      return;
    }
    const persisted = parsePersistedWorkspaceCanvasLocator(
      input.lastOpenedWorkspaceLocator ?? null
    );
    if (
      !persisted ||
      persisted.connectionProfileId !== connectionProfileId ||
      persisted.projectId !== activeProjectId ||
      !locatorMatchesAuthorizedCanvas(persisted, authorizedCanvases)
    ) {
      return;
    }
    setLocator(persisted);
  }, [
    activeProjectId,
    authorizedCanvases,
    connectionProfileId,
    input.lastOpenedWorkspaceLocator,
    input.localProjectId,
    locator,
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
      setLocator(next);
      input.onWorkspaceLocatorOpened?.(next);
    },
    [connectionProfileId, input.onWorkspaceLocatorOpened]
  );
  const clear = useCallback(() => setLocator(null), []);

  return {
    ...registry,
    activeProjectId,
    sessionConnected,
    authorizedCanvases,
    locator,
    binding,
    clear,
    select
  };
}
