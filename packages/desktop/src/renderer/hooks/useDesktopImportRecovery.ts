import { useCallback } from "react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge } from "../bridge";

type UseDesktopImportRecoveryArgs = {
  refreshProjectDerivedState: (options?: { includeLayout?: boolean; includePrompt?: boolean }) => Promise<void>;
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
  refreshProjectDerivedState,
  selectedProject,
  setError
}: UseDesktopImportRecoveryArgs) {
  const rollbackPendingImportRecovery = useCallback(async (transactionId: string) => {
    if (!bridge || !selectedProject) {
      return { status: "unavailable", transactionId } satisfies DesktopImportRecoveryRollbackResult;
    }
    try {
      await bridge.rollbackPendingImportRecovery(selectedProject.rootPath, transactionId);
    } catch (caught) {
      const error = errorMessage(caught);
      setError(error);
      return { status: "rollbackFailed", transactionId, error } satisfies DesktopImportRecoveryRollbackResult;
    }
    try {
      await refreshProjectDerivedState({ includeLayout: true });
    } catch (caught) {
      const error = errorMessage(caught);
      setError(error);
      return { status: "refreshFailed", transactionId, error } satisfies DesktopImportRecoveryRollbackResult;
    }
    return { status: "rolledBack", transactionId } satisfies DesktopImportRecoveryRollbackResult;
  }, [refreshProjectDerivedState, selectedProject, setError]);

  return { rollbackPendingImportRecovery };
}
