import { useCallback } from "react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import type { DesktopSelectionReceipt } from "./useDesktopProjectSnapshot";

type UseDesktopImportRecoveryArgs = {
  captureProjectSelection: () => DesktopSelectionReceipt;
  refreshProjects: () => Promise<void>;
  refreshProjectDerivedState: (options?: {
    includeLayout?: boolean;
    includePrompt?: boolean;
  }) => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
};

export type DesktopImportRecoveryRollbackResult =
  | { status: "rolledBack"; transactionId: string }
  | { status: "rollbackFailed"; transactionId: string; error: string }
  | { status: "refreshFailed"; transactionId: string; error: string }
  | { status: "unavailable"; transactionId: string };

export function useDesktopImportRecovery({
  captureProjectSelection,
  refreshProjects,
  refreshProjectDerivedState,
  selectedProject,
  setError
}: UseDesktopImportRecoveryArgs) {
  return useCallback(
    async (transactionId: string) => {
      if (!bridge || !selectedProject) {
        return {
          status: "unavailable",
          transactionId
        } satisfies DesktopImportRecoveryRollbackResult;
      }
      const selection = captureProjectSelection();
      let status: "rollbackFailed" | "refreshFailed" = "rollbackFailed";
      try {
        await bridge.rollbackPendingImportRecovery(selectedProject.rootPath, transactionId);
        status = "refreshFailed";
        if (selection.isCurrent()) {
          await refreshProjects();
          if (selection.isCurrent()) {
            await refreshProjectDerivedState({ includeLayout: true });
          }
        }
      } catch (caught) {
        const error = caught instanceof Error ? caught.message : String(caught);
        if (selection.isCurrent()) setError(error);
        return {
          status,
          transactionId,
          error
        } satisfies DesktopImportRecoveryRollbackResult;
      }
      return { status: "rolledBack", transactionId } satisfies DesktopImportRecoveryRollbackResult;
    },
    [
      captureProjectSelection,
      refreshProjectDerivedState,
      refreshProjects,
      selectedProject,
      setError
    ]
  );
}
