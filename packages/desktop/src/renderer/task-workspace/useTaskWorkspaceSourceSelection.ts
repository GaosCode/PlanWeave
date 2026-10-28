import { useCallback } from "react";
import type { useSelectedBlock } from "../hooks/useSelectedBlock";
import type { useDesktopProjectSession } from "../hooks/useDesktopProjectSession";

type BlockSelection = ReturnType<typeof useSelectedBlock>;
type ProjectSession = ReturnType<typeof useDesktopProjectSession>;
export type TaskWorkspaceSourceSelectionReceipt = ReturnType<
  BlockSelection["captureBlockSelection"]
>;

type SourceSelectionOptions = Pick<
  BlockSelection,
  | "captureBlockSelection"
  | "clearSelectedBlockRecords"
  | "restoreBlockSelection"
  | "setSelectedBlock"
  | "setSelectedRunRecord"
> &
  Pick<ProjectSession, "captureTaskPanelSelection" | "restoreTaskPanelSelection">;

export function useTaskWorkspaceSourceSelection({
  captureBlockSelection,
  captureTaskPanelSelection,
  clearSelectedBlockRecords,
  restoreBlockSelection,
  restoreTaskPanelSelection,
  setSelectedBlock,
  setSelectedRunRecord
}: SourceSelectionOptions) {
  return useCallback(
    async (
      taskId: string | null,
      blockRef: string | null
    ): Promise<TaskWorkspaceSourceSelectionReceipt | undefined> => {
      const taskSelection = captureTaskPanelSelection();
      let blockSelection: TaskWorkspaceSourceSelectionReceipt;
      if (blockRef) {
        const accepted = await restoreBlockSelection(blockRef, undefined, taskSelection);
        if (!accepted?.isCurrent() || !taskSelection.isCurrent()) return;
        blockSelection = accepted;
      } else {
        setSelectedRunRecord(null);
        setSelectedBlock(null);
        clearSelectedBlockRecords();
        blockSelection = captureBlockSelection();
      }
      restoreTaskPanelSelection(taskId);
      const restoredTaskSelection = captureTaskPanelSelection();
      return {
        isCurrent: () => blockSelection.isCurrent() && restoredTaskSelection.isCurrent()
      };
    },
    [
      captureBlockSelection,
      captureTaskPanelSelection,
      clearSelectedBlockRecords,
      restoreBlockSelection,
      restoreTaskPanelSelection,
      setSelectedBlock,
      setSelectedRunRecord
    ]
  );
}
