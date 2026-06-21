import { useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import {
  PanelLeftCloseIcon,
  RotateCcwIcon
} from "lucide-react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { createTranslator } from "../i18n";
import type { AppView, NotificationItem } from "../types";
import { HistoryNavigationButtons } from "../components/HistoryNavigationButtons";
import { ProjectTree } from "./ProjectTree";
import { SidebarNav } from "./SidebarNav";

type ProjectSidebarProps = {
  activeView: AppView;
  collapsed: boolean;
  expandedProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  handleBindSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleDeleteProject: (project: DesktopProjectSummary) => Promise<void>;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleDropSourceRoot: (project: DesktopProjectSummary, sourceRoot: string | null) => Promise<void>;
  handleOpenProject: () => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealPlanWorkspace: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealProject: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleUnlinkSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  notificationItems: NotificationItem[];
  onResizeStart?: (event: ReactPointerEvent) => void;
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
  width?: number;
};

export function ProjectSidebar({
  activeView,
  collapsed,
  expandedProjectId,
  graph,
  handleBindSourceRoot,
  handleDeleteProject,
  handleDeleteTaskCanvas,
  handleDeleteTaskNode,
  handleDropSourceRoot,
  handleOpenProject,
  handleProjectNewGraph,
  handleRevealPlanWorkspace,
  handleRevealProject,
  handleRevealSourceRoot,
  handleUnlinkSourceRoot,
  handleTaskPanelSelect,
  loadProject,
  notificationItems,
  onResizeStart,
  onToggleSidebar,
  onTogglePinnedProject,
  pinnedProjectIds,
  projects,
  resetLayout,
  selectedProject,
  selectedCanvasId,
  selectedTaskPanelId,
  setActiveView,
  t,
  width = 280
}: ProjectSidebarProps) {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [collapsedCanvasIds, setCollapsedCanvasIds] = useState<Set<string>>(() => new Set());

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

  const handleProjectSelect = (project: DesktopProjectSummary) => {
    void loadProject(project).then(() => setActiveView("canvas-map"));
  };

  const handleCanvasSelect = (project: DesktopProjectSummary, canvasId: string) => {
    void loadProject(project, canvasId).then(() => handleTaskPanelSelect(null));
  };

  const handleProjectToggle = (project: DesktopProjectSummary, isSelectedProject: boolean) => {
    if (!isSelectedProject) {
      expandProject(project.projectId);
      void loadProject(project);
      return;
    }
    toggleProject(project.projectId);
  };

  const handleCanvasToggle = (project: DesktopProjectSummary, canvasId: string, isGraphCanvas: boolean) => {
    if (!isGraphCanvas) {
      expandCanvas(canvasId);
      void loadProject(project, canvasId);
      return;
    }
    toggleCanvas(canvasId);
  };

  return (
    <aside className="relative flex shrink-0 flex-col overflow-hidden text-text" style={{ width }}>
      <div className="app-drag-region flex h-11 shrink-0 items-center border-b border-border/80 px-3 pl-[124px]">
        <div className="app-no-drag flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label={t("collapseSidebar")} onClick={onToggleSidebar}>
            <PanelLeftCloseIcon data-icon="inline-start" />
          </Button>
          <HistoryNavigationButtons t={t} />
        </div>
      </div>
      <SidebarNav
        activeView={activeView}
        canOpenCanvasMap={selectedProject !== null}
        notificationItems={notificationItems}
        onSelectView={setActiveView}
        t={t}
      />
      <ProjectTree
        collapsedCanvasIds={collapsedCanvasIds}
        collapsedProjectIds={collapsedProjectIds}
        expandedProjectId={expandedProjectId}
        graph={graph}
        handleBindSourceRoot={handleBindSourceRoot}
        handleDeleteProject={handleDeleteProject}
        handleDeleteTaskCanvas={handleDeleteTaskCanvas}
        handleDeleteTaskNode={handleDeleteTaskNode}
        handleDropSourceRoot={handleDropSourceRoot}
        handleOpenProject={handleOpenProject}
        handleProjectNewGraph={handleProjectNewGraph}
        handleRevealPlanWorkspace={handleRevealPlanWorkspace}
        handleRevealProject={handleRevealProject}
        handleRevealSourceRoot={handleRevealSourceRoot}
        handleUnlinkSourceRoot={handleUnlinkSourceRoot}
        handleTaskPanelSelect={handleTaskPanelSelect}
        onCanvasSelect={handleCanvasSelect}
        onCanvasToggle={handleCanvasToggle}
        onProjectSelect={handleProjectSelect}
        onProjectToggle={handleProjectToggle}
        onTogglePinnedProject={onTogglePinnedProject}
        pinnedProjectIds={pinnedProjectIds}
        projects={projects}
        selectedCanvasId={selectedCanvasId}
        selectedProject={selectedProject}
        selectedTaskPanelId={selectedTaskPanelId}
        t={t}
      />
      <Separator className="bg-border/80" />
      <div className="flex items-center gap-2 p-3">
        <Button className="h-8 flex-1 justify-start px-2 text-text-muted hover:bg-surface-muted hover:text-text-strong" variant="ghost" onClick={() => void resetLayout()}>
          <RotateCcwIcon data-icon="inline-start" />
          {t("resetLayout")}
        </Button>
      </div>
      {onResizeStart ? (
        <div
          aria-label={t("resizeSidebar")}
          aria-orientation="vertical"
          className="app-no-drag absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize bg-transparent transition-colors duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)] after:absolute after:inset-y-2 after:left-1/2 after:w-px after:-translate-x-1/2 after:rounded-full after:bg-border/80 after:opacity-0 hover:bg-state-selected/10 hover:after:opacity-100 focus-visible:bg-state-selected/10 focus-visible:after:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:bg-state-selected/20"
          role="separator"
          tabIndex={0}
          onPointerDown={onResizeStart}
        />
      ) : null}
    </aside>
  );
}
