import { useState, type Dispatch, type SetStateAction } from "react";
import {
  BellIcon,
  ChartNoAxesColumnIncreasingIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FilePlus2Icon,
  FolderOpenIcon,
  GitBranchIcon,
  ListTodoIcon,
  PanelLeftCloseIcon,
  PencilIcon,
  PinIcon,
  RotateCcwIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon,
  WorkflowIcon
} from "lucide-react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave/runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
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
  handleDeleteProject: (project: DesktopProjectSummary) => Promise<void>;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleOpenProject: () => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealProject: (project: DesktopProjectSummary) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  notificationItems: NotificationItem[];
  onToggleSidebar: () => void;
  onTogglePinnedProject: (projectId: string) => void;
  pinnedProjectIds: Set<string>;
  projects: DesktopProjectSummary[];
  resetLayout: () => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  selectedCanvasId: string | null;
  selectedTaskPanelId: string | null;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  t: ReturnType<typeof createTranslator>;
};

export function ProjectSidebar({
  activeView,
  collapsed,
  expandedProjectId,
  graph,
  handleDeleteProject,
  handleDeleteTaskCanvas,
  handleDeleteTaskNode,
  handleOpenProject,
  handleProjectNewGraph,
  handleRevealProject,
  handleTaskPanelSelect,
  loadProject,
  notificationItems,
  onToggleSidebar,
  onTogglePinnedProject,
  pinnedProjectIds,
  projects,
  resetLayout,
  selectedProject,
  selectedCanvasId,
  selectedTaskPanelId,
  setActiveView,
  t
}: ProjectSidebarProps) {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [collapsedCanvasIds, setCollapsedCanvasIds] = useState<Set<string>>(() => new Set());
  const unreadNotificationCount = notificationItems.filter((item) => !item.read).length;

  if (collapsed) {
    return null;
  }

  const toggleProject = (projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const expandProject = (projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  };

  const toggleCanvas = (canvasId: string) => {
    setCollapsedCanvasIds((current) => {
      const next = new Set(current);
      if (next.has(canvasId)) {
        next.delete(canvasId);
      } else {
        next.add(canvasId);
      }
      return next;
    });
  };

  const expandCanvas = (canvasId: string) => {
    setCollapsedCanvasIds((current) => {
      const next = new Set(current);
      next.delete(canvasId);
      return next;
    });
  };

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
        <Button data-testid="sidebar-new-task" className="justify-start" variant={activeView === "new-task" ? "secondary" : "ghost"} onClick={() => setActiveView("new-task")}>
          <FilePlus2Icon data-icon="inline-start" />
          {t("newTask")}
        </Button>
        <Button data-testid="sidebar-statistics" className="justify-start" variant={activeView === "statistics" ? "secondary" : "ghost"} onClick={() => setActiveView("statistics")}>
          <ChartNoAxesColumnIncreasingIcon data-icon="inline-start" />
          {t("statistics")}
        </Button>
        <Button data-testid="sidebar-todo" className="justify-start" variant={activeView === "todo" ? "secondary" : "ghost"} onClick={() => setActiveView("todo")}>
          <ListTodoIcon data-icon="inline-start" />
          {t("todo")}
        </Button>
        <Button data-testid="sidebar-search" className="justify-start" variant={activeView === "search" ? "secondary" : "ghost"} onClick={() => setActiveView("search")}>
          <SearchIcon data-icon="inline-start" />
          {t("search")}
        </Button>
        <Button
          data-testid="sidebar-notifications"
          className="justify-start"
          variant={activeView === "notifications" ? "secondary" : "ghost"}
          onClick={() => setActiveView("notifications")}
        >
          <BellIcon data-icon="inline-start" />
          {t("notifications")}
          {unreadNotificationCount > 0 ? <Badge variant="destructive">{unreadNotificationCount}</Badge> : null}
        </Button>
        <Button data-testid="sidebar-settings" className="justify-start" variant={activeView === "settings" ? "secondary" : "ghost"} onClick={() => setActiveView("settings")}>
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
        <ScrollArea className="min-h-0 flex-1 overflow-x-hidden">
          <div className="flex min-w-0 flex-col gap-1 overflow-x-hidden pr-2">
            {projects.length === 0 ? <div className="text-sm text-muted-foreground">{t("projectMissing")}</div> : null}
            {projects.map((project) => {
              const isSelectedProject = selectedProject?.projectId === project.projectId;
              const isExpandedProject = expandedProjectId === project.projectId && isSelectedProject && !collapsedProjectIds.has(project.projectId);
              const isPinnedProject = pinnedProjectIds.has(project.projectId);
              return (
                <div className="flex min-w-0 flex-col gap-1" key={project.projectId}>
                  <div className="group/project grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center gap-1">
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <Button
                          className="h-auto min-w-0 flex-1 justify-start overflow-hidden whitespace-normal py-2 text-left"
                          variant={isSelectedProject ? "secondary" : "ghost"}
                          onClick={() => void loadProject(project)}
                        >
                          <GitBranchIcon className="shrink-0" data-icon="inline-start" />
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        </Button>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-56">
                        <ContextMenuLabel>{project.name}</ContextMenuLabel>
                        <ContextMenuItem onSelect={() => onTogglePinnedProject(project.projectId)}>
                          <PinIcon data-icon="inline-start" />
                          {isPinnedProject ? t("unpinProject") : t("pinProject")}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => void handleRevealProject(project)}>
                          <FolderOpenIcon data-icon="inline-start" />
                          {t("openInFinder")}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => void handleProjectNewGraph(project)}>
                          <SquarePenIcon data-icon="inline-start" />
                          {t("newGraph")}
                        </ContextMenuItem>
                        <ContextMenuItem disabled>
                          <PencilIcon data-icon="inline-start" />
                          {t("renameProject")}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" onSelect={() => void handleDeleteProject(project)}>
                          <Trash2Icon data-icon="inline-start" />
                          {t("deleteProject")}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    <Button
                      aria-label={isExpandedProject ? t("collapseProject") : t("expandProject")}
                      className="relative z-10 size-7 shrink-0 border-0 bg-transparent text-muted-foreground shadow-none opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      size="icon-sm"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!isSelectedProject) {
                          expandProject(project.projectId);
                          void loadProject(project);
                          return;
                        }
                        toggleProject(project.projectId);
                      }}
                    >
                      {isExpandedProject ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
                    </Button>
                  </div>
                  {isExpandedProject ? (
                    <div className="flex min-w-0 flex-col gap-1 pl-5">
                      {project.taskCanvases.map((canvas) => {
                        const isSelectedCanvas = selectedCanvasId === canvas.canvasId;
                        const isGraphCanvas =
                          isSelectedCanvas || (selectedCanvasId === null && isSelectedProject && project.taskCanvases.length === 1);
                        const isExpandedCanvas = isGraphCanvas && !collapsedCanvasIds.has(canvas.canvasId);
                        return (
                          <div className="flex min-w-0 flex-col gap-1" key={canvas.canvasId}>
                            <div className="group/canvas grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center gap-1">
                              <ContextMenu>
                                <ContextMenuTrigger asChild>
                                  <Button
                                    className="h-8 min-w-0 flex-1 justify-between gap-2 overflow-hidden px-2 text-xs"
                                    variant={isGraphCanvas && selectedTaskPanelId === null ? "secondary" : "ghost"}
                                    onClick={() => {
                                      void loadProject(project, canvas.canvasId).then(() => handleTaskPanelSelect(null));
                                    }}
                                  >
                                    <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                                      <WorkflowIcon className="shrink-0" data-icon="inline-start" />
                                      <span className="truncate">{canvas.name || t("taskCanvas")}</span>
                                    </span>
                                    <Badge className="shrink-0" variant="outline">
                                      {canvas.taskCount}
                                    </Badge>
                                  </Button>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="w-52">
                                  <ContextMenuLabel>{canvas.name || t("taskCanvas")}</ContextMenuLabel>
                                  <ContextMenuItem onSelect={() => void handleProjectNewGraph(project)}>
                                    <SquarePenIcon data-icon="inline-start" />
                                    {t("newGraph")}
                                  </ContextMenuItem>
                                  <ContextMenuSeparator />
                                  <ContextMenuItem variant="destructive" onSelect={() => void handleDeleteTaskCanvas(project, canvas.canvasId)}>
                                    <Trash2Icon data-icon="inline-start" />
                                    {t("deleteTaskCanvas")}
                                  </ContextMenuItem>
                                </ContextMenuContent>
                              </ContextMenu>
                              <Button
                                aria-label={isExpandedCanvas ? t("collapseTaskCanvas") : t("expandTaskCanvas")}
                                className="relative z-10 h-8 w-7 shrink-0 border-0 bg-transparent text-muted-foreground shadow-none opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                                size="icon-sm"
                                variant="ghost"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!isGraphCanvas) {
                                    expandCanvas(canvas.canvasId);
                                    void loadProject(project, canvas.canvasId);
                                    return;
                                  }
                                  toggleCanvas(canvas.canvasId);
                                }}
                              >
                                {isExpandedCanvas ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
                              </Button>
                            </div>
                            {isExpandedCanvas && graph ? (
                              <div className="flex min-w-0 flex-col gap-1 pl-4">
                                {graph.tasks.map((task) => (
                                  <ContextMenu key={task.taskId}>
                                    <ContextMenuTrigger asChild>
                                      <Button
                                        className="h-8 w-full min-w-0 justify-start gap-2 overflow-hidden rounded-md bg-muted/60 px-2 text-xs text-foreground hover:bg-muted"
                                        variant={selectedTaskPanelId === task.taskId ? "secondary" : "ghost"}
                                        onClick={() => handleTaskPanelSelect(task.taskId)}
                                      >
                                        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">{task.title}</span>
                                        <Badge
                                          className="ml-auto shrink-0 border-border bg-background text-xs text-foreground"
                                          variant={task.exceptions.length > 0 ? "destructive" : statusVariant[task.status]}
                                        >
                                          {task.taskId}
                                        </Badge>
                                      </Button>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent className="w-48">
                                      <ContextMenuLabel>{task.title}</ContextMenuLabel>
                                      <ContextMenuItem variant="destructive" onSelect={() => void handleDeleteTaskNode(task.taskId)}>
                                        <Trash2Icon data-icon="inline-start" />
                                        {t("deleteTask")}
                                      </ContextMenuItem>
                                    </ContextMenuContent>
                                  </ContextMenu>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
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
