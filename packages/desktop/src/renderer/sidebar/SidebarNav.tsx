import {
  BellIcon,
  ChartNoAxesColumnIncreasingIcon,
  FilePlus2Icon,
  ListTodoIcon,
  NetworkIcon,
  SearchIcon,
  SettingsIcon
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type { AppView, NotificationItem } from "../types";

type SidebarNavProps = {
  activeView: AppView;
  canOpenCanvasMap: boolean;
  notificationItems: NotificationItem[];
  onSelectView: (view: AppView) => void;
  t: ReturnType<typeof createTranslator>;
};

export function SidebarNav({ activeView, canOpenCanvasMap, notificationItems, onSelectView, t }: SidebarNavProps) {
  const unreadNotificationCount = notificationItems.filter((item) => !item.read).length;
  const navButtonClass =
    "h-8 justify-start rounded-md px-2 text-text-muted hover:bg-surface-muted hover:text-text-strong disabled:text-text-faint data-[variant=secondary]:border-state-selected/25 data-[variant=secondary]:bg-state-selected-surface data-[variant=secondary]:text-text-strong data-[variant=secondary]:shadow-sm [&_svg]:size-4";

  return (
    <nav className="flex flex-col gap-1 border-b border-border/60 p-3 pt-2">
      <Button
        data-testid="sidebar-new-task"
        className={navButtonClass}
        variant={activeView === "new-task" ? "secondary" : "ghost"}
        onClick={() => onSelectView("new-task")}
      >
        <FilePlus2Icon data-icon="inline-start" />
        {t("newTask")}
      </Button>
      <Button
        data-testid="sidebar-statistics"
        className={navButtonClass}
        variant={activeView === "statistics" ? "secondary" : "ghost"}
        onClick={() => onSelectView("statistics")}
      >
        <ChartNoAxesColumnIncreasingIcon data-icon="inline-start" />
        {t("statistics")}
      </Button>
      <Button
        data-testid="sidebar-todo"
        className={navButtonClass}
        variant={activeView === "todo" ? "secondary" : "ghost"}
        onClick={() => onSelectView("todo")}
      >
        <ListTodoIcon data-icon="inline-start" />
        {t("todo")}
      </Button>
      <Button
        data-testid="sidebar-canvas-map"
        className={navButtonClass}
        disabled={!canOpenCanvasMap}
        variant={activeView === "canvas-map" ? "secondary" : "ghost"}
        onClick={() => onSelectView("canvas-map")}
      >
        <NetworkIcon data-icon="inline-start" />
        {t("canvasMap")}
      </Button>
      <Button
        data-testid="sidebar-search"
        className={navButtonClass}
        variant={activeView === "search" ? "secondary" : "ghost"}
        onClick={() => onSelectView("search")}
      >
        <SearchIcon data-icon="inline-start" />
        {t("search")}
      </Button>
      <Button
        data-testid="sidebar-notifications"
        className={navButtonClass}
        variant={activeView === "notifications" ? "secondary" : "ghost"}
        onClick={() => onSelectView("notifications")}
      >
        <BellIcon data-icon="inline-start" />
        {t("notifications")}
        {unreadNotificationCount > 0 ? <Badge variant="destructive">{unreadNotificationCount}</Badge> : null}
      </Button>
      <Button
        data-testid="sidebar-settings"
        className={navButtonClass}
        variant={activeView === "settings" ? "secondary" : "ghost"}
        onClick={() => onSelectView("settings")}
      >
        <SettingsIcon data-icon="inline-start" />
        {t("settings")}
      </Button>
    </nav>
  );
}
