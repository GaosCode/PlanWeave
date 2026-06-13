import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangleIcon, ArrowRightIcon, NetworkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CanvasFlowNode } from "../types";

export function CanvasNodeCard({ data }: NodeProps<CanvasFlowNode>) {
  const hasDiagnostics = data.canvas.diagnostics.length > 0;

  return (
    <Card
      className={cn(
        "w-[280px] border bg-card shadow-sm",
        data.selected ? "border-primary ring-2 ring-primary/25" : "border-border",
        hasDiagnostics ? "border-destructive/70" : null
      )}
      size="sm"
      onClick={() => data.onSelect(data.canvas.canvasId)}
      onDoubleClick={() => data.onOpen(data.canvas.canvasId)}
    >
      <Handle type="target" position={Position.Left} />
      <CardHeader className="min-h-12">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
          <NetworkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{data.canvas.title}</span>
          {hasDiagnostics ? (
            <Badge className="shrink-0 gap-1" variant="destructive">
              <AlertTriangleIcon className="size-3" aria-hidden="true" />
              {data.labels.error}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 text-xs text-muted-foreground">
          <div className="truncate">{data.canvas.canvasId}</div>
          <div className="truncate">{data.canvas.packageDir}</div>
        </div>
        <Button size="icon-sm" variant="outline" aria-label={data.labels.open} onClick={() => data.onOpen(data.canvas.canvasId)}>
          <ArrowRightIcon data-icon="inline-start" />
        </Button>
      </CardContent>
      <Handle type="source" position={Position.Right} />
    </Card>
  );
}
