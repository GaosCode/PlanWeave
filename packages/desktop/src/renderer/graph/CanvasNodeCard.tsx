import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  ClipboardIcon,
  FolderOpenIcon,
  NetworkIcon,
  PencilIcon
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { CanvasFlowNode, CanvasNodeData } from "../types";
import { TaskNodeStatusMarker, taskNodeStatusVisual } from "./taskNodeStatus";

function CanvasNodeMarker({
  data,
  hasDependencyWait,
  hasProblem,
  showWarning
}: {
  data: CanvasNodeData;
  hasDependencyWait: boolean;
  hasProblem: boolean;
  showWarning: boolean;
}) {
  const showsExecutionStatus =
    hasProblem || data.canvas.status === "in_progress" || data.canvas.status === "implemented";
  if (showsExecutionStatus) {
    let label = data.canvas.status ?? "";
    if (hasProblem) {
      label = data.labels.error;
    }
    return (
      <TaskNodeStatusMarker
        hasException={hasProblem}
        label={label}
        status={data.canvas.status ?? ""}
      />
    );
  }
  if (showWarning) {
    return (
      <Badge
        className="shrink-0 gap-1 border-state-warning/60 bg-state-warning-surface text-text-strong"
        variant="secondary"
      >
        <AlertTriangleIcon className="size-3" aria-hidden="true" />
        {data.labels.warning}
      </Badge>
    );
  }
  if (hasDependencyWait) {
    return (
      <Badge className="shrink-0" variant="secondary">
        {data.labels.dependency}
      </Badge>
    );
  }
  return null;
}

export function CanvasNodeCard({ data }: NodeProps<CanvasFlowNode>) {
  const hasErrorDiagnostics = data.canvas.diagnostics.some(
    (diagnostic) => diagnostic.severity === "error"
  );
  const hasWarningDiagnostics = data.canvas.diagnostics.some(
    (diagnostic) => diagnostic.severity === "warning"
  );
  const healthSeverity = data.health?.severity ?? "ok";
  const diagnosticCount = data.health?.diagnosticCount ?? 0;
  const hasErrorHealth = !hasErrorDiagnostics && healthSeverity === "error";
  const hasWarningHealth =
    !(hasErrorDiagnostics || hasWarningDiagnostics) &&
    healthSeverity === "warning" &&
    diagnosticCount > 0;
  const hasDependencyWait = (data.health?.blockerCount ?? 0) > 0;
  const showWarning = hasWarningDiagnostics || hasWarningHealth;
  const hasProblem = hasErrorDiagnostics || hasErrorHealth;
  const statusVisual = taskNodeStatusVisual(data.canvas.status ?? "", hasProblem);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          className={cn(
            "w-[280px] border transition-[border-color,box-shadow] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)]",
            statusVisual.cardClassName,
            data.selected ? "border-state-selected shadow-md ring-2 ring-state-selected/25" : null,
            !hasProblem && statusVisual.tone === "neutral" && showWarning
              ? "border-state-warning/75 bg-state-warning-surface"
              : null
          )}
          size="sm"
          onClick={() => data.onSelect(data.canvas.canvasId)}
          onDoubleClick={() => data.onOpen(data.canvas.canvasId)}
        >
          <Handle type="target" position={Position.Left} />
          <CardHeader className="min-h-12">
            <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
              <NetworkIcon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{data.canvas.title}</span>
              <CanvasNodeMarker
                data={data}
                hasDependencyWait={hasDependencyWait}
                hasProblem={hasProblem}
                showWarning={showWarning}
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0 text-xs text-text-muted">
              <div className="truncate">{data.canvas.canvasId}</div>
              <div className="truncate" title={data.canvas.packageDir}>
                {data.canvas.packageDir}
              </div>
            </div>
            <Button
              className="border-border/80 bg-surface-base text-text-muted hover:bg-surface-muted hover:text-text-strong"
              size="icon-sm"
              variant="outline"
              aria-label={data.labels.open}
              onClick={() => data.onOpen(data.canvas.canvasId)}
            >
              <ArrowRightIcon data-icon="inline-start" />
            </Button>
          </CardContent>
          <Handle type="source" position={Position.Right} />
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => data.onAgentPromptCopy(data.canvas)}>
          <ClipboardIcon data-icon="inline-start" />
          {data.labels.copyAgentPrompt}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => data.onRevealInFinder(data.canvas.canvasId)}>
          <FolderOpenIcon data-icon="inline-start" />
          {data.labels.openInFileManager}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => data.onRename(data.canvas)}>
          <PencilIcon data-icon="inline-start" />
          {data.labels.rename}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
