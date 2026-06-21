import { useCallback } from "react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import type { createTranslator } from "../i18n";
import type { AppView } from "../types";

type UseDesktopProjectActionsArgs = {
  createTaskCanvas: (project: DesktopProjectSummary) => Promise<unknown>;
  deleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  refreshProjectSummary: (projectRoot: string, canvasId?: string | null) => Promise<DesktopProjectSummary | null>;
  removeProject: (project: DesktopProjectSummary) => Promise<void>;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export function useDesktopProjectActions({
  createTaskCanvas,
  deleteTaskCanvas,
  refreshProjectSummary,
  removeProject,
  setActiveView,
  setError,
  t
}: UseDesktopProjectActionsArgs) {
  const handleProjectNewGraph = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        setError(t("bridgeUnavailable"));
        return;
      }
      try {
        await createTaskCanvas(project);
        setActiveView("new-task");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [createTaskCanvas, setActiveView, setError, t]
  );

  const handleRevealProject = useCallback(
    async (project: DesktopProjectSummary) => {
      const path = project.kind === "managed" ? project.workspaceRoot : project.sourceRoot ?? project.rootPath;
      if (!bridge) {
        setError(t("bridgeUnavailable"));
        return;
      }
      try {
        await bridge.revealProjectInFinder(path);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [setError, t]
  );

  const handleRevealPlanWorkspace = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        setError(t("bridgeUnavailable"));
        return;
      }
      try {
        await bridge.revealProjectInFinder(project.workspaceRoot);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [setError, t]
  );

  const handleRevealSourceRoot = useCallback(
    async (project: DesktopProjectSummary) => {
      const path = project.sourceRoot ?? (project.kind === "external" ? project.rootPath : null);
      if (!bridge || !path) {
        return;
      }
      try {
        await bridge.revealProjectInFinder(path);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [setError]
  );

  const linkSourceRoot = useCallback(
    async (project: DesktopProjectSummary, sourceRoot: string) => {
      if (!bridge) {
        setError(t("bridgeUnavailable"));
        return;
      }
      try {
        const updated = await bridge.linkProjectSourceRoot(project.projectId, sourceRoot);
        await refreshProjectSummary(updated.rootPath);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshProjectSummary, setError, t]
  );

  const handleBindSourceRoot = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        setError(t("bridgeUnavailable"));
        return;
      }
      try {
        const sourceRoot = await bridge.chooseSourceRootFolder();
        if (!sourceRoot) {
          return;
        }
        await linkSourceRoot(project, sourceRoot);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [linkSourceRoot, setError, t]
  );

  const handleDropSourceRoot = useCallback(
    async (project: DesktopProjectSummary, sourceRoot: string | null) => {
      if (!sourceRoot) {
        setError(t("dropSourceRootUnavailable"));
        return;
      }
      await linkSourceRoot(project, sourceRoot);
    },
    [linkSourceRoot, setError, t]
  );

  const handleUnlinkSourceRoot = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        setError(t("bridgeUnavailable"));
        return;
      }
      if (!window.confirm(t("unlinkSourceRootConfirm"))) {
        return;
      }
      try {
        const updated = await bridge.unlinkProjectSourceRoot(project.projectId);
        await refreshProjectSummary(updated.rootPath);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshProjectSummary, setError, t]
  );

  const handleRevealPathInFinder = useCallback(
    async (path: string | null | undefined) => {
      if (!bridge || !path) {
        return;
      }
      try {
        await bridge.revealPathInFinder(path);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [setError]
  );

  const handleDeleteProject = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!window.confirm(t("deleteProjectConfirm"))) {
        return;
      }
      try {
        await removeProject(project);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [removeProject, setError, t]
  );

  const handleDeleteTaskCanvas = useCallback(
    async (project: DesktopProjectSummary, canvasId: string) => {
      if (!bridge) {
        return;
      }
      if (!window.confirm(t("deleteTaskCanvasConfirm"))) {
        return;
      }
      try {
        await deleteTaskCanvas(project, canvasId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [deleteTaskCanvas, setError, t]
  );

  return {
    handleBindSourceRoot,
    handleDeleteProject,
    handleDeleteTaskCanvas,
    handleDropSourceRoot,
    handleProjectNewGraph,
    handleRevealPathInFinder,
    handleRevealPlanWorkspace,
    handleRevealProject,
    handleRevealSourceRoot,
    handleUnlinkSourceRoot
  };
}
