import type {
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopPackageFileChangeEvent,
  PendingImportTransaction
} from "@planweave-ai/runtime";
import type { CollaborationNotificationDraft } from "./collaboration/assigneeSurfaceViewModels";
import type { createTranslator } from "./i18n";
import type { PromptConflictRef } from "./hooks/usePromptDrafts";
import type { DesktopUiSettings, NotificationItem, NotificationItemDraft } from "./types";
import {
  notificationIdentity,
  type NotificationScope,
  type NotificationNavigationContext
} from "./notificationIdentity";
import {
  blockWorkspaceTarget,
  taskWorkspaceTarget,
  workspaceBlockWorkspaceTarget,
  workspaceTaskWorkspaceTarget
} from "./taskWorkspaceNavigation";

function directNavigationIntent(
  graph: DesktopGraphViewModel,
  context: NotificationNavigationContext,
  ref: string
): NotificationItemDraft["navigationIntent"] {
  const separatorIndex = ref.indexOf("#");
  const taskId = separatorIndex < 0 ? ref : ref.slice(0, separatorIndex);
  const task = graph.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) {
    return;
  }
  if (separatorIndex >= 0 && !task.blocks.some((block) => block.ref === ref)) {
    return;
  }
  if ("kind" in context) {
    const workspaceContext = {
      authority: "workspace" as const,
      connectionProfileId: context.connectionProfileId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      canvasId: context.canvasId,
      taskId
    };
    return {
      kind: "task-workspace",
      target:
        separatorIndex < 0
          ? workspaceTaskWorkspaceTarget(workspaceContext)
          : workspaceBlockWorkspaceTarget({ ...workspaceContext, blockRef: ref })
    };
  }
  return {
    kind: "task-workspace",
    target:
      separatorIndex < 0
        ? taskWorkspaceTarget({ ...context, taskId })
        : blockWorkspaceTarget({ ...context, taskId, blockRef: ref })
  };
}

export function buildNotificationItems({
  autoRunState,
  collaborationItems = [],
  fileSyncDiagnostics,
  graph,
  graphScope,
  lastFileChange,
  navigationContext,
  pendingImportRecoveries = [],
  promptConflicts,
  settings,
  t
}: {
  autoRunState: DesktopAutoRunState | null;
  collaborationItems?: readonly CollaborationNotificationDraft[];
  fileSyncDiagnostics: string[];
  graph: DesktopGraphViewModel | null;
  graphScope: NotificationScope | null;
  lastFileChange: DesktopPackageFileChangeEvent | null;
  navigationContext: NotificationNavigationContext | null;
  pendingImportRecoveries?: PendingImportTransaction[];
  promptConflicts: PromptConflictRef[];
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
}): NotificationItem[] {
  const readNotificationIds = new Set(settings.readNotificationIds);
  const notificationItems: NotificationItemDraft[] = [];
  if (settings.notifications.autoRunFailure && autoRunState?.error) {
    notificationItems.push({
      id: notificationIdentity(
        "auto-run-error",
        autoRunState,
        autoRunState.runId,
        autoRunState.error
      ),
      title: t("notifyAutoRun"),
      detail: autoRunState.error,
      tone: "destructive"
    });
  }
  if (settings.notifications.autoRunFailure && autoRunState?.latestRecordPath) {
    notificationItems.push({
      id: notificationIdentity("latest-record", autoRunState, autoRunState.latestRecordPath),
      title: t("latestRecord"),
      detail: autoRunState.latestRecordPath,
      tone: "outline",
      navigationIntent:
        autoRunState.latestRecordId && autoRunState.canvasId
          ? {
              kind: "run-record-lookup",
              locator: {
                projectRoot: autoRunState.projectRoot,
                canvasId: autoRunState.canvasId,
                recordId: autoRunState.latestRecordId
              }
            }
          : undefined
    });
  }
  if (settings.notifications.graphExceptions && graphScope) {
    for (const task of graph?.tasks ?? []) {
      for (const exception of task.exceptions) {
        notificationItems.push({
          id: notificationIdentity(
            "exception",
            graphScope,
            task.taskId,
            exception.ref,
            exception.source
          ),
          title: `${t("graphExceptions")} · ${task.title}`,
          detail: exception.reason,
          tone: "destructive",
          navigationIntent:
            graph && navigationContext
              ? directNavigationIntent(graph, navigationContext, exception.ref)
              : undefined
        });
      }
    }
  }
  if (settings.notifications.dirtyPrompts && graphScope) {
    for (const ref of graph?.dirtyPromptRefs ?? []) {
      notificationItems.push({
        id: notificationIdentity("dirty", graphScope, ref),
        title: t("notifyDirtyPrompts"),
        detail: ref,
        tone: "secondary",
        navigationIntent:
          graph && navigationContext
            ? directNavigationIntent(graph, navigationContext, ref)
            : undefined
      });
    }
  }
  if (settings.notifications.fileSyncConflict) {
    for (const conflict of promptConflicts) {
      notificationItems.push({
        id: notificationIdentity("prompt-conflict", conflict, conflict.taskId),
        title: `${t("fileSyncConflict")} · ${conflict.title}`,
        detail: conflict.taskId,
        tone: "destructive",
        kind: "promptConflict"
      });
    }
    if (lastFileChange) {
      const detail = lastFileChange.paths.join(", ");
      notificationItems.push({
        id: notificationIdentity(
          "file-change",
          { projectRoot: lastFileChange.projectRoot, canvasId: lastFileChange.canvasId ?? null },
          ...lastFileChange.paths
        ),
        title: t("fileChangesDetected"),
        detail,
        tone: "outline",
        kind: "fileSync"
      });
    }
    if (navigationContext)
      for (const diagnostic of fileSyncDiagnostics) {
        notificationItems.push({
          id: notificationIdentity("sync", navigationContext, diagnostic),
          title: t("fileSyncConflict"),
          detail: diagnostic,
          tone: "destructive",
          kind: "fileSync"
        });
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
  for (const collaboration of collaborationItems) {
    notificationItems.push({
      id: collaboration.id,
      title: collaboration.title,
      detail: collaboration.detail,
      tone: collaboration.tone,
      kind: collaboration.kind
    });
  }
  return notificationItems.map(
    (item): NotificationItem => ({ ...item, read: readNotificationIds.has(item.id) })
  );
}
