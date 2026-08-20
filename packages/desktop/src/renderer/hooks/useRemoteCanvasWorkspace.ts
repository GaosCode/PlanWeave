import { useCallback, useEffect, useMemo, useState } from "react";
import type { RemoteCollaborationCanvasBindingInput } from "../../shared/collaboration.js";
import { useCollaborationRegistryReadModels } from "./useCollaborationRegistryReadModels.js";
import type { CollaborationRegistryReadPort } from "./useCollaborationRegistryReadModels.js";
import { useCollaborationStatus } from "./useCollaborationStatus.js";
import { isCollaborationSessionConnected } from "../collaboration/sessionState.js";

export function useRemoteCanvasWorkspace(
  input: {
    activeProjectId?: string | null;
    sessionConnected?: boolean;
    api?: CollaborationRegistryReadPort | null;
  } = {}
) {
  const { status } = useCollaborationStatus();
  const activeProfile = status?.profiles.find(
    (profile) => profile.profileId === status.activeProfileId
  );
  const activeProjectId = input.activeProjectId ?? activeProfile?.projectId ?? null;
  const sessionConnected = input.sessionConnected ?? isCollaborationSessionConnected(status);
  const registry = useCollaborationRegistryReadModels({
    projectId: sessionConnected ? activeProjectId : null,
    api: input.api
  });
  const authorizedCanvases = useMemo(
    () => registry.canvases.filter((canvas) => canvas.registry.projectId === activeProjectId),
    [activeProjectId, registry.canvases]
  );
  const [binding, setBinding] = useState<RemoteCollaborationCanvasBindingInput | null>(null);

  useEffect(() => {
    if (
      !sessionConnected ||
      !binding ||
      binding.projectId !== activeProjectId ||
      !authorizedCanvases.some(
        (canvas) =>
          canvas.registry.workspaceId === binding.workspaceId &&
          canvas.registry.projectId === binding.projectId &&
          canvas.registry.canvasId === binding.canvasId
      )
    ) {
      setBinding(null);
    }
  }, [activeProjectId, authorizedCanvases, binding, sessionConnected]);

  const select = useCallback((canvas: (typeof authorizedCanvases)[number]) => {
    setBinding({
      kind: "remote",
      workspaceId: canvas.registry.workspaceId,
      projectId: canvas.registry.projectId,
      canvasId: canvas.registry.canvasId
    });
  }, []);
  const clear = useCallback(() => setBinding(null), []);

  return {
    ...registry,
    activeProjectId,
    sessionConnected,
    authorizedCanvases,
    binding,
    clear,
    select
  };
}
