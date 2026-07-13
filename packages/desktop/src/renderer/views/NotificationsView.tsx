import { useRef, useState } from "react";
import { CopyIcon, FolderOpenIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type { NotificationItem } from "../types";

type NotificationsViewProps = {
  notificationItems: NotificationItem[];
  onApplyLocalPromptConflicts: () => Promise<void>;
  onKeepLocalPromptConflicts: () => void;
  onMarkNotificationRead: (notificationId: string) => void;
  onOpenGraph: () => void;
  onReloadPromptConflicts: () => Promise<void>;
  onCopyImportRecoveryTransactionId?: (transactionId: string) => Promise<void>;
  onRevealImportRecoveryDirectory?: (recoveryRoot: string) => Promise<void>;
  onRollbackImportRecovery?: (transactionId: string) => Promise<void>;
  refreshPackageFiles: () => Promise<void>;
  t: ReturnType<typeof createTranslator>;
};

export function NotificationsView({
  notificationItems,
  onApplyLocalPromptConflicts,
  onKeepLocalPromptConflicts,
  onMarkNotificationRead,
  onOpenGraph,
  onReloadPromptConflicts,
  onCopyImportRecoveryTransactionId,
  onRevealImportRecoveryDirectory,
  onRollbackImportRecovery,
  refreshPackageFiles,
  t
}: NotificationsViewProps) {
  const unreadCount = notificationItems.filter((item) => !item.read).length;
  const pendingRollbackTransactionIdsRef = useRef<Set<string>>(new Set());
  const [pendingRollbackTransactionIds, setPendingRollbackTransactionIds] = useState<Set<string>>(() => new Set());

  const setRollbackPending = (transactionId: string, pending: boolean) => {
    const nextPendingTransactionIds = new Set(pendingRollbackTransactionIdsRef.current);
    if (pending) {
      nextPendingTransactionIds.add(transactionId);
    } else {
      nextPendingTransactionIds.delete(transactionId);
    }
    pendingRollbackTransactionIdsRef.current = nextPendingTransactionIds;
    setPendingRollbackTransactionIds(nextPendingTransactionIds);
  };

  const handleRollbackImportRecovery = async (transactionId: string) => {
    if (!onRollbackImportRecovery || pendingRollbackTransactionIdsRef.current.has(transactionId)) {
      return;
    }
    setRollbackPending(transactionId, true);
    try {
      await onRollbackImportRecovery(transactionId);
    } finally {
      setRollbackPending(transactionId, false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-4" data-testid="notifications-view">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">{t("notifications")}</h1>
        <div className="text-sm text-text-muted">
          {notificationItems.length > 0 ? `${t("unreadNotifications")}: ${unreadCount} / ${notificationItems.length}` : t("noNotificationsFiltered")}
        </div>
        <div className="text-sm text-text-muted">{t("notificationRulesHint")}</div>
      </div>
      <div className="flex min-h-0 flex-col gap-2">
        {notificationItems.length === 0 ? <div className="rounded-md border border-border/80 bg-surface-muted/70 p-4 text-sm text-text-muted">{t("noNotifications")}</div> : null}
        {notificationItems.map((item, index) => (
          <div className={`flex items-start justify-between gap-3 rounded-md border border-border/80 p-3 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)] fill-mode-both ${item.read ? "bg-surface-muted/70 text-text-muted" : "bg-surface-raised text-text"}`} key={item.id} style={{ animationDelay: `${index * 40}ms` }}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-strong">{item.title}</div>
              <div className="break-words text-xs text-text-muted">{item.detail}</div>
              {item.kind === "fileSync" ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void refreshPackageFiles()}>{t("fileSyncReload")}</Button>
                  <Button size="sm" variant="outline" onClick={() => onMarkNotificationRead(item.id)}>{t("fileSyncAcknowledge")}</Button>
                </div>
              ) : null}
              {item.kind === "promptConflict" ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void onReloadPromptConflicts()}>{t("fileSyncReload")}</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onKeepLocalPromptConflicts();
                      onMarkNotificationRead(item.id);
                    }}
                  >
                    {t("fileSyncKeepLocal")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void onApplyLocalPromptConflicts();
                      onOpenGraph();
                    }}
                  >
                    {t("fileSyncApplyMine")}
                  </Button>
                </div>
              ) : null}
              {item.kind === "importRecovery" ? (
                <div className="mt-3 min-w-0">
                  <div className="mb-2 text-xs text-text-muted">
                    <span className="font-medium text-text">{t("importRecoveryDirectory")}: </span>
                    <span className="font-mono break-all [overflow-wrap:anywhere]" data-testid="import-recovery-directory">{item.recoveryRoot}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void onRevealImportRecoveryDirectory?.(item.recoveryRoot)}>
                      <FolderOpenIcon data-icon="inline-start" />
                      {t("importRecoveryRevealDirectory")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void onCopyImportRecoveryTransactionId?.(item.transactionId)}>
                      <CopyIcon data-icon="inline-start" />
                      {t("importRecoveryCopyTransactionId")}
                    </Button>
                    <Button
                      aria-busy={pendingRollbackTransactionIds.has(item.transactionId) ? true : undefined}
                      disabled={pendingRollbackTransactionIds.has(item.transactionId)}
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleRollbackImportRecovery(item.transactionId)}
                    >
                      <RotateCcwIcon data-icon="inline-start" />
                      {t("importRecoveryRollback")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={item.read ? "outline" : "secondary"}>{item.read ? t("read") : t("unread")}</Badge>
              <Badge variant={item.tone}>{item.tone}</Badge>
              <Button
                aria-label={`${t("markNotificationRead")}: ${item.title}`}
                size="icon-sm"
                variant="ghost"
                onClick={() => onMarkNotificationRead(item.id)}
              >
                <XIcon data-icon="inline-start" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
