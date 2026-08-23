import {
  AlertTriangleIcon,
  ClipboardIcon,
  CopyIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PencilIcon,
  SquarePenIcon,
  Trash2Icon,
  WorkflowIcon
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";
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
import { AnimatedTreeRegion } from "./AnimatedTreeRegion";
import {
  CanvasTreeSelectButton,
  CanvasTreeToggleButton,
  TaskTreeSelectButton
} from "./CanvasTreePresentation";

type TaskCanvasSummary = DesktopProjectSummary["taskCanvases"][number];

type CanvasTreeItemProps = {
  canvas: TaskCanvasSummary;
  graph: DesktopGraphViewModel | null;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleDuplicateTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleCopyCanvasAgentPrompt?: (project: DesktopProjectSummary, canvas: TaskCanvasSummary) => void;
  handleCopyCanvasToNewProject: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleRevealTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleRevealTaskNode: (
    project: DesktopProjectSummary,
    canvas: TaskCanvasSummary,
    taskId: string
  ) => void;
  handleRenameTaskCanvas: (
    project: DesktopProjectSummary,
    canvasId: string,
    name: string
  ) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  isExpandedCanvas: boolean;
  isGraphCanvas: boolean;
  onCanvasSelect: (project: DesktopProjectSummary, canvasId: string) => void;
  onCanvasToggle: (
    project: DesktopProjectSummary,
    canvasId: string,
    isGraphCanvas: boolean
  ) => void;
  project: DesktopProjectSummary;
  selectedTaskPanelId: string | null;
  t: ReturnType<typeof createTranslator>;
};

export function CanvasTreeItem({
  canvas,
  graph,
  handleDeleteTaskCanvas,
  handleDeleteTaskNode,
  handleDuplicateTaskCanvas,
  handleCopyCanvasAgentPrompt,
  handleCopyCanvasToNewProject,
  handleProjectNewGraph,
  handleRevealTaskCanvas,
  handleRevealTaskNode,
  handleRenameTaskCanvas,
  handleTaskPanelSelect,
  isExpandedCanvas,
  isGraphCanvas,
  onCanvasSelect,
  onCanvasToggle,
  project,
  selectedTaskPanelId,
  t
}: CanvasTreeItemProps) {
  const firstError =
    canvas.diagnostics.find((diagnostic) => diagnostic.severity === "error") ?? null;
  const canvasLabel = canvas.name || t("taskCanvas");
  const displayedTaskCount = graph?.tasks.length ?? canvas.taskCount;
  const openTaskCanvasLabel = fileManagerLabel(t, "taskCanvas");
  const openTaskLabel = fileManagerLabel(t, "task");
  const resetOnlyCanvas = canvas.canvasId === "default" || project.taskCanvases.length === 1;
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(canvasLabel);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const commitStartedRef = useRef(false);

  useEffect(() => {
    if (!isRenaming) {
      setRenameDraft(canvasLabel);
      return;
    }
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [canvasLabel, isRenaming]);

  const startRename = () => {
    commitStartedRef.current = false;
    setRenameDraft(canvasLabel);
    setIsRenaming(true);
  };

  const cancelRename = () => {
    commitStartedRef.current = true;
    setRenameDraft(canvasLabel);
    setIsRenaming(false);
  };

  const commitRename = async () => {
    if (commitStartedRef.current) {
      return;
    }
    commitStartedRef.current = true;
    const nextName = renameDraft.trim();
    setIsRenaming(false);
    if (!nextName || nextName === canvasLabel.trim()) {
      setRenameDraft(canvasLabel);
      return;
    }
    await handleRenameTaskCanvas(project, canvas.canvasId, nextName);
  };

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col overflow-hidden">
      <div className="group/canvas grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-1">
        {isRenaming ? (
          <form
            className="flex h-8 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border border-state-selected/30 bg-state-selected-surface px-2 text-xs text-text-strong shadow-sm [&_svg]:size-4"
            onSubmit={(event) => {
              event.preventDefault();
              void commitRename();
            }}
          >
            <WorkflowIcon className="shrink-0" data-icon="inline-start" />
            <input
              ref={renameInputRef}
              aria-label={t("renameTaskCanvasPrompt")}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
              value={renameDraft}
              onBlur={() => void commitRename()}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
            />
          </form>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <CanvasTreeSelectButton
                ariaLabel={
                  firstError ? `${canvasLabel} ${t("error")}: ${firstError.message}` : undefined
                }
                canvasId={canvas.canvasId}
                label={canvasLabel}
                selected={isGraphCanvas}
                testId={`canvas-select-${canvas.canvasId}`}
                title={firstError ? firstError.message : undefined}
                trailing={
                  firstError ? (
                    <Badge className="shrink-0 gap-1" variant="destructive">
                      <AlertTriangleIcon className="size-3" aria-hidden="true" />
                      {t("error")}
                    </Badge>
                  ) : (
                    <Badge className="shrink-0" variant="outline">
                      {displayedTaskCount}
                    </Badge>
                  )
                }
                onClick={() => onCanvasSelect(project, canvas.canvasId)}
              />
            </ContextMenuTrigger>
            <ContextMenuContent className="w-52">
              <ContextMenuLabel>{canvas.name || t("taskCanvas")}</ContextMenuLabel>
              <ContextMenuItem
                onSelect={() => void handleRevealTaskCanvas(project, canvas.canvasId)}
              >
                <FolderOpenIcon data-icon="inline-start" />
                {openTaskCanvasLabel}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void handleProjectNewGraph(project)}>
                <SquarePenIcon data-icon="inline-start" />
                {t("newGraph")}
              </ContextMenuItem>
              {handleCopyCanvasAgentPrompt ? (
                <ContextMenuItem onSelect={() => handleCopyCanvasAgentPrompt(project, canvas)}>
                  <ClipboardIcon data-icon="inline-start" />
                  {t("copyAgentPrompt")}
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem
                onSelect={() => void handleDuplicateTaskCanvas(project, canvas.canvasId)}
              >
                <CopyIcon data-icon="inline-start" />
                {t("duplicateTaskCanvas")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => void handleCopyCanvasToNewProject(project, canvas.canvasId)}
              >
                <FolderPlusIcon data-icon="inline-start" />
                {t("copyCanvasToNewProject")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={startRename}>
                <PencilIcon data-icon="inline-start" />
                {t("renameTaskCanvas")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={() => void handleDeleteTaskCanvas(project, canvas.canvasId)}
              >
                <Trash2Icon data-icon="inline-start" />
                {resetOnlyCanvas ? t("resetTaskCanvas") : t("deleteTaskCanvas")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
        <CanvasTreeToggleButton
          expanded={isExpandedCanvas}
          t={t}
          testId={`canvas-toggle-${canvas.canvasId}`}
          onToggle={(event) => {
            event.stopPropagation();
            onCanvasToggle(project, canvas.canvasId, isGraphCanvas);
          }}
        />
      </div>
      <AnimatedTreeRegion
        expanded={isExpandedCanvas && graph !== null}
        unmountOnExit
        className="ml-3 flex w-[calc(100%-0.75rem)] min-w-0 max-w-full flex-col gap-1 overflow-hidden border-l border-border/60 pt-1 pl-3"
      >
        {graph
          ? graph.tasks.map((task) => (
              <ContextMenu key={task.taskId}>
                <ContextMenuTrigger asChild>
                  <TaskTreeSelectButton
                    selected={selectedTaskPanelId === task.taskId}
                    task={task}
                    onSelect={() => handleTaskPanelSelect(task.taskId)}
                  />
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuLabel>{task.title}</ContextMenuLabel>
                  <ContextMenuItem
                    onSelect={() => handleRevealTaskNode(project, canvas, task.taskId)}
                  >
                    <FolderOpenIcon data-icon="inline-start" />
                    {openTaskLabel}
                  </ContextMenuItem>
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() => void handleDeleteTaskNode(task.taskId)}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    {t("deleteTask")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))
          : null}
      </AnimatedTreeRegion>
    </div>
  );
}
