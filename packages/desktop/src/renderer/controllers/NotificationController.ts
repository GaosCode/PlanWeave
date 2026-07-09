import { useCallback, type SetStateAction } from "react";
import type {
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopPackageFileChangeEvent,
  PendingImportTransaction
} from "@planweave-ai/runtime";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";
import type { PromptConflictRef } from "../hooks/usePromptDrafts";
import { useAppNotifications } from "../hooks/useAppNotifications";
import type { WorkspaceTabsNotificationsProps } from "../views/WorkspaceTabs";

type ImportRecoveryRollbackResult = {
  status: string;
};

export type NotificationController = WorkspaceTabsNotificationsProps;

export function useNotificationController({
  applyLocalPromptConflicts,
  autoRunState,
  fileSyncDiagnostics,
  graph,
  handleRevealPathInFinder,
  keepLocalPromptConflicts,
  lastFileChange,
  pendingImportRecoveries,
  promptConflicts,
  reloadPromptConflicts,
  rollbackPendingImportRecovery,
  setError,
  setSuccessMessage,
  settings,
  t,
  updateSettings
}: {
  applyLocalPromptConflicts: () => Promise<void>;
  autoRunState: DesktopAutoRunState | null;
  fileSyncDiagnostics: string[];
  graph: DesktopGraphViewModel | null;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
  keepLocalPromptConflicts: () => void;
  lastFileChange: DesktopPackageFileChangeEvent | null;
  pendingImportRecoveries: PendingImportTransaction[];
  promptConflicts: PromptConflictRef[];
  reloadPromptConflicts: () => Promise<void>;
  rollbackPendingImportRecovery: (transactionId: string) => Promise<ImportRecoveryRollbackResult>;
  setError: (message: string | null) => void;
  setSuccessMessage: (value: SetStateAction<string | null>) => void;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
}): NotificationController {
  const { handleMarkNotificationRead, notificationItems } = useAppNotifications({
    autoRunState,
    fileSyncDiagnostics,
    graph,
    lastFileChange,
    pendingImportRecoveries,
    promptConflicts,
    settings,
    t,
    updateSettings
  });
  const handleRevealImportRecoveryDirectory = useCallback(
    async (recoveryRoot: string) => {
      await handleRevealPathInFinder(recoveryRoot);
    },
    [handleRevealPathInFinder]
  );
  const handleCopyImportRecoveryTransactionId = useCallback(
    async (transactionId: string) => {
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error(t("manualCommandUnavailable"));
        }
        await navigator.clipboard.writeText(transactionId);
        setSuccessMessage(t("importRecoveryTransactionCopied"));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [setError, setSuccessMessage, t]
  );
  const handleRollbackImportRecovery = useCallback(
    async (transactionId: string) => {
      const result = await rollbackPendingImportRecovery(transactionId);
      if (result.status === "rolledBack") {
        handleMarkNotificationRead(`import-recovery:${transactionId}`);
        setSuccessMessage(t("importRecoveryRollbackSucceeded"));
        return;
      }
      if (result.status === "refreshFailed") {
        handleMarkNotificationRead(`import-recovery:${transactionId}`);
      }
    },
    [handleMarkNotificationRead, rollbackPendingImportRecovery, setSuccessMessage, t]
  );

  return {
    notificationItems,
    onApplyLocalPromptConflicts: applyLocalPromptConflicts,
    onKeepLocalPromptConflicts: keepLocalPromptConflicts,
    onMarkNotificationRead: handleMarkNotificationRead,
    onCopyImportRecoveryTransactionId: handleCopyImportRecoveryTransactionId,
    onReloadPromptConflicts: reloadPromptConflicts,
    onRevealImportRecoveryDirectory: handleRevealImportRecoveryDirectory,
    onRollbackImportRecovery: handleRollbackImportRecovery
  };
}
