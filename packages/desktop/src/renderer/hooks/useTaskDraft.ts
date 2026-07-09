import { useCallback, useState } from "react";
import type {
  DesktopProjectSummary,
  DesktopTaskDraft,
  DesktopTaskDraftMode
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import type { AppView } from "../types";

type UseTaskDraftArgs = {
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
};

export function useTaskDraft({
  loadProject,
  selectedCanvasId,
  selectedProject,
  setActiveView,
  setError
}: UseTaskDraftArgs) {
  const [newTaskText, setNewTaskText] = useState("");
  const [newTaskMode, setNewTaskMode] = useState<DesktopTaskDraftMode>("task");
  const [newTaskTargetId, setNewTaskTargetId] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState<DesktopTaskDraft | null>(null);

  const validateTaskDraft = useCallback((draft: DesktopTaskDraft): string | null => {
    for (const [index, task] of draft.tasks.entries()) {
      if (!task.title.trim()) {
        return `Task ${index + 1} title is required.`;
      }
      if (!task.promptMarkdown.trim()) {
        return `Task ${index + 1} prompt is required.`;
      }
      if (task.blockTypes.length === 0) {
        return `Task ${index + 1} needs at least one block type.`;
      }
      if (task.acceptance.length === 0) {
        return `Task ${index + 1} needs at least one acceptance item.`;
      }
      if (task.acceptance.some((item) => !item.trim())) {
        return `Task ${index + 1} acceptance items cannot be empty.`;
      }
    }
    for (const [index, block] of draft.blocks.entries()) {
      if (!block.taskId.trim()) {
        return `Block ${index + 1} target task is required.`;
      }
      if (!block.title.trim()) {
        return `Block ${index + 1} title is required.`;
      }
      if (!block.promptMarkdown.trim()) {
        return `Block ${index + 1} prompt is required.`;
      }
    }
    return null;
  }, []);

  const generateTaskDraft = useCallback(async () => {
    if (!bridge || !selectedProject || !newTaskText.trim()) {
      return;
    }
    try {
      setTaskDraft(
        await bridge.createTaskDraft(desktopCanvasReference(selectedProject, selectedCanvasId), {
          mode: newTaskMode,
          text: newTaskText,
          targetTaskId: newTaskTargetId
        })
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [newTaskMode, newTaskTargetId, newTaskText, selectedCanvasId, selectedProject, setError]);

  const confirmTaskDraft = useCallback(async () => {
    if (!bridge || !selectedProject || !taskDraft) {
      return;
    }
    const validationError = validateTaskDraft(taskDraft);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
      for (const task of taskDraft.tasks) {
        const result = await bridge.addTaskNode(canvas, task);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
      }
      for (const block of taskDraft.blocks) {
        const result = await bridge.addBlock(canvas, block);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
      }
      setTaskDraft(null);
      setNewTaskText("");
      await loadProject(selectedProject, selectedCanvasId);
      setActiveView("graph");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [
    loadProject,
    selectedCanvasId,
    selectedProject,
    setActiveView,
    setError,
    taskDraft,
    validateTaskDraft
  ]);

  return {
    confirmTaskDraft,
    generateTaskDraft,
    newTaskMode,
    newTaskTargetId,
    newTaskText,
    setNewTaskMode,
    setNewTaskTargetId,
    setNewTaskText,
    setTaskDraft,
    taskDraft
  };
}
