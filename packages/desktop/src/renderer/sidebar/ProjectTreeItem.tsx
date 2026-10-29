import type { ProjectRenameHandler, TaskCanvasRenameHandler } from "../renameResult";
import {
  ChevronRightIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PencilIcon,
  PinIcon,
  SquarePenIcon,
  Trash2Icon
} from "lucide-react";
import { type Dispatch, type DragEvent, type SetStateAction } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { fileManagerLabel } from "../fileManagerLabels";
import type { createTranslator } from "../i18n";
import { useInlineRename } from "../hooks/useInlineRename";
import { AnimatedTreeRegion } from "./AnimatedTreeRegion";
import { CanvasTreeItem } from "./CanvasTreeItem";

type TaskCanvasSummary = DesktopProjectSummary["taskCanvases"][number];

type ProjectTreeItemProps = {
  collapsedCanvasIds: Set<string>;
  graph: DesktopGraphViewModel | null;
  handleBindSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleCopyCanvasToNewProject: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteProject: (project: DesktopProjectSummary) => Promise<void>;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleDuplicateTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleCopyCanvasAgentPrompt?: (project: DesktopProjectSummary, canvas: TaskCanvasSummary) => void;
  handleDropSourceRoot: (
    project: DesktopProjectSummary,
    sourceRoot: string | null
  ) => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealPlanWorkspace: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealProject: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleRevealTaskNode: (
    project: DesktopProjectSummary,
    canvas: TaskCanvasSummary,
    taskId: string
  ) => void;
  handleRenameProject: ProjectRenameHandler;
  handleRenameTaskCanvas: TaskCanvasRenameHandler;
  handleUnlinkSourceRoot: (project: DesktopProjectSummary) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  isExpandedProject: boolean;
  isPinnedProject: boolean;
  isSelectedProject: boolean;
  onCanvasSelect: (project: DesktopProjectSummary, canvasId: string) => void;
  onCanvasToggle: (
    project: DesktopProjectSummary,
    canvasId: string,
    isGraphCanvas: boolean
  ) => void;
  onProjectSelect: (project: DesktopProjectSummary) => void;
  onProjectToggle: (project: DesktopProjectSummary, isSelectedProject: boolean) => void;
  onTogglePinnedProject: (projectId: string) => void;
  project: DesktopProjectSummary;
  renamingProjectId: string | null;
  selectedCanvasId: string | null;
  onRenameStart: () => void;
  renameScopeKey: string;
  selectedTaskPanelId: string | null;
  setRenamingProjectId: Dispatch<SetStateAction<string | null>>;
  t: ReturnType<typeof createTranslator>;
};

export function ProjectTreeItem({
  collapsedCanvasIds,
  graph,
  handleBindSourceRoot,
  handleCopyCanvasToNewProject,
  handleDeleteProject,
  handleDeleteTaskCanvas,
  handleDeleteTaskNode,
  handleDuplicateTaskCanvas,
  handleCopyCanvasAgentPrompt,
  handleDropSourceRoot,
  handleProjectNewGraph,
  handleRevealPlanWorkspace,
  handleRevealProject,
  handleRevealSourceRoot,
  handleRevealTaskCanvas,
  handleRevealTaskNode,
  handleRenameProject,
  handleRenameTaskCanvas,
  handleUnlinkSourceRoot,
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
  renamingProjectId,
  selectedCanvasId,
  onRenameStart,
  renameScopeKey,
  selectedTaskPanelId,
  setRenamingProjectId,
  t
}: ProjectTreeItemProps) {
  const canBindSourceRoot = project.kind === "managed";
  const hasSourceRoot = Boolean(project.sourceRoot);
  const isRenamingProject = renamingProjectId === project.projectId;
  const openPlanWorkspaceLabel = fileManagerLabel(t, "planWorkspace");
  const openSourceRootLabel = fileManagerLabel(t, "sourceRoot");
  const rename = useInlineRename({
    active: isRenamingProject,
    name: project.name,
    scopeKey: renameScopeKey,
    onClose: () =>
      setRenamingProjectId((current) => (current === project.projectId ? null : current)),
    onSave: (name, request) => handleRenameProject(project, name, request)
  });
  const droppedPath = (event: DragEvent<HTMLElement>): string | null => {
    const file = event.dataTransfer.files[0] as (File & { path?: string }) | undefined;
    return file?.path ?? null;
  };

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col">
      <div className="group/project grid w-full min-w-0 max-w-full grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-1">
        <Button
          aria-expanded={isExpandedProject}
          aria-label={isExpandedProject ? t("collapseProject") : t("expandProject")}
          className="relative z-10 size-7 shrink-0 border-0 bg-transparent text-text-faint shadow-none opacity-100 hover:bg-surface-muted hover:text-text-strong focus-visible:ring-ring/40"
          size="icon-sm"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            onProjectToggle(project, isSelectedProject);
          }}
        >
          <ChevronRightIcon
            className={cn(
              "size-4 transition-transform duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)]",
              isExpandedProject ? "rotate-90" : "rotate-0"
            )}
          />
        </Button>
        {isRenamingProject ? (
          <form
            className="flex h-8 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border border-state-selected/30 bg-state-selected-surface px-2 text-sm text-text-strong shadow-sm [&_svg]:size-4"
            onSubmit={(event) => {
              event.preventDefault();
              void rename.commit();
            }}
          >
            <GitBranchIcon className="shrink-0" data-icon="inline-start" />
            <input
              ref={rename.inputRef}
              aria-label={t("renameProjectPrompt")}
              aria-invalid={rename.failed}
              aria-busy={rename.pending}
              readOnly={rename.pending}
              className="min-w-0 flex-1 bg-transparent font-medium outline-none"
              value={rename.draft}
              onBlur={() => void rename.commit()}
              onChange={(event) => rename.setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  rename.cancel();
                }
              }}
            />
          </form>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <Button
                className="h-8 w-full min-w-0 max-w-full flex-1 justify-start overflow-hidden rounded-md px-2 text-left text-sm text-text-muted hover:bg-surface-muted hover:text-text-strong data-[variant=secondary]:border-state-selected/25 data-[variant=secondary]:bg-state-selected-surface data-[variant=secondary]:text-text-strong data-[variant=secondary]:shadow-sm [&_svg]:size-4"
                variant={isSelectedProject ? "secondary" : "ghost"}
                onDragOver={(event) => {
                  if (!canBindSourceRoot) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "link";
                }}
                onDrop={(event) => {
                  if (!canBindSourceRoot) {
                    return;
                  }
                  event.preventDefault();
                  void handleDropSourceRoot(project, droppedPath(event));
                }}
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
              {project.kind === "managed" ? (
                <>
                  <ContextMenuItem onSelect={() => void handleRevealPlanWorkspace(project)}>
                    <FolderOpenIcon data-icon="inline-start" />
                    {openPlanWorkspaceLabel}
                  </ContextMenuItem>
                  {hasSourceRoot ? (
                    <>
                      <ContextMenuItem onSelect={() => void handleRevealSourceRoot(project)}>
                        <GitBranchIcon data-icon="inline-start" />
                        {openSourceRootLabel}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => void handleBindSourceRoot(project)}>
                        <GitBranchIcon data-icon="inline-start" />
                        {t("changeSourceRoot")}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => void handleUnlinkSourceRoot(project)}>
                        <GitBranchIcon data-icon="inline-start" />
                        {t("unlinkSourceRoot")}
                      </ContextMenuItem>
                    </>
                  ) : (
                    <ContextMenuItem onSelect={() => void handleBindSourceRoot(project)}>
                      <GitBranchIcon data-icon="inline-start" />
                      {t("bindSourceRoot")}
                    </ContextMenuItem>
                  )}
                </>
              ) : (
                <>
                  <ContextMenuItem onSelect={() => void handleRevealPlanWorkspace(project)}>
                    <FolderOpenIcon data-icon="inline-start" />
                    {openPlanWorkspaceLabel}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => void handleRevealProject(project)}>
                    <GitBranchIcon data-icon="inline-start" />
                    {openSourceRootLabel}
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuItem onSelect={() => void handleProjectNewGraph(project)}>
                <SquarePenIcon data-icon="inline-start" />
                {t("newGraph")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  onRenameStart();
                  setRenamingProjectId(project.projectId);
                }}
              >
                <PencilIcon data-icon="inline-start" />
                {t("renameProject")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={() => void handleDeleteProject(project)}
              >
                <Trash2Icon data-icon="inline-start" />
                {t("deleteProject")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>
      <AnimatedTreeRegion
        expanded={isExpandedProject}
        unmountOnExit
        className="ml-3 flex w-[calc(100%-0.75rem)] min-w-0 max-w-full flex-col gap-1 overflow-hidden border-l border-border/60 pt-1 pl-4"
      >
        {project.taskCanvases.map((canvas) => {
          const isSelectedCanvas = selectedCanvasId === canvas.canvasId;
          const isGraphCanvas =
            isSelectedCanvas ||
            (selectedCanvasId === null && isSelectedProject && project.taskCanvases.length === 1);
          const isExpandedCanvas = isGraphCanvas && !collapsedCanvasIds.has(canvas.canvasId);
          return (
            <CanvasTreeItem
              canvas={canvas}
              graph={isGraphCanvas ? graph : null}
              handleDeleteTaskCanvas={handleDeleteTaskCanvas}
              handleDeleteTaskNode={handleDeleteTaskNode}
              handleDuplicateTaskCanvas={handleDuplicateTaskCanvas}
              handleCopyCanvasAgentPrompt={handleCopyCanvasAgentPrompt}
              handleCopyCanvasToNewProject={handleCopyCanvasToNewProject}
              handleProjectNewGraph={handleProjectNewGraph}
              handleRevealTaskCanvas={handleRevealTaskCanvas}
              handleRevealTaskNode={handleRevealTaskNode}
              handleRenameTaskCanvas={handleRenameTaskCanvas}
              handleTaskPanelSelect={handleTaskPanelSelect}
              isExpandedCanvas={isExpandedCanvas}
              isGraphCanvas={isGraphCanvas}
              key={canvas.canvasId}
              onCanvasSelect={onCanvasSelect}
              onCanvasToggle={onCanvasToggle}
              project={project}
              onRenameStart={onRenameStart}
              renameScopeKey={renameScopeKey}
              selectedTaskPanelId={selectedTaskPanelId}
              t={t}
            />
          );
        })}
      </AnimatedTreeRegion>
    </div>
  );
}
