import {
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction
} from "react";
import { PanelLeftCloseIcon, RotateCcwIcon } from "lucide-react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { createTranslator } from "../i18n";
import type { AppView, NotificationItem } from "../types";
import { HistoryNavigationButtons } from "../components/HistoryNavigationButtons";
import { VerticalResizeHandle } from "../components/VerticalResizeHandle";
import { ProjectTree } from "./ProjectTree";
import { SidebarNav } from "./SidebarNav";

type TaskCanvasSummary = DesktopProjectSummary["taskCanvases"][number];

type ProjectSidebarProps = {
  activeView: AppView;
  collapsed: boolean;
  expandedProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  handleBindSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleCopyCanvasToNewProject: (
    project: DesktopProjectSummary,
    canvasId: string
  ) => Promise<DesktopProjectSummary | null>;
  handleDeleteProject: (project: DesktopProjectSummary) => Promise<void>;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleDuplicateTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleCopyCanvasAgentPrompt?: (project: DesktopProjectSummary, canvas: TaskCanvasSummary) => void;
  handleDropSourceRoot: (
    project: DesktopProjectSummary,
    sourceRoot: string | null
  ) => Promise<void>;
  handleOpenProject: () => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleRefreshProjects: () => Promise<unknown>;
  handleRevealPlanWorkspace: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealProject: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleRevealTaskNode: (
    project: DesktopProjectSummary,
    canvas: TaskCanvasSummary,
    taskId: string
  ) => void;
  handleRenameProject: (project: DesktopProjectSummary, name: string) => Promise<void>;
  handleRenameTaskCanvas: (
    project: DesktopProjectSummary,
    canvasId: string,
    currentName: string
  ) => Promise<void>;
  handleUnlinkSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  notificationItems: NotificationItem[];
  onResizeStart?: (event: ReactPointerEvent) => void;
  onToggleSidebar: () => void;
  onTogglePinnedProject: (projectId: string) => void;
  pinnedProjectIds: Set<string>;
  projectRefreshing: boolean;
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
  handleCopyCanvasToNewProject,
  handleDeleteProject,
  handleDeleteTaskCanvas,
  handleDeleteTaskNode,
  handleDuplicateTaskCanvas,
  handleCopyCanvasAgentPrompt,
  handleDropSourceRoot,
  handleOpenProject,
  handleProjectNewGraph,
  handleRefreshProjects,
  handleRevealPlanWorkspace,
  handleRevealProject,
  handleRevealSourceRoot,
  handleRevealTaskCanvas,
  handleRevealTaskNode,
  handleRenameProject,
  handleRenameTaskCanvas,
  handleUnlinkSourceRoot,
  handleTaskPanelSelect,
  loadProject,
  notificationItems,
  onResizeStart,
  onToggleSidebar,
  onTogglePinnedProject,
  pinnedProjectIds,
  projectRefreshing,
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
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);

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
    void loadProject(project, canvasId).then(() => {
      handleTaskPanelSelect(null);
      setActiveView("graph");
    });
  };

  const handleProjectToggle = (project: DesktopProjectSummary, isSelectedProject: boolean) => {
    if (!isSelectedProject) {
      expandProject(project.projectId);
      void loadProject(project);
      return;
    }
    toggleProject(project.projectId);
  };

  const handleCanvasToggle = (
    project: DesktopProjectSummary,
    canvasId: string,
    isGraphCanvas: boolean
  ) => {
    if (!isGraphCanvas) {
      expandCanvas(canvasId);
      void loadProject(project, canvasId);
      return;
    }
    toggleCanvas(canvasId);
  };

  const copyCanvasToNewProject = async (project: DesktopProjectSummary, canvasId: string) => {
    const createdProject = await handleCopyCanvasToNewProject(project, canvasId);
    if (createdProject) {
      expandProject(createdProject.projectId);
      setRenamingProjectId(createdProject.projectId);
    }
  };

  return (
    <aside className="relative flex shrink-0 flex-col overflow-hidden text-text" style={{ width }}>
      <div className="app-drag-region flex h-11 shrink-0 items-center border-b border-border/80 px-3 pl-[124px]">
        <div className="app-no-drag flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("collapseSidebar")}
            onClick={onToggleSidebar}
          >
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
        handleCopyCanvasToNewProject={copyCanvasToNewProject}
        handleDeleteProject={handleDeleteProject}
        handleDeleteTaskCanvas={handleDeleteTaskCanvas}
        handleDeleteTaskNode={handleDeleteTaskNode}
        handleDuplicateTaskCanvas={handleDuplicateTaskCanvas}
        handleCopyCanvasAgentPrompt={handleCopyCanvasAgentPrompt}
        handleDropSourceRoot={handleDropSourceRoot}
        handleOpenProject={handleOpenProject}
        handleProjectNewGraph={handleProjectNewGraph}
        handleRefreshProjects={handleRefreshProjects}
        handleRevealPlanWorkspace={handleRevealPlanWorkspace}
        handleRevealProject={handleRevealProject}
        handleRevealSourceRoot={handleRevealSourceRoot}
        handleRevealTaskCanvas={handleRevealTaskCanvas}
        handleRevealTaskNode={handleRevealTaskNode}
        handleRenameProject={handleRenameProject}
        handleRenameTaskCanvas={handleRenameTaskCanvas}
        handleUnlinkSourceRoot={handleUnlinkSourceRoot}
        handleTaskPanelSelect={handleTaskPanelSelect}
        onCanvasSelect={handleCanvasSelect}
        onCanvasToggle={handleCanvasToggle}
        onProjectSelect={handleProjectSelect}
        onProjectToggle={handleProjectToggle}
        onTogglePinnedProject={onTogglePinnedProject}
        pinnedProjectIds={pinnedProjectIds}
        projectRefreshing={projectRefreshing}
        projects={projects}
        renamingProjectId={renamingProjectId}
        selectedCanvasId={selectedCanvasId}
        selectedProject={selectedProject}
        selectedTaskPanelId={selectedTaskPanelId}
        setRenamingProjectId={setRenamingProjectId}
        t={t}
      />
      <Separator className="bg-border/80" />
      <div className="flex items-center gap-2 p-3">
        <Button
          className="h-8 flex-1 justify-start px-2 text-text-muted hover:bg-surface-muted hover:text-text-strong"
          variant="ghost"
          onClick={() => void resetLayout()}
        >
          <RotateCcwIcon data-icon="inline-start" />
          {t("resetLayout")}
        </Button>
      </div>
      {onResizeStart ? (
        <VerticalResizeHandle
          aria-label={t("resizeSidebar")}
          aria-orientation="vertical"
          role="separator"
          side="right"
          tabIndex={0}
          visualTopInset
          onPointerDown={onResizeStart}
        />
      ) : null}
    </aside>
  );
}
