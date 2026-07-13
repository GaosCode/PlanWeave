import { useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import {
  BlocksIcon,
  BotIcon,
  CableIcon,
  GitForkIcon,
  GitPullRequestIcon,
  RotateCcwIcon,
  SettingsIcon
} from "lucide-react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { createTranslator } from "../i18n";
import type { AppView, NotificationItem } from "../types";
import type { SettingsSection } from "../settings/SettingsNav";
import { ProjectTree } from "./ProjectTree";
import { SidebarNav } from "./SidebarNav";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";

type TaskCanvasSummary = DesktopProjectSummary["taskCanvases"][number];

type ProjectSidebarProps = {
  activeView: AppView;
  expandedProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  handleBindSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleCopyCanvasToNewProject: (project: DesktopProjectSummary, canvasId: string) => Promise<DesktopProjectSummary | null>;
  handleDeleteProject: (project: DesktopProjectSummary) => Promise<void>;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleDuplicateTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleCopyCanvasAgentPrompt?: (project: DesktopProjectSummary, canvas: TaskCanvasSummary) => void;
  handleDropSourceRoot: (project: DesktopProjectSummary, sourceRoot: string | null) => Promise<void>;
  handleOpenProject: () => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleRefreshProjects: () => Promise<unknown>;
  handleRevealPlanWorkspace: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealProject: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleRenameProject: (project: DesktopProjectSummary, name: string) => Promise<void>;
  handleRenameTaskCanvas: (project: DesktopProjectSummary, canvasId: string, currentName: string) => Promise<void>;
  handleUnlinkSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  isResizing?: boolean;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  notificationItems: NotificationItem[];
  mode: "personal" | "team";
  teamConnectionRole: "server" | "member" | null;
  teamView: string;
  onModeChange: (mode: "personal" | "team") => void;
  onTeamViewChange: (view: string) => void;
  onResizeStart?: (event: ReactPointerEvent) => void;
  onTogglePinnedProject: (projectId: string) => void;
  pinnedProjectIds: Set<string>;
  projectRefreshing: boolean;
  projects: DesktopProjectSummary[];
  resetLayout: () => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  selectedCanvasId: string | null;
  selectedTaskPanelId: string | null;
  settingsSection: SettingsSection;
  setSettingsSection: (section: SettingsSection) => void;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  t: ReturnType<typeof createTranslator>;
  width?: number;
};

export function ProjectSidebar({
  activeView,
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
  handleRenameProject,
  handleRenameTaskCanvas,
  handleUnlinkSourceRoot,
  handleTaskPanelSelect,
  isResizing,
  loadProject,
  notificationItems,
  mode,
  teamConnectionRole,
  teamView,
  onModeChange,
  onTeamViewChange,
  onResizeStart,
  onTogglePinnedProject,
  pinnedProjectIds,
  projectRefreshing,
  projects,
  resetLayout,
  selectedProject,
  selectedCanvasId,
  selectedTaskPanelId,
  settingsSection,
  setSettingsSection,
  setActiveView,
  t,
  width = 280
}: ProjectSidebarProps) {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [collapsedCanvasIds, setCollapsedCanvasIds] = useState<Set<string>>(() => new Set());
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);

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

  const handleCanvasToggle = (project: DesktopProjectSummary, canvasId: string, isGraphCanvas: boolean) => {
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
    <aside className="project-sidebar relative flex shrink-0 flex-col overflow-hidden text-text" data-resizing={isResizing ? "true" : undefined} style={{ width }}>
      <div className="shrink-0 h-9 border-b border-border/80" />
      <SidebarNav
        activeView={activeView}
        canOpenCanvasMap={selectedProject !== null}
        notificationItems={notificationItems}
        mode={mode}
        teamConnectionRole={teamConnectionRole}
        teamView={teamView}
        onModeChange={onModeChange}
        onTeamViewChange={onTeamViewChange}
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
      <div className="flex flex-col gap-1 p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              data-testid="sidebar-settings"
              className="h-8 justify-start px-2 text-text-muted hover:bg-surface-muted hover:text-text-strong data-[state=open]:bg-surface-muted data-[state=open]:text-text-strong"
              variant="ghost"
            >
              <SettingsIcon data-icon="inline-start" />
              {t("settings")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[calc(var(--radix-dropdown-menu-trigger-width))] bg-surface-raised p-1" side="top" sideOffset={8}>
            {[
              { key: "general", label: t("settingsGeneral"), icon: SettingsIcon },
              { key: "components", label: t("settingsComponents"), icon: BlocksIcon },
              { key: "review", label: t("settingsReview"), icon: GitPullRequestIcon },
              { key: "agents", label: t("settingsAgents"), icon: BotIcon },
              { key: "mcp", label: t("settingsMcpTunnel"), icon: CableIcon },
              { key: "git", label: t("gitAndGitHub"), icon: GitForkIcon }
            ].map(({ key, label, icon: Icon }) => (
              <DropdownMenuItem
                data-testid={`settings-shortcut-${key}`}
                className={`h-8 gap-2 px-2 ${activeView === "settings" && settingsSection === key ? "bg-state-selected-surface text-text-strong" : ""}`}
                key={key}
                onClick={() => {
                  setSettingsSection(key as SettingsSection);
                  setActiveView("settings");
                }}
                onSelect={() => {
                  setSettingsSection(key as SettingsSection);
                  setActiveView("settings");
                }}
              >
                <Icon className="size-4" />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
