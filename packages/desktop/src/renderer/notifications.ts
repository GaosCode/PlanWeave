import type { DesktopAutoRunState, DesktopGraphViewModel, DesktopPackageFileChangeEvent, PendingImportTransaction } from "@planweave-ai/runtime";
import type { createTranslator } from "./i18n";
import type { PromptConflictRef } from "./hooks/usePromptDrafts";
import type { DesktopUiSettings, NotificationItem, NotificationItemDraft } from "./types";

export function buildNotificationItems({
  autoRunState,
  fileSyncDiagnostics,
  graph,
  lastFileChange,
  pendingImportRecoveries = [],
  promptConflicts,
  settings,
  t
}: {
  autoRunState: DesktopAutoRunState | null;
  fileSyncDiagnostics: string[];
  graph: DesktopGraphViewModel | null;
  lastFileChange: DesktopPackageFileChangeEvent | null;
  pendingImportRecoveries?: PendingImportTransaction[];
  promptConflicts: PromptConflictRef[];
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
}): NotificationItem[] {
  const readNotificationIds = new Set(settings.readNotificationIds);
  const notificationItems: NotificationItemDraft[] = [];
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
    for (const ref of graph?.dirtyPromptRefs ?? []) {
      notificationItems.push({ id: `dirty-${ref}`, title: t("notifyDirtyPrompts"), detail: ref, tone: "secondary" });
    }
  }
  if (settings.notifications.fileSyncConflict) {
    for (const conflict of promptConflicts) {
      notificationItems.push({
        id: `prompt-conflict:${conflict.taskId}`,
        title: `${t("fileSyncConflict")} · ${conflict.title}`,
        detail: conflict.taskId,
        tone: "destructive",
        kind: "promptConflict"
      });
    }
    if (lastFileChange) {
      const detail = lastFileChange.paths.join(", ");
      notificationItems.push({ id: `file-change:${detail}`, title: t("fileChangesDetected"), detail, tone: "outline", kind: "fileSync" });
    }
    for (const diagnostic of fileSyncDiagnostics) {
      notificationItems.push({ id: `sync-${diagnostic}`, title: t("fileSyncConflict"), detail: diagnostic, tone: "destructive", kind: "fileSync" });
    }
  }
  for (const recovery of pendingImportRecoveries) {
    notificationItems.push({
      id: `import-recovery:${recovery.transactionId}`,
      title: t("importRecoveryFound"),
      detail: `${t("importRecoveryTransactionId")}: ${recovery.transactionId} · ${t("importRecoveryOperationCount")}: ${recovery.operationCount} · ${t("importRecoveryPhases")}: ${recovery.phases.join(", ")}`,
      tone: "destructive",
      kind: "importRecovery",
      transactionId: recovery.transactionId,
      recoveryRoot: recovery.recoveryRoot
    });
  }
  return notificationItems.map((item): NotificationItem => ({ ...item, read: readNotificationIds.has(item.id) }));
}
