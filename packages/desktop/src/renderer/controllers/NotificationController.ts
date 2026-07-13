import { useCallback, type SetStateAction } from "react";
import type {
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopPackageFileChangeEvent,
  PendingImportTransaction
} from "@planweave-ai/runtime";
import type { createTranslator } from "../i18n";
import type { PromptConflictRef } from "../hooks/usePromptDrafts";
import { useAppNotifications } from "../hooks/useAppNotifications";
import type { TaskWorkspaceNavigationTarget } from "../taskWorkspaceNavigation";
import type { DesktopSettingsUpdate, DesktopUiSettings, NotificationItem } from "../types";
import type { WorkspaceTabsNotificationsProps } from "../views/WorkspaceTabs";

type ImportRecoveryRollbackResult = {
  status: string;
};

export type NotificationController = WorkspaceTabsNotificationsProps & {
  onOpenNotification: (item: NotificationItem) => Promise<void>;
};

export function useNotificationController({
  applyLocalPromptConflicts,
  autoRunState,
  fileSyncDiagnostics,
  graph,
  handleRevealPathInFinder,
  keepLocalPromptConflicts,
  lastFileChange,
  navigationContext,
  openRunWorkspace,
  openTaskWorkspace,
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
  navigationContext: { projectRoot: string; canvasId: string } | null;
  openRunWorkspace: (locator: {
    projectRoot: string;
    canvasId: string;
    recordId: string;
  }) => Promise<void>;
  openTaskWorkspace: (target: TaskWorkspaceNavigationTarget) => void;
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
    navigationContext,
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
  const handleOpenNotification = useCallback(
    async (item: NotificationItem) => {
      try {
        if (item.navigationIntent?.kind === "task-workspace") {
          openTaskWorkspace(item.navigationIntent.target);
          return;
        }
        if (item.navigationIntent?.kind === "run-record-lookup") {
          await openRunWorkspace(item.navigationIntent.locator);
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [openRunWorkspace, openTaskWorkspace, setError]
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
    onOpenNotification: handleOpenNotification,
    onCopyImportRecoveryTransactionId: handleCopyImportRecoveryTransactionId,
    onReloadPromptConflicts: reloadPromptConflicts,
    onRevealImportRecoveryDirectory: handleRevealImportRecoveryDirectory,
    onRollbackImportRecovery: handleRollbackImportRecovery
  };
}
