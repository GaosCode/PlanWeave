import { FolderOpenIcon } from "lucide-react";
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
  handleDeleteProject: (project: DesktopProjectSummary) => Promise<void>;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleOpenProject: () => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealProject: (project: DesktopProjectSummary) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  onCanvasSelect: (project: DesktopProjectSummary, canvasId: string) => void;
  onCanvasToggle: (project: DesktopProjectSummary, canvasId: string, isGraphCanvas: boolean) => void;
  onProjectSelect: (project: DesktopProjectSummary) => void;
  onProjectToggle: (project: DesktopProjectSummary, isSelectedProject: boolean) => void;
  onTogglePinnedProject: (projectId: string) => void;
  pinnedProjectIds: Set<string>;
  projects: DesktopProjectSummary[];
  selectedProject: DesktopProjectSummary | null;
  selectedCanvasId: string | null;
  selectedTaskPanelId: string | null;
  t: ReturnType<typeof createTranslator>;
};

export function ProjectTree({
  collapsedCanvasIds,
  collapsedProjectIds,
  expandedProjectId,
  graph,
  handleDeleteProject,
  handleDeleteTaskCanvas,
  handleDeleteTaskNode,
  handleOpenProject,
  handleProjectNewGraph,
  handleRevealProject,
  handleTaskPanelSelect,
  onCanvasSelect,
  onCanvasToggle,
  onProjectSelect,
  onProjectToggle,
  onTogglePinnedProject,
  pinnedProjectIds,
  projects,
  selectedProject,
  selectedCanvasId,
  selectedTaskPanelId,
  t
}: ProjectTreeProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 bg-app-sidebar p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-[0.08em] text-text-faint">{t("projects")}</div>
        <Button className="text-text-muted hover:bg-surface-muted hover:text-text-strong" size="icon-sm" variant="ghost" onClick={handleOpenProject} aria-label={t("chooseProjectFolder")}>
          <FolderOpenIcon data-icon="inline-start" />
        </Button>
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
                handleDeleteProject={handleDeleteProject}
                handleDeleteTaskCanvas={handleDeleteTaskCanvas}
                handleDeleteTaskNode={handleDeleteTaskNode}
                handleProjectNewGraph={handleProjectNewGraph}
                handleRevealProject={handleRevealProject}
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
                selectedCanvasId={selectedCanvasId}
                selectedTaskPanelId={selectedTaskPanelId}
                t={t}
              />
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
