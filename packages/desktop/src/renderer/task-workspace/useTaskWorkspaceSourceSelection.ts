import { useCallback } from "react";
import type { useSelectedBlock } from "../hooks/useSelectedBlock";
import type { useDesktopProjectSession } from "../hooks/useDesktopProjectSession";
import type { DesktopSelectionReceipt } from "../hooks/useDesktopProjectSnapshot";

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
      blockRef: string | null,
      restoreAttempt: DesktopSelectionReceipt
    ): Promise<TaskWorkspaceSourceSelectionReceipt | undefined> => {
      const taskSelection = captureTaskPanelSelection();
      const sourceOwner = {
        isCurrent: () => restoreAttempt.isCurrent() && taskSelection.isCurrent()
      };
      if (!sourceOwner.isCurrent()) return;
      let blockSelection: TaskWorkspaceSourceSelectionReceipt;
      if (blockRef) {
        const accepted = await restoreBlockSelection(blockRef, undefined, sourceOwner);
        if (!accepted?.isCurrent()) return;
        blockSelection = accepted;
      } else {
        setSelectedRunRecord(null);
        setSelectedBlock(null);
        clearSelectedBlockRecords();
        blockSelection = captureBlockSelection();
      }
      if (!sourceOwner.isCurrent()) return;
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
