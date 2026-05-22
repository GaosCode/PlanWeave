import type { Dispatch, SetStateAction } from "react";
import {
  BellIcon,
  ChartNoAxesColumnIncreasingIcon,
  FilePlus2Icon,
  FolderOpenIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  ListTodoIcon,
  PanelLeftCloseIcon,
  PencilIcon,
  PinIcon,
  RotateCcwIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon
} from "lucide-react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave/runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { createTranslator } from "../i18n";
import type { AppView, NotificationItem } from "../types";
import { statusVariant } from "../viewHelpers";
import { HistoryNavigationButtons } from "../components/HistoryNavigationButtons";

type ProjectSidebarProps = {
  activeView: AppView;
  collapsed: boolean;
  expandedProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  handleOpenProject: () => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealProject: (project: DesktopProjectSummary) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  loadProject: (project: DesktopProjectSummary) => Promise<void>;
  notificationItems: NotificationItem[];
  onToggleSidebar: () => void;
  projects: DesktopProjectSummary[];
  resetLayout: () => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  t: ReturnType<typeof createTranslator>;
};

export function ProjectSidebar({
  activeView,
  collapsed,
  expandedProjectId,
  graph,
  handleOpenProject,
  handleProjectNewGraph,
  handleRevealProject,
  handleTaskPanelSelect,
  loadProject,
  notificationItems,
  onToggleSidebar,
  projects,
  resetLayout,
  selectedProject,
  selectedTaskPanelId,
  setActiveView,
  t
}: ProjectSidebarProps) {
  if (collapsed) {
    return null;
  }

  return (
    <aside className="flex w-[280px] shrink-0 flex-col overflow-hidden border-r bg-sidebar">
      <div className="app-drag-region flex h-11 shrink-0 items-center border-b px-3 pl-[124px]">
        <div className="app-no-drag flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label={t("collapseSidebar")} onClick={onToggleSidebar}>
            <PanelLeftCloseIcon data-icon="inline-start" />
          </Button>
          <HistoryNavigationButtons t={t} />
        </div>
      </div>
      <nav className="flex flex-col gap-1 p-3 pt-1">
        <Button className="justify-start" variant={activeView === "new-task" ? "secondary" : "ghost"} onClick={() => setActiveView("new-task")}>
          <FilePlus2Icon data-icon="inline-start" />
          {t("newTask")}
        </Button>
        <Button className="justify-start" variant={activeView === "statistics" ? "secondary" : "ghost"} onClick={() => setActiveView("statistics")}>
          <ChartNoAxesColumnIncreasingIcon data-icon="inline-start" />
          {t("statistics")}
        </Button>
        <Button className="justify-start" variant={activeView === "todo" ? "secondary" : "ghost"} onClick={() => setActiveView("todo")}>
          <ListTodoIcon data-icon="inline-start" />
          {t("todo")}
        </Button>
        <Button className="justify-start" variant={activeView === "search" ? "secondary" : "ghost"} onClick={() => setActiveView("search")}>
          <SearchIcon data-icon="inline-start" />
          {t("search")}
        </Button>
        <Button className="justify-start" variant={activeView === "notifications" ? "secondary" : "ghost"} onClick={() => setActiveView("notifications")}>
          <BellIcon data-icon="inline-start" />
          {t("notifications")}
          {notificationItems.length > 0 ? <Badge variant="destructive">{notificationItems.length}</Badge> : null}
        </Button>
        <Button className="justify-start" variant={activeView === "settings" ? "secondary" : "ghost"} onClick={() => setActiveView("settings")}>
          <SettingsIcon data-icon="inline-start" />
          {t("settings")}
        </Button>
      </nav>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-muted-foreground">{t("projects")}</div>
          <Button size="icon-sm" variant="ghost" onClick={handleOpenProject} aria-label={t("chooseProjectFolder")}>
            <FolderOpenIcon data-icon="inline-start" />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 pr-2">
            {projects.length === 0 ? <div className="text-sm text-muted-foreground">{t("projectMissing")}</div> : null}
            {projects.map((project) => {
              const isSelectedProject = selectedProject?.projectId === project.projectId;
              const isExpandedProject = expandedProjectId === project.projectId && isSelectedProject;
              return (
                <div className="flex flex-col gap-1" key={project.projectId}>
                  <div className="group/project relative">
                    <Button
                      className="h-auto w-full justify-start whitespace-normal py-2 pr-20 text-left"
                      variant={isSelectedProject ? "secondary" : "ghost"}
                      onClick={() => void loadProject(project)}
                    >
                      <GitBranchIcon data-icon="inline-start" />
                      <span className="min-w-0 truncate">{project.name}</span>
                    </Button>
                    <div className="absolute right-1 top-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/project:opacity-100 group-focus-within/project:opacity-100">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            aria-label={t("projectMore")}
                            className="h-7 w-7 bg-sidebar/80"
                            size="icon-sm"
                            variant="ghost"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <MoreHorizontalIcon data-icon="inline-start" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" side="right" className="w-56">
                          <DropdownMenuItem disabled>
                            <PinIcon data-icon="inline-start" />
                            {t("pinProject")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void handleRevealProject(project)}>
                            <FolderOpenIcon data-icon="inline-start" />
                            {t("openInFinder")}
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled>
                            <GitBranchIcon data-icon="inline-start" />
                            {t("createPermanentWorktree")}
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled>
                            <PencilIcon data-icon="inline-start" />
                            {t("renameProject")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem disabled>
                            <Trash2Icon data-icon="inline-start" />
                            {t("removeProject")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        aria-label={t("newGraph")}
                        className="h-7 w-7 bg-sidebar/80"
                        size="icon-sm"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleProjectNewGraph(project);
                        }}
                      >
                        <SquarePenIcon data-icon="inline-start" />
                      </Button>
                    </div>
                  </div>
                  {isExpandedProject && graph ? (
                    <div className="flex flex-col gap-1 pl-6">
                      {graph.tasks.map((task) => (
                        <div className="flex flex-col gap-1" key={task.taskId}>
                          <Button
                            className="h-8 justify-between gap-2 px-2 text-xs"
                            variant={selectedTaskPanelId === task.taskId ? "secondary" : "ghost"}
                            onClick={() => handleTaskPanelSelect(task.taskId)}
                          >
                            <span className="min-w-0 truncate">{task.title}</span>
                            <Badge variant={task.exceptions.length > 0 ? "destructive" : statusVariant[task.status]}>{task.taskId}</Badge>
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
      <Separator />
      <div className="flex items-center gap-2 p-3">
        <Button className="flex-1 justify-start" variant="ghost" onClick={() => void resetLayout()}>
          <RotateCcwIcon data-icon="inline-start" />
          {t("resetLayout")}
        </Button>
      </div>
    </aside>
  );
}
