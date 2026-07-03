import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DesktopBlockDetail, DesktopProjectSummary, DesktopRunRecord } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";

type UseGraphDeleteActionsArgs = {
  clearReviewTaskSelection: (taskId?: string | null) => void;
  clearTaskPanelSelection: () => void;
  clearSelectedBlockRecords: () => void;
  deleteBlockConfirm: string;
  deleteTaskConfirm: string;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  refreshProjectDerivedState: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedBlock: DesktopBlockDetail | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setBlockInspectorOpen: Dispatch<SetStateAction<boolean>>;
  setError: (message: string | null) => void;
  setSelectedBlock: Dispatch<SetStateAction<DesktopBlockDetail | null>>;
  setSelectedRunRecord: Dispatch<SetStateAction<DesktopRunRecord | null>>;
};

export function useGraphDeleteActions({
  clearReviewTaskSelection,
  clearTaskPanelSelection,
  clearSelectedBlockRecords,
  deleteBlockConfirm,
  deleteTaskConfirm,
  loadProject,
  refreshProjectDerivedState,
  selectedCanvasId,
  selectedBlock,
  selectedProject,
  selectedTaskPanelId,
  setBlockInspectorOpen,
  setError,
  setSelectedBlock,
  setSelectedRunRecord
}: UseGraphDeleteActionsArgs) {
  const clearBlockSelection = useCallback(() => {
    setSelectedBlock(null);
    setSelectedRunRecord(null);
    setBlockInspectorOpen(false);
    clearSelectedBlockRecords();
  }, [clearSelectedBlockRecords, setBlockInspectorOpen, setSelectedBlock, setSelectedRunRecord]);

  const handleDeleteTaskNode = useCallback(
    async (taskId: string) => {
      if (!bridge || !selectedProject || !window.confirm(deleteTaskConfirm)) {
        return;
      }
      try {
        const result = await bridge.removeTaskNode(desktopCanvasReference(selectedProject, selectedCanvasId), taskId);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        clearReviewTaskSelection(taskId);
        if (selectedTaskPanelId === taskId || selectedBlock?.taskId === taskId) {
          clearTaskPanelSelection();
          clearBlockSelection();
        }
        await loadProject(selectedProject, selectedCanvasId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [clearBlockSelection, clearReviewTaskSelection, clearTaskPanelSelection, deleteTaskConfirm, loadProject, selectedBlock, selectedCanvasId, selectedProject, selectedTaskPanelId, setError]
  );

  const handleDeleteBlock = useCallback(
    async (ref: string) => {
      if (!bridge || !selectedProject || !window.confirm(deleteBlockConfirm)) {
        return;
      }
      try {
        const result = await bridge.removeBlock(desktopCanvasReference(selectedProject, selectedCanvasId), ref);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        if (selectedBlock?.ref === ref) {
          clearBlockSelection();
        }
        await refreshProjectDerivedState();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [clearBlockSelection, deleteBlockConfirm, refreshProjectDerivedState, selectedBlock, selectedCanvasId, selectedProject, setError]
  );

  return { handleDeleteBlock, handleDeleteTaskNode };
}
