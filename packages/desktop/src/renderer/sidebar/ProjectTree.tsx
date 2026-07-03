import { FolderOpenIcon, RefreshCwIcon } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { createTranslator } from "../i18n";
import { ProjectTreeItem } from "./ProjectTreeItem";

type ProjectTreeProps = {
  collapsedCanvasIds: Set<string>;
  collapsedProjectIds: Set<string>;
  expandedProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  handleBindSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleCopyCanvasToNewProject: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteProject: (project: DesktopProjectSummary) => Promise<void>;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleDuplicateTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleCopyCanvasAgentPrompt?: (project: DesktopProjectSummary, canvasId: string) => void;
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
  onCanvasSelect: (project: DesktopProjectSummary, canvasId: string) => void;
  onCanvasToggle: (project: DesktopProjectSummary, canvasId: string, isGraphCanvas: boolean) => void;
  onProjectSelect: (project: DesktopProjectSummary) => void;
  onProjectToggle: (project: DesktopProjectSummary, isSelectedProject: boolean) => void;
  onTogglePinnedProject: (projectId: string) => void;
  pinnedProjectIds: Set<string>;
  projectRefreshing: boolean;
  projects: DesktopProjectSummary[];
  renamingProjectId: string | null;
  selectedProject: DesktopProjectSummary | null;
  selectedCanvasId: string | null;
  selectedTaskPanelId: string | null;
  setRenamingProjectId: Dispatch<SetStateAction<string | null>>;
  t: ReturnType<typeof createTranslator>;
};

export function ProjectTree({
  collapsedCanvasIds,
  collapsedProjectIds,
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
  onCanvasSelect,
  onCanvasToggle,
  onProjectSelect,
  onProjectToggle,
  onTogglePinnedProject,
  pinnedProjectIds,
  projectRefreshing,
  projects,
  renamingProjectId,
  selectedProject,
  selectedCanvasId,
  selectedTaskPanelId,
  setRenamingProjectId,
  t
}: ProjectTreeProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-[0.08em] text-text-faint">{t("projects")}</div>
        <div className="flex items-center gap-1">
          <Button className="text-text-muted hover:bg-surface-muted hover:text-text-strong" size="icon-sm" variant="ghost" onClick={() => void handleRefreshProjects()} aria-label={t("refreshProjects")} disabled={projectRefreshing}>
            <RefreshCwIcon className={projectRefreshing ? "animate-spin" : undefined} data-icon="inline-start" />
          </Button>
          <Button className="text-text-muted hover:bg-surface-muted hover:text-text-strong" size="icon-sm" variant="ghost" onClick={handleOpenProject} aria-label={t("chooseProjectFolder")}>
            <FolderOpenIcon data-icon="inline-start" />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 overflow-x-hidden" viewportClassName="[&>div]:!block [&>div]:!min-w-0 [&>div]:!w-full">
        <div className="flex w-full min-w-0 max-w-full flex-col gap-1 overflow-x-hidden pr-2">
          {projects.length === 0 ? <div className="rounded-md border border-border/70 bg-surface-muted/70 px-3 py-2 text-sm text-text-muted">{t("projectMissing")}</div> : null}
          {projects.map((project) => {
            const isSelectedProject = selectedProject?.projectId === project.projectId;
            const isExpandedProject = expandedProjectId === project.projectId && isSelectedProject && !collapsedProjectIds.has(project.projectId);
            return (
              <ProjectTreeItem
                collapsedCanvasIds={collapsedCanvasIds}
                graph={graph}
                handleBindSourceRoot={handleBindSourceRoot}
                handleCopyCanvasToNewProject={handleCopyCanvasToNewProject}
                handleDeleteProject={handleDeleteProject}
                handleDeleteTaskCanvas={handleDeleteTaskCanvas}
                handleDeleteTaskNode={handleDeleteTaskNode}
                handleDuplicateTaskCanvas={handleDuplicateTaskCanvas}
                handleCopyCanvasAgentPrompt={handleCopyCanvasAgentPrompt}
                handleDropSourceRoot={handleDropSourceRoot}
                handleProjectNewGraph={handleProjectNewGraph}
                handleRevealPlanWorkspace={handleRevealPlanWorkspace}
                handleRevealProject={handleRevealProject}
                handleRevealSourceRoot={handleRevealSourceRoot}
                handleRevealTaskCanvas={handleRevealTaskCanvas}
                handleRenameProject={handleRenameProject}
                handleRenameTaskCanvas={handleRenameTaskCanvas}
                handleUnlinkSourceRoot={handleUnlinkSourceRoot}
                handleTaskPanelSelect={handleTaskPanelSelect}
                isExpandedProject={isExpandedProject}
                isPinnedProject={pinnedProjectIds.has(project.projectId)}
                isSelectedProject={isSelectedProject}
                key={project.projectId}
                onCanvasSelect={onCanvasSelect}
                onCanvasToggle={onCanvasToggle}
                onProjectSelect={onProjectSelect}
                onProjectToggle={onProjectToggle}
                onTogglePinnedProject={onTogglePinnedProject}
                project={project}
                renamingProjectId={renamingProjectId}
                selectedCanvasId={selectedCanvasId}
                selectedTaskPanelId={selectedTaskPanelId}
                setRenamingProjectId={setRenamingProjectId}
                t={t}
              />
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
