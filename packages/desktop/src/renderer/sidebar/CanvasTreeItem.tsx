import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SquarePenIcon,
  Trash2Icon,
  WorkflowIcon
} from "lucide-react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
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
import type { createTranslator } from "../i18n";
import { statusVariant } from "../viewHelpers";

type TaskCanvasSummary = DesktopProjectSummary["taskCanvases"][number];

type CanvasTreeItemProps = {
  canvas: TaskCanvasSummary;
  graph: DesktopGraphViewModel | null;
  handleDeleteTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleDeleteTaskNode: (taskId: string) => Promise<void>;
  handleProjectNewGraph: (project: DesktopProjectSummary) => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  isExpandedCanvas: boolean;
  isGraphCanvas: boolean;
  onCanvasSelect: (project: DesktopProjectSummary, canvasId: string) => void;
  onCanvasToggle: (project: DesktopProjectSummary, canvasId: string, isGraphCanvas: boolean) => void;
  project: DesktopProjectSummary;
  selectedTaskPanelId: string | null;
  t: ReturnType<typeof createTranslator>;
};

export function CanvasTreeItem({
  canvas,
  graph,
  handleDeleteTaskCanvas,
  handleDeleteTaskNode,
  handleProjectNewGraph,
  handleTaskPanelSelect,
  isExpandedCanvas,
  isGraphCanvas,
  onCanvasSelect,
  onCanvasToggle,
  project,
  selectedTaskPanelId,
  t
}: CanvasTreeItemProps) {
  const firstDiagnostic = canvas.diagnostics?.[0] ?? null;
  const canvasLabel = canvas.name || t("taskCanvas");

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-1 overflow-hidden">
      <div className="group/canvas grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-1">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <Button
              aria-label={firstDiagnostic ? `${canvasLabel} ${t("error")}: ${firstDiagnostic.message}` : undefined}
              aria-current={isGraphCanvas ? "page" : undefined}
              className="h-8 w-full min-w-0 max-w-full flex-1 justify-between gap-2 overflow-hidden px-2 text-xs"
              title={firstDiagnostic ? firstDiagnostic.message : undefined}
              variant={isGraphCanvas ? "secondary" : "ghost"}
              onClick={() => onCanvasSelect(project, canvas.canvasId)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                <WorkflowIcon className="shrink-0" data-icon="inline-start" />
                <span className="truncate">{canvasLabel}</span>
              </span>
              {firstDiagnostic ? (
                <Badge className="shrink-0 gap-1" variant="destructive">
                  <AlertTriangleIcon className="size-3" aria-hidden="true" />
                  {t("error")}
                </Badge>
              ) : (
                <Badge className="shrink-0" variant="outline">
                  {canvas.taskCount}
                </Badge>
              )}
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
          aria-expanded={isExpandedCanvas}
          aria-label={isExpandedCanvas ? t("collapseTaskCanvas") : t("expandTaskCanvas")}
          className="relative z-10 h-8 w-7 shrink-0 border-0 bg-transparent text-muted-foreground shadow-none opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          data-testid={`canvas-toggle-${canvas.canvasId}`}
          size="icon-sm"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            onCanvasToggle(project, canvas.canvasId, isGraphCanvas);
          }}
        >
          {isExpandedCanvas ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
        </Button>
      </div>
      {isExpandedCanvas && graph ? (
        <div className="flex w-full min-w-0 max-w-full flex-col gap-1 overflow-hidden pl-4">
          {graph.tasks.map((task) => (
            <ContextMenu key={task.taskId}>
              <ContextMenuTrigger asChild>
                <Button
                  className="h-8 w-full min-w-0 max-w-full shrink justify-start gap-2 overflow-hidden rounded-md bg-muted/60 px-2 text-xs text-foreground hover:bg-muted"
                  variant={selectedTaskPanelId === task.taskId ? "secondary" : "ghost"}
                  onClick={() => handleTaskPanelSelect(task.taskId)}
                >
                  <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">{task.title}</span>
                  <Badge className="ml-auto shrink-0 border-border bg-background text-xs text-foreground" variant={task.exceptions.length > 0 ? "destructive" : statusVariant[task.status]}>
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
}
