import { useCallback } from "react";
import type {
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopPackageFileChangeEvent,
  PendingImportTransaction
} from "@planweave-ai/runtime";
import type { createTranslator } from "../i18n";
import { buildNotificationItems } from "../notifications";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";
import type { PromptConflictRef } from "./usePromptDrafts";

export function useAppNotifications({
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
}: {
  autoRunState: DesktopAutoRunState | null;
  fileSyncDiagnostics: string[];
  graph: DesktopGraphViewModel | null;
  lastFileChange: DesktopPackageFileChangeEvent | null;
  navigationContext: { projectRoot: string; canvasId: string } | null;
  pendingImportRecoveries: PendingImportTransaction[];
  promptConflicts: PromptConflictRef[];
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
}) {
  const notificationItems = buildNotificationItems({
    autoRunState,
    fileSyncDiagnostics,
    graph,
    lastFileChange,
    navigationContext,
    pendingImportRecoveries,
    promptConflicts,
    settings,
    t
  });
  const handleMarkNotificationRead = useCallback(
    (notificationId: string) => {
      if (settings.readNotificationIds.includes(notificationId)) {
        return;
      }
      updateSettings((current) => ({
        readNotificationIds: [...current.readNotificationIds, notificationId]
      }));
    },
    [settings.readNotificationIds, updateSettings]
  );

  return { handleMarkNotificationRead, notificationItems };
}
