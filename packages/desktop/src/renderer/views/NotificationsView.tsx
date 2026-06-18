import { XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type { NotificationItem } from "../types";

type NotificationsViewProps = {
  notificationItems: NotificationItem[];
  onMarkNotificationRead: (notificationId: string) => void;
  t: ReturnType<typeof createTranslator>;
};

export function NotificationsView({ notificationItems, onMarkNotificationRead, t }: NotificationsViewProps) {
  const unreadCount = notificationItems.filter((item) => !item.read).length;

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">{t("notifications")}</h1>
        <div className="text-sm text-text-muted">
          {notificationItems.length > 0 ? `${t("unreadNotifications")}: ${unreadCount} / ${notificationItems.length}` : t("noNotificationsFiltered")}
        </div>
        <div className="text-sm text-text-muted">{t("notificationRulesHint")}</div>
      </div>
      <div className="flex min-h-0 flex-col gap-2">
        {notificationItems.length === 0 ? <div className="rounded-md border border-border/80 bg-surface-muted/70 p-4 text-sm text-text-muted">{t("noNotifications")}</div> : null}
        {notificationItems.map((item) => (
          <div className={`flex items-start justify-between gap-3 rounded-md border border-border/80 p-3 shadow-sm ${item.read ? "bg-surface-muted/70 text-text-muted" : "bg-surface-raised text-text"}`} key={item.id}>
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-strong">{item.title}</div>
              <div className="break-words text-xs text-text-muted">{item.detail}</div>
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
