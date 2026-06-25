import { useCallback } from "react";
import type { DesktopAutoRunState, DesktopGraphViewModel, DesktopPackageFileChangeEvent } from "@planweave-ai/runtime";
import type { createTranslator } from "../i18n";
import { buildNotificationItems } from "../notifications";
import type { DesktopUiSettings } from "../types";
import type { PromptConflictRef } from "./usePromptDrafts";

export function useAppNotifications({
  autoRunState,
  fileSyncDiagnostics,
  graph,
  lastFileChange,
  promptConflicts,
  settings,
  t,
  updateSettings
}: {
  autoRunState: DesktopAutoRunState | null;
  fileSyncDiagnostics: string[];
  graph: DesktopGraphViewModel | null;
  lastFileChange: DesktopPackageFileChangeEvent | null;
  promptConflicts: PromptConflictRef[];
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (patch: Partial<DesktopUiSettings>) => void;
}) {
  const notificationItems = buildNotificationItems({
    autoRunState,
    fileSyncDiagnostics,
    graph,
    lastFileChange,
    promptConflicts,
    settings,
    t
  });
  const handleMarkNotificationRead = useCallback(
    (notificationId: string) => {
      if (settings.readNotificationIds.includes(notificationId)) {
        return;
      }
      updateSettings({ readNotificationIds: [...settings.readNotificationIds, notificationId] });
    },
    [settings.readNotificationIds, updateSettings]
  );

  return { handleMarkNotificationRead, notificationItems };
}
