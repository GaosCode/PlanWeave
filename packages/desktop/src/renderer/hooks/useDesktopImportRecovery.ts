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

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function useDesktopImportRecovery({
  captureProjectSelection,
  refreshProjects,
  refreshProjectDerivedState,
  selectedProject,
  setError
}: UseDesktopImportRecoveryArgs) {
  const rollbackPendingImportRecovery = useCallback(
    async (transactionId: string) => {
      if (!bridge || !selectedProject) {
        return {
          status: "unavailable",
          transactionId
        } satisfies DesktopImportRecoveryRollbackResult;
      }
      const selection = captureProjectSelection();
      try {
        await bridge.rollbackPendingImportRecovery(selectedProject.rootPath, transactionId);
      } catch (caught) {
        const error = errorMessage(caught);
        if (selection.isCurrent()) setError(error);
        return {
          status: "rollbackFailed",
          transactionId,
          error
        } satisfies DesktopImportRecoveryRollbackResult;
      }
      try {
        if (selection.isCurrent()) {
          await refreshProjects();
          if (selection.isCurrent()) {
            await refreshProjectDerivedState({ includeLayout: true });
          }
        }
      } catch (caught) {
        const error = errorMessage(caught);
        if (selection.isCurrent()) setError(error);
        return {
          status: "refreshFailed",
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

  return { rollbackPendingImportRecovery };
}
