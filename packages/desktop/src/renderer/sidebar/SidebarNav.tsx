import {
  BellIcon,
  ChartNoAxesColumnIncreasingIcon,
  FileTextIcon,
  FilePlus2Icon,
  GitForkIcon,
  ListChecksIcon,
  ListTodoIcon,
  NetworkIcon,
  SearchIcon,
  ServerIcon,
  UserRoundIcon,
  UsersRoundIcon
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import type { AppView, NotificationItem } from "../types";

const PANEL_TRANSITION_MS = 420;

type SidebarNavProps = {
  activeView: AppView;
  canOpenCanvasMap: boolean;
  notificationItems: NotificationItem[];
  onSelectView: (view: AppView) => void;
  mode: "personal" | "team";
  teamConnectionRole: "server" | "member" | null;
  teamView: string;
  onModeChange: (mode: "personal" | "team") => void;
  onTeamViewChange: (view: string) => void;
  t: ReturnType<typeof createTranslator>;
};

export function SidebarNav({ activeView, canOpenCanvasMap, mode, notificationItems, onModeChange, onSelectView, onTeamViewChange, t, teamConnectionRole, teamView }: SidebarNavProps) {
  const [transitioning, setTransitioning] = useState(false);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unreadNotificationCount = notificationItems.filter((item) => !item.read).length;
  const navButtonClass =
    "h-8 justify-start rounded-md px-2 text-text-muted hover:bg-surface-muted hover:text-text-strong disabled:text-text-faint data-[variant=secondary]:border-state-selected/25 data-[variant=secondary]:bg-state-selected-surface data-[variant=secondary]:text-text-strong data-[variant=secondary]:shadow-sm [&_svg]:size-4";

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    };
  }, []);

  const handleModeChange = useCallback((newMode: "personal" | "team") => {
    if (newMode === mode || transitioning) return;
    if (newMode === "personal") onTeamViewChange("planning");
    setTransitioning(true);
    transitionTimerRef.current = setTimeout(() => {
      onModeChange(newMode);
      setTransitioning(false);
    }, PANEL_TRANSITION_MS);
  }, [mode, transitioning, onModeChange]);

  const personalExpanded = mode === "personal" && !transitioning;
  const teamExpanded = mode === "team" && !transitioning;

  const dropdownClass = (expanded: boolean) => cn(
    "grid transition-[grid-template-rows,opacity] duration-[400ms] ease-[cubic-bezier(0.4,0.0,0.2,1)]",
    expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
  );

  const personalNavItems: { key: AppView; label: string; icon: typeof FilePlus2Icon; disabled?: boolean }[] = [
    { key: "new-task", label: t("newTask"), icon: FilePlus2Icon },
    { key: "statistics", label: t("statistics"), icon: ChartNoAxesColumnIncreasingIcon },
    { key: "todo", label: t("todo"), icon: ListTodoIcon },
    { key: "canvas-map", label: t("canvasMap"), icon: NetworkIcon, disabled: !canOpenCanvasMap },
    { key: "search", label: t("search"), icon: SearchIcon },
  ];

  const teamNavItems: { key: string; label: string; icon: typeof UsersRoundIcon }[] = [
    { key: "planning", label: "规划室", icon: UsersRoundIcon },
    { key: "graph", label: "流程图", icon: GitForkIcon },
    { key: "tasks", label: "团队任务", icon: ListChecksIcon },
    { key: "proposals", label: "提案", icon: FileTextIcon },
    { key: "members", label: "成员", icon: UserRoundIcon },
  ];

  return (
    <nav className="flex flex-col gap-1 border-b border-border/60 p-3 pt-2">
      <span className="mb-1 select-none text-sm font-semibold tracking-tight text-text-strong">PlanWeave</span>
      <div className="mb-1 flex h-8 items-center rounded-md bg-surface-muted/70 px-2 text-xs font-medium text-text-muted">
        <UsersRoundIcon className="mr-1.5 size-3.5" />
        <span>Mode:</span>
        <button className={`ml-2 rounded px-1.5 py-0.5 text-state-success transition-colors ${mode === "personal" ? "bg-state-success-surface" : "hover:bg-surface-raised"}`} type="button" onClick={() => handleModeChange("personal")}>Personal</button>
        <span className="text-border">/</span>
        <button className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-violet-700 transition-colors dark:text-violet-300 ${mode === "team" ? "bg-state-selected-surface" : "hover:bg-surface-raised"}`} type="button" onClick={() => handleModeChange("team")}>Team{teamConnectionRole === "server" ? <ServerIcon className="size-3.5" aria-label="团队服务器已启动" /> : null}{teamConnectionRole === "member" ? <UserRoundIcon className="size-3.5" aria-label="已作为成员连接" /> : null}</button>
      </div>
      <div className={dropdownClass(personalExpanded)}>
        <div className="min-h-0 overflow-hidden">
          <div className="mb-2 flex flex-col gap-1 border-l-2 border-state-success/70 pl-1">
            {personalNavItems.map(({ key, label, icon: Icon, disabled }) => (
              <Button
                className={navButtonClass}
                data-testid={`sidebar-${key}`}
                disabled={disabled}
                key={key}
                variant={activeView === key ? "secondary" : "ghost"}
                onClick={() => onSelectView(key)}
              >
                <Icon data-icon="inline-start" />
                {label}
              </Button>
            ))}
            <Button
              className={navButtonClass}
              data-testid="sidebar-notifications"
              variant={activeView === "notifications" ? "secondary" : "ghost"}
              onClick={() => onSelectView("notifications")}
            >
              <BellIcon data-icon="inline-start" />
              {t("notifications")}
              {unreadNotificationCount > 0 ? <Badge variant="destructive">{unreadNotificationCount}</Badge> : null}
            </Button>
          </div>
        </div>
      </div>
      <div className={dropdownClass(teamExpanded)}>
        <div className="min-h-0 overflow-hidden">
          <div className="mb-2 flex flex-col gap-1 border-l-2 border-violet-500/70 pl-1">
            {teamNavItems.map(({ key, label, icon: Icon }) => (
              <Button
                className="h-8 justify-start px-2 text-text-muted data-[variant=secondary]:bg-state-selected-surface data-[variant=secondary]:text-violet-700 dark:data-[variant=secondary]:text-violet-200"
                key={key}
                variant={teamView === key ? "secondary" : "ghost"}
                onClick={() => onTeamViewChange(key)}
              >
                <Icon data-icon="inline-start" />
                {label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}
