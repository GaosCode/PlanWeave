import { useCallback, useEffect, useState } from "react";
import type { DesktopGraphViewModel, DesktopLayout, DesktopProjectSummary, DesktopStatistics, DesktopTodoGroups } from "@planweave/runtime";
import { bridge } from "../bridge";
import type { DesktopUiSettings } from "../types";

type UseDesktopProjectArgs = {
  setError: (message: string | null) => void;
  setSelectedContextNodeId: (nodeId: string | null) => void;
  setSelectedTaskPanelId: (taskId: string | null) => void;
  updateSettings: (patch: Partial<DesktopUiSettings>) => void;
};

export function useDesktopProject({
  setError,
  setSelectedContextNodeId,
  setSelectedTaskPanelId,
  updateSettings
}: UseDesktopProjectArgs) {
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState<DesktopProjectSummary | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [graph, setGraph] = useState<DesktopGraphViewModel | null>(null);
  const [layout, setLayout] = useState<DesktopLayout | null>(null);
  const [todoGroups, setTodoGroups] = useState<DesktopTodoGroups | null>(null);
  const [statistics, setStatistics] = useState<DesktopStatistics | null>(null);

  const loadProject = useCallback(
    async (project: DesktopProjectSummary) => {
      if (!bridge) {
        return;
      }
      setSelectedProject(project);
      setExpandedProjectId(project.projectId);
      setSelectedTaskPanelId(null);
      setSelectedContextNodeId(null);
      setError(null);
      const [nextGraph, nextLayout, nextTodo, nextStats] = await Promise.all([
        bridge.getGraphViewModel(project.rootPath),
        bridge.getDesktopLayout(project.rootPath),
        bridge.getTodoGroups(project.rootPath),
        bridge.getStatistics(project.rootPath)
      ]);
      setGraph(nextGraph);
      setLayout(nextLayout);
      setTodoGroups(nextTodo);
      setStatistics(nextStats);
      await bridge.refreshPackageFileChanges(project.rootPath);
      await bridge.watchPackageFiles(project.rootPath);
      updateSettings({ runtimePath: project.workspaceRoot });
    },
    [setError, setSelectedContextNodeId, setSelectedTaskPanelId, updateSettings]
  );

  useEffect(() => {
    if (!bridge) {
      return;
    }
    bridge
      .listProjects()
      .then((items) => {
        setProjects(items);
        if (items[0]) {
          void loadProject(items[0]);
        }
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [loadProject, setError]);

  useEffect(() => {
    const projectRoot = selectedProject?.rootPath;
    return () => {
      if (bridge && projectRoot) {
        void bridge.unwatchPackageFiles(projectRoot);
      }
    };
  }, [selectedProject?.rootPath]);

  const refreshGraph = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    const nextGraph = await bridge.getGraphViewModel(selectedProject.rootPath);
    setGraph(nextGraph);
  }, [selectedProject]);

  const handleOpenProject = useCallback(async () => {
    if (!bridge) {
      return;
    }
    try {
      const selectedPath = await bridge.chooseProjectFolder();
      if (!selectedPath) {
        return;
      }
      const project = await bridge.initOrOpenProject(selectedPath);
      setProjects((items) => (items.some((item) => item.projectId === project.projectId) ? items : [...items, project]));
      await loadProject(project);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadProject, setError]);

  return {
    expandedProjectId,
    graph,
    handleOpenProject,
    layout,
    loadProject,
    projects,
    refreshGraph,
    selectedProject,
    setLayout,
    statistics,
    todoGroups
  };
}
