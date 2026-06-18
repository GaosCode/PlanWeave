import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PencilIcon,
  PinIcon,
  SquarePenIcon,
  Trash2Icon
} from "lucide-react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import type { createTranslator } from "../i18n";
import { CanvasTreeItem } from "./CanvasTreeItem";

type ProjectTreeItemProps = {
  collapsedCanvasIds: Set<string>;
  graph: DesktopGraphViewModel | null;
  handleDeleteProject: (project: DesktopProjectSummary) => Promise<void>;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealProject: (project: DesktopProjectSummary) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  isExpandedProject: boolean;
  isPinnedProject: boolean;
  isSelectedProject: boolean;
  onCanvasSelect: (project: DesktopProjectSummary, canvasId: string) => void;
  onCanvasToggle: (project: DesktopProjectSummary, canvasId: string, isGraphCanvas: boolean) => void;
  onProjectSelect: (project: DesktopProjectSummary) => void;
  onProjectToggle: (project: DesktopProjectSummary, isSelectedProject: boolean) => void;
  onTogglePinnedProject: (projectId: string) => void;
  project: DesktopProjectSummary;
  selectedCanvasId: string | null;
  selectedTaskPanelId: string | null;
  t: ReturnType<typeof createTranslator>;
};

export function ProjectTreeItem({
  collapsedCanvasIds,
  graph,
  handleDeleteProject,
  handleDeleteTaskCanvas,
  handleDeleteTaskNode,
  handleProjectNewGraph,
  handleRevealProject,
  handleTaskPanelSelect,
  isExpandedProject,
  isPinnedProject,
  isSelectedProject,
  onCanvasSelect,
  onCanvasToggle,
  onProjectSelect,
  onProjectToggle,
  onTogglePinnedProject,
  project,
  selectedCanvasId,
  selectedTaskPanelId,
  t
}: ProjectTreeItemProps) {
  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-1">
      <div className="group/project grid w-full min-w-0 max-w-full grid-cols-[2rem_minmax(0,1fr)] items-center gap-1">
        <Button
          aria-label={isExpandedProject ? t("collapseProject") : t("expandProject")}
          className="relative z-10 size-7 shrink-0 border-0 bg-transparent text-muted-foreground shadow-none opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          size="icon-sm"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            onProjectToggle(project, isSelectedProject);
          }}
        >
          {isExpandedProject ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
        </Button>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <Button
              className="h-auto w-full min-w-0 max-w-full flex-1 justify-start overflow-hidden whitespace-normal py-2 text-left"
              variant={isSelectedProject ? "secondary" : "ghost"}
              onClick={() => onProjectSelect(project)}
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
      </div>
      {isExpandedProject ? (
        <div className="flex w-full min-w-0 max-w-full flex-col gap-1 overflow-hidden pl-5">
          {project.taskCanvases.map((canvas) => {
            const isSelectedCanvas = selectedCanvasId === canvas.canvasId;
            const isGraphCanvas = isSelectedCanvas || (selectedCanvasId === null && isSelectedProject && project.taskCanvases.length === 1);
            const isExpandedCanvas = isGraphCanvas && !collapsedCanvasIds.has(canvas.canvasId);
            return (
              <CanvasTreeItem
                canvas={canvas}
                graph={graph}
                handleDeleteTaskCanvas={handleDeleteTaskCanvas}
                handleDeleteTaskNode={handleDeleteTaskNode}
                handleProjectNewGraph={handleProjectNewGraph}
                handleTaskPanelSelect={handleTaskPanelSelect}
                isExpandedCanvas={isExpandedCanvas}
                isGraphCanvas={isGraphCanvas}
                key={canvas.canvasId}
                onCanvasSelect={onCanvasSelect}
                onCanvasToggle={onCanvasToggle}
                project={project}
                selectedTaskPanelId={selectedTaskPanelId}
                t={t}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
