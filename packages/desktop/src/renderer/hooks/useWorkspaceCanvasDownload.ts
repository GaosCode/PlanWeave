import { useCallback, useLayoutEffect, useRef } from "react";
import type { CanvasLocator } from "../../shared/canvasLocator";
import type { CollaborationStatus } from "../../shared/collaboration";
import type { WorkspaceCanvasSharingApi } from "../../shared/workspaceCanvasSharing";
import type { createTranslator } from "../i18n";
import { workspaceCanvasAuthorityKey } from "../collaboration/workspaceCanvasAuthority";

type DownloadOperation = {
  selecting: boolean;
  destination: { projectId: string; canvasId: string } | null;
};

type DownloadScope = {
  context: string;
  canvas: string | null;
  locator: CanvasLocator | null;
};

/** Owns the download and its transition from Workspace selection to the new Local Canvas. */
export function useWorkspaceCanvasDownload(input: {
  api: Pick<WorkspaceCanvasSharingApi, "downloadWorkspaceCanvasFork"> | null;
  planweaveHome: string;
  locator: CanvasLocator | null;
  localProjectRoot: string | null;
  status: CollaborationStatus | null;
  projectTitle?: string;
  clearWorkspace: () => void;
  refreshProjects: (options: {
    selectProjectId: string;
    selectCanvasId: string;
    isCurrent: () => boolean;
  }) => Promise<void>;
  setError: (message: string) => void;
  setSuccessMessage: (message: string) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const context = workspaceCanvasAuthorityKey(input.planweaveHome, input.status);
  const canvas = input.locator
    ? JSON.stringify([
        input.locator,
        input.locator.kind === "local" ? input.localProjectRoot : null
      ])
    : null;
  const lifecycle = useRef<{
    mounted: boolean;
    scope: DownloadScope;
    operation: DownloadOperation | null;
  }>({
    mounted: true,
    scope: { context, canvas, locator: input.locator },
    operation: null
  });
  useLayoutEffect(() => {
    const current = lifecycle.current;
    const previous = current.scope;
    const operation = current.operation;
    if (previous.context !== context) current.operation = null;
    else if (previous.canvas !== canvas && operation) {
      const ownClear = previous.locator?.kind === "workspace" && input.locator === null;
      const ownSelect =
        (previous.locator === null || previous.locator.kind === "workspace") &&
        input.locator?.kind === "local" &&
        input.locator.projectId === operation.destination?.projectId &&
        input.locator.canvasId === operation.destination?.canvasId;
      if (!operation.selecting || (!ownClear && !ownSelect)) current.operation = null;
    }
    current.scope = { context, canvas, locator: input.locator };
  }, [canvas, context, input.locator]);
  useLayoutEffect(() => {
    lifecycle.current.mounted = true;
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.operation = null;
    };
  }, []);

  return useCallback(async () => {
    if (!input.api || input.locator?.kind !== "workspace") return;
    if (lifecycle.current.scope.context !== context || lifecycle.current.scope.canvas !== canvas)
      return;
    const operation: DownloadOperation = { selecting: false, destination: null };
    lifecycle.current.operation = operation;
    const isCurrent = () => lifecycle.current.mounted && lifecycle.current.operation === operation;
    try {
      const result = await input.api.downloadWorkspaceCanvasFork({
        workspaceId: input.locator.workspaceId,
        projectId: input.locator.projectId,
        canvasId: input.locator.canvasId,
        ...(input.projectTitle ? { projectName: input.projectTitle } : {})
      });
      if (!isCurrent()) return;
      operation.selecting = true;
      operation.destination = result.locator;
      input.clearWorkspace();
      await input.refreshProjects({
        selectProjectId: result.localProjectId,
        selectCanvasId: result.localCanvasId,
        isCurrent
      });
      if (isCurrent()) input.setSuccessMessage(input.t("downloadWorkspaceForkSuccess"));
    } catch (caught) {
      if (isCurrent()) input.setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (lifecycle.current.operation === operation) lifecycle.current.operation = null;
    }
  }, [
    canvas,
    context,
    input.api,
    input.clearWorkspace,
    input.locator,
    input.projectTitle,
    input.refreshProjects,
    input.setError,
    input.setSuccessMessage,
    input.t
  ]);
}
