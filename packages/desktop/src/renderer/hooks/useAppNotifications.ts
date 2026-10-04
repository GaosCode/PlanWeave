import type { NotificationScope, NotificationNavigationContext } from "../notificationIdentity";
import { useCallback } from "react";
import type {
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopPackageFileChangeEvent,
  PendingImportTransaction
} from "@planweave-ai/runtime";
import type { CollaborationNotificationDraft } from "../collaboration/assigneeSurfaceViewModels";
import type { createTranslator } from "../i18n";
import { buildNotificationItems } from "../notifications";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";
import type { PromptConflictRef } from "./usePromptDrafts";

export function useAppNotifications({
  autoRunState,
  collaborationItems = [],
  fileSyncDiagnostics,
  graph,
  graphScope,
  lastFileChange,
  navigationContext,
  pendingImportRecoveries,
  promptConflicts,
  settings,
  t,
  updateSettings
}: {
  autoRunState: DesktopAutoRunState | null;
  collaborationItems?: readonly CollaborationNotificationDraft[];
  fileSyncDiagnostics: string[];
  graph: DesktopGraphViewModel | null;
  graphScope: NotificationScope | null;
  lastFileChange: DesktopPackageFileChangeEvent | null;
  navigationContext: NotificationNavigationContext | null;
  pendingImportRecoveries: PendingImportTransaction[];
  promptConflicts: PromptConflictRef[];
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
}) {
  const notificationItems = buildNotificationItems({
    autoRunState,
    collaborationItems,
    fileSyncDiagnostics,
    graph,
    graphScope,
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
