import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangleIcon, ArrowRightIcon, NetworkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { CanvasFlowNode } from "../types";

export function CanvasNodeCard({ data }: NodeProps<CanvasFlowNode>) {
  const hasDiagnostics = data.canvas.diagnostics.length > 0;
  const healthSeverity = data.health?.severity ?? "ok";
  const diagnosticCount = data.health?.diagnosticCount ?? 0;
  const blockerCount = data.health?.blockerCount ?? 0;
  const hasErrorHealth = healthSeverity === "error";
  const hasWarningDiagnostics = healthSeverity === "warning" && diagnosticCount > 0;
  const hasDependencyWait = blockerCount > 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          className={cn(
            "w-[280px] border bg-surface-raised text-text shadow-sm transition-[border-color,box-shadow] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)]",
            data.selected ? "border-state-selected shadow-md ring-2 ring-state-selected/25" : "border-border/80",
            hasDiagnostics || hasErrorHealth ? "border-state-failed/70 bg-state-failed-surface" : null,
            !hasDiagnostics && hasWarningDiagnostics ? "border-state-warning/75 bg-state-warning-surface" : null
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
              {hasDiagnostics ? (
                <Badge className="shrink-0 gap-1" variant="destructive">
                  <AlertTriangleIcon className="size-3" aria-hidden="true" />
                  {data.labels.error}
                </Badge>
              ) : hasErrorHealth ? (
                <Badge className="shrink-0 gap-1" variant="destructive">
                  <AlertTriangleIcon className="size-3" aria-hidden="true" />
                  {data.labels.error}
                </Badge>
              ) : hasWarningDiagnostics ? (
                <Badge className="shrink-0 gap-1" variant="secondary">
                  <AlertTriangleIcon className="size-3" aria-hidden="true" />
                  {data.labels.warning}
                </Badge>
              ) : hasDependencyWait ? (
                <Badge className="shrink-0" variant="secondary">
                  {data.labels.dependency}
                </Badge>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0 text-xs text-text-muted">
              <div className="truncate">{data.canvas.canvasId}</div>
              <div className="truncate" title={data.canvas.packageDir}>{data.canvas.packageDir}</div>
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
          {data.labels.copyAgentPrompt}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
