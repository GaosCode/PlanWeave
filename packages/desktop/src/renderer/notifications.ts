import type { DesktopAutoRunState, DesktopGraphViewModel, DesktopPackageFileChangeEvent } from "@planweave/runtime";
import type { createTranslator } from "./i18n";
import type { DesktopUiSettings, NotificationItem } from "./types";

export function buildNotificationItems({
  autoRunState,
  dirtyPromptRefs,
  fileSyncDiagnostics,
  graph,
  lastFileChange,
  settings,
  t
}: {
  autoRunState: DesktopAutoRunState | null;
  dirtyPromptRefs: string[];
  fileSyncDiagnostics: string[];
  graph: DesktopGraphViewModel | null;
  lastFileChange: DesktopPackageFileChangeEvent | null;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
}): NotificationItem[] {
  const readNotificationIds = new Set(settings.readNotificationIds);
  const notificationItems: Omit<NotificationItem, "read">[] = [];
  if (settings.notifications.autoRunFailure && autoRunState?.error) {
    notificationItems.push({ id: `auto-run-error:${autoRunState.error}`, title: t("notifyAutoRun"), detail: autoRunState.error, tone: "destructive" });
  }
  if (settings.notifications.autoRunFailure && autoRunState?.latestRecordPath) {
    notificationItems.push({ id: `latest-record:${autoRunState.latestRecordPath}`, title: t("latestRecord"), detail: autoRunState.latestRecordPath, tone: "outline" });
  }
  if (settings.notifications.graphExceptions) {
    for (const task of graph?.tasks ?? []) {
      for (const exception of task.exceptions) {
        notificationItems.push({ id: `${task.taskId}-${exception.ref}-${exception.source}`, title: `${t("graphExceptions")} · ${task.title}`, detail: exception.reason, tone: "destructive" });
      }
    }
  }
  if (settings.notifications.dirtyPrompts) {
    for (const ref of [...new Set([...dirtyPromptRefs, ...(graph?.dirtyPromptRefs ?? [])])]) {
      notificationItems.push({ id: `dirty-${ref}`, title: t("notifyDirtyPrompts"), detail: ref, tone: "secondary" });
    }
  }
  if (settings.notifications.fileSyncConflict) {
    if (lastFileChange) {
      const detail = lastFileChange.paths.join(", ");
      notificationItems.push({ id: `file-change:${detail}`, title: t("fileChangesDetected"), detail, tone: "outline" });
    }
    for (const diagnostic of fileSyncDiagnostics) {
      notificationItems.push({ id: `sync-${diagnostic}`, title: t("fileSyncConflict"), detail: diagnostic, tone: "destructive" });
    }
  }
  return notificationItems.map((item) => ({ ...item, read: readNotificationIds.has(item.id) }));
}
