import { useCallback } from "react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate } from "../types";
import type {
  ProjectRenameHandler,
  RenameRequest,
  RenameResult,
  TaskCanvasRenameHandler
} from "../renameResult";

type RenameActionsOptions = {
  captureProjectSelection: () => RenameRequest;
  refreshProjects: (options: {
    selectProjectId: string;
    isCurrent: () => boolean;
    throwOnErrors: boolean;
  }) => Promise<unknown>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
  renameTaskCanvas: (
    project: DesktopProjectSummary,
    canvasId: string,
    name: string,
    request: RenameRequest
  ) => Promise<unknown>;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export function useDesktopRenameActions({
  captureProjectSelection,
  refreshProjects,
  updateSettings,
  renameTaskCanvas,
  setError,
  t
}: RenameActionsOptions) {
  const save = useCallback(
    async (
      name: string,
      request: RenameRequest,
      persist: (api: NonNullable<typeof bridge>) => Promise<unknown>
    ): Promise<RenameResult> => {
      if (!request.isCurrent() || !name.trim()) return { status: "cancelled" };
      try {
        if (!bridge) throw new Error(t("bridgeUnavailable"));
        await persist(bridge);
        if (!request.isCurrent()) return { status: "cancelled" };
        setError(null);
        return { status: "saved" };
      } catch (caught) {
        if (!request.isCurrent()) return { status: "cancelled" };
        const error = caught instanceof Error ? caught.message : String(caught);
        setError(error);
        return { status: "failed", error };
      }
    },
    [setError, t]
  );

  const handleRenameProject: ProjectRenameHandler = useCallback(
    async (project, name, request) => {
      const selection = captureProjectSelection();
      return save(name, request, async (api) => {
        const updated = await api.renameProject(project.projectId, name.trim());
        if (!request.isCurrent() || !selection.isCurrent()) return;
        if (updated.projectId !== project.projectId) {
          updateSettings((current) => ({
            pinnedProjectIds: Array.from(
              new Set(
                current.pinnedProjectIds.map((id) =>
                  id === project.projectId ? updated.projectId : id
                )
              )
            )
          }));
        }
        await refreshProjects({
          selectProjectId: updated.projectId,
          isCurrent: request.isCurrent,
          throwOnErrors: true
        });
      });
    },
    [captureProjectSelection, refreshProjects, save, updateSettings]
  );

  const handleRenameTaskCanvas: TaskCanvasRenameHandler = useCallback(
    (project, canvasId, name, request) =>
      save(name, request, () => renameTaskCanvas(project, canvasId, name.trim(), request)),
    [renameTaskCanvas, save]
  );
  return { handleRenameProject, handleRenameTaskCanvas };
}

export type { RenameActionsOptions };
