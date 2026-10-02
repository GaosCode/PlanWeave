import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { DesktopAutoRunState } from "@planweave-ai/runtime";
import type { CanvasLocator } from "../../shared/canvasLocator";

/** Control continuations belong to the selection where the operation started. */
export function useAutoRunSelectionGuard(
  projectRoot: string | null,
  canvasId: string | null,
  locator?: CanvasLocator | null
) {
  const locatorKind = locator?.kind ?? null;
  const locatorProject = locator?.projectId ?? null;
  const locatorCanvas = locator?.canvasId ?? null;
  const workspace = locator?.kind === "workspace" ? locator.workspaceId : null;
  const connection = locator?.kind === "workspace" ? locator.connectionProfileId : null;
  const selection = useMemo(
    () => ({
      projectRoot,
      canvasId,
      locatorKind,
      locatorProject,
      locatorCanvas,
      workspace,
      connection
    }),
    [projectRoot, canvasId, locatorKind, locatorProject, locatorCanvas, workspace, connection]
  );
  const lifecycle = useRef({ generation: 0, operation: 0, mounted: false, selection });
  useLayoutEffect(() => {
    lifecycle.current.mounted = true;
    lifecycle.current.selection = selection;
    lifecycle.current.generation += 1;
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.generation += 1;
    };
  }, [selection]);
  return useCallback(
    (beginRuntimeMutation = false) => {
      const generation = lifecycle.current.generation;
      const selectionCurrent = () =>
        lifecycle.current.mounted &&
        lifecycle.current.selection === selection &&
        lifecycle.current.generation === generation;
      const operation =
        beginRuntimeMutation && selectionCurrent() ? ++lifecycle.current.operation : null;
      return {
        isCurrent: () =>
          selectionCurrent() && (operation === null || lifecycle.current.operation === operation),
        matchesRun: (run: DesktopAutoRunState) =>
          selection.projectRoot !== null &&
          run.projectRoot === selection.projectRoot &&
          run.canvasId === selection.canvasId
      };
    },
    [selection]
  );
}
