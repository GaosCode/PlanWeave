import type {
  DesktopCanvasGraphEdgeViewModel,
  DesktopCanvasGraphViewModel,
  DesktopCanvasNodeViewModel
} from "@planweave-ai/runtime";
import { GitBranchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { createTranslator } from "../i18n";

type CanvasMapInspectorProps = {
  graph: DesktopCanvasGraphViewModel;
  onCanvasOpen: (canvasId: string) => void;
  selectedCanvas: DesktopCanvasNodeViewModel | null;
  selectedCanvasId: string | null;
  selectedEdge: DesktopCanvasGraphEdgeViewModel | null;
  t: ReturnType<typeof createTranslator>;
};

function canvasTitle(t: ReturnType<typeof createTranslator>, titleByCanvasId: Map<string, string>, canvasId: string): string {
  return titleByCanvasId.get(canvasId) ?? `${t("taskCanvas")} ${canvasId}`;
}

function CanvasEdgeInspector({
  edge,
  titleByCanvasId,
  t
}: {
  edge: DesktopCanvasGraphEdgeViewModel;
  titleByCanvasId: Map<string, string>;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{t("canvasDependency")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">{t("from")}</div>
          <div className="font-medium">{canvasTitle(t, titleByCanvasId, edge.from)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{t("type")}</div>
          <Badge variant="outline">{edge.type}</Badge>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{t("to")}</div>
          <div className="font-medium">{canvasTitle(t, titleByCanvasId, edge.to)}</div>
        </div>
        <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
          {t("fromWaitsForTo")}
        </div>
      </CardContent>
    </Card>
  );
}

export function CanvasMapInspector({
  graph,
  onCanvasOpen,
  selectedCanvas,
  selectedCanvasId,
  selectedEdge,
  t
}: CanvasMapInspectorProps) {
  const titleByCanvasId = new Map(graph.canvases.map((canvas) => [canvas.canvasId, canvas.title]));
  const upstreamCanvasIds = graph.edges.filter((edge) => edge.from === selectedCanvasId).map((edge) => edge.to);
  const downstreamCanvasIds = graph.edges.filter((edge) => edge.to === selectedCanvasId).map((edge) => edge.from);
  const relatedCrossTaskEdges = graph.crossTaskEdges.filter(
    (edge) => edge.from.canvasId === selectedCanvasId || edge.to.canvasId === selectedCanvasId
  );

  if (selectedEdge) {
    return <CanvasEdgeInspector edge={selectedEdge} titleByCanvasId={titleByCanvasId} t={t} />;
  }

  if (!selectedCanvas) {
    return <div className="text-sm text-muted-foreground">{t("noCanvasSelected")}</div>;
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center justify-between gap-2 text-sm">
          <span className="truncate">{selectedCanvas.title}</span>
          {selectedCanvas.diagnostics.length > 0 ? <Badge variant="destructive">{t("error")}</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">{t("canvasId")}</div>
          <div className="font-mono text-xs">{selectedCanvas.canvasId}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{t("packageDir")}</div>
          <div className="truncate font-mono text-xs">{selectedCanvas.packageDir}</div>
        </div>
        <CanvasBadgeList ids={upstreamCanvasIds} label={t("upstreamCanvases")} titleByCanvasId={titleByCanvasId} t={t} />
        <CanvasBadgeList ids={downstreamCanvasIds} label={t("downstreamCanvases")} titleByCanvasId={titleByCanvasId} t={t} />
        <div>
          <div className="mb-1 text-xs text-muted-foreground">{t("crossCanvasTasks")}</div>
          <div className="flex flex-col gap-1">
            {relatedCrossTaskEdges.length > 0 ? relatedCrossTaskEdges.map((edge) => (
              <div className="rounded-md border bg-muted/40 p-2 font-mono text-xs" key={`${edge.from.canvasId}:${edge.from.taskId}-${edge.to.canvasId}:${edge.to.taskId}`}>
                {edge.from.canvasId}:{edge.from.taskId}{" -> "}{edge.to.canvasId}:{edge.to.taskId}
              </div>
            )) : <span className="text-xs text-muted-foreground">{t("none")}</span>}
          </div>
        </div>
        {selectedCanvas.diagnostics.length > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="text-xs text-muted-foreground">{t("diagnostics")}</div>
            {selectedCanvas.diagnostics.map((diagnostic) => (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs" key={`${diagnostic.code}-${diagnostic.path ?? ""}-${diagnostic.message}`}>
                <div className="font-medium">{diagnostic.code}</div>
                <div>{diagnostic.message}</div>
              </div>
            ))}
          </div>
        ) : null}
        <Button className="w-full justify-start" onClick={() => onCanvasOpen(selectedCanvas.canvasId)}>
          <GitBranchIcon data-icon="inline-start" />
          {t("enterCanvas")}
        </Button>
      </CardContent>
    </Card>
  );
}

function CanvasBadgeList({
  ids,
  label,
  titleByCanvasId,
  t
}: {
  ids: string[];
  label: string;
  titleByCanvasId: Map<string, string>;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1">
        {ids.length > 0 ? ids.map((canvasId) => (
          <Badge key={canvasId} variant="outline">
            {canvasTitle(t, titleByCanvasId, canvasId)}
          </Badge>
        )) : <span className="text-xs text-muted-foreground">{t("none")}</span>}
      </div>
    </div>
  );
}
