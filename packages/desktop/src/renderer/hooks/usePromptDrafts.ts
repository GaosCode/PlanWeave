import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave/runtime";
import { bridge } from "../bridge";
import type { TaskNodeData } from "../types";

type UsePromptDraftsArgs = {
  graph: DesktopGraphViewModel | null;
  refreshGraph: () => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
};

export function usePromptDrafts({ graph, refreshGraph, selectedProject, setError }: UsePromptDraftsArgs) {
  const draftProjectId = useRef<string | null>(null);
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [saveStates, setSaveStates] = useState<Record<string, TaskNodeData["saveState"]>>({});

  useEffect(() => {
    if (!graph || !selectedProject) {
      setTitleDrafts({});
      setPromptDrafts({});
      setSaveStates({});
      draftProjectId.current = null;
      return;
    }

    const projectChanged = draftProjectId.current !== selectedProject.projectId;
    draftProjectId.current = selectedProject.projectId;
    const taskIds = new Set(graph.tasks.map((task) => task.taskId));

    setTitleDrafts((current) =>
      projectChanged
        ? Object.fromEntries(graph.tasks.map((task) => [task.taskId, task.title]))
        : Object.fromEntries(graph.tasks.map((task) => [task.taskId, current[task.taskId] ?? task.title]))
    );
    setPromptDrafts((current) =>
      projectChanged
        ? Object.fromEntries(graph.tasks.map((task) => [task.taskId, task.promptMarkdown]))
        : Object.fromEntries(graph.tasks.map((task) => [task.taskId, current[task.taskId] ?? task.promptMarkdown]))
    );
    setSaveStates((current) =>
      projectChanged ? {} : Object.fromEntries(Object.entries(current).filter(([taskId]) => taskIds.has(taskId)))
    );
  }, [graph, selectedProject]);

  const handleTitleChange = useCallback((taskId: string, value: string) => {
    setTitleDrafts((current) => ({ ...current, [taskId]: value }));
  }, []);

  const handleTitleSave = useCallback(
    async (taskId: string) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        await bridge.updateTaskTitle(selectedProject.rootPath, taskId, titleDrafts[taskId] ?? "");
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedProject, setError, titleDrafts]
  );

  const handlePromptChange = useCallback((taskId: string, value: string) => {
    setPromptDrafts((current) => ({ ...current, [taskId]: value }));
    setSaveStates((current) => ({ ...current, [taskId]: "idle" }));
  }, []);

  const handlePromptSave = useCallback(
    async (taskId: string) => {
      if (!bridge || !selectedProject) {
        return;
      }
      setSaveStates((current) => ({ ...current, [taskId]: "saving" }));
      try {
        await bridge.updateTaskPrompt(selectedProject.rootPath, taskId, promptDrafts[taskId] ?? "");
        setSaveStates((current) => ({ ...current, [taskId]: "saved" }));
        await refreshGraph();
      } catch (caught) {
        setSaveStates((current) => ({ ...current, [taskId]: "error" }));
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [promptDrafts, refreshGraph, selectedProject, setError]
  );

  useEffect(() => {
    if (!bridge || !selectedProject || !graph) {
      return undefined;
    }
    const dirtyTaskIds = graph.tasks
      .filter((task) => {
        const draft = promptDrafts[task.taskId];
        return draft !== undefined && draft !== task.promptMarkdown && (saveStates[task.taskId] ?? "idle") === "idle";
      })
      .map((task) => task.taskId);
    if (dirtyTaskIds.length === 0) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      for (const taskId of dirtyTaskIds) {
        void handlePromptSave(taskId);
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [graph, handlePromptSave, promptDrafts, saveStates, selectedProject]);

  return {
    handlePromptChange,
    handlePromptSave,
    handleTitleChange,
    handleTitleSave,
    promptDrafts,
    saveStates,
    titleDrafts
  };
}
