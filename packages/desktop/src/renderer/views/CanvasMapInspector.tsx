import type {
  DesktopCanvasExecutionPolicy,
  DesktopCanvasGraphEdgeViewModel,
  DesktopCanvasGraphViewModel,
  DesktopCanvasNodeViewModel
} from "@planweave-ai/runtime";
import { useEffect, useMemo, useState } from "react";
import { GitBranchIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import { CanvasMapBlockedBlocksList, CanvasMapHealthDiagnostics } from "./CanvasMapHealthDetails";

type CanvasMapInspectorProps = {
  graph: DesktopCanvasGraphViewModel;
  onClose: () => void;
  onBlockOpen: (canvasId: string, blockRef: string) => void;
  onCanvasOpen: (canvasId: string) => void;
  onExecutionPolicySave: (canvasId: string, input: DesktopCanvasExecutionPolicy) => Promise<void>;
  onTaskOpen: (canvasId: string, taskId: string) => void;
  selectedCanvas: DesktopCanvasNodeViewModel | null;
  selectedCanvasId: string | null;
  selectedEdge: DesktopCanvasGraphEdgeViewModel | null;
  t: ReturnType<typeof createTranslator>;
};

function canvasTitle(
  t: ReturnType<typeof createTranslator>,
  titleByCanvasId: Map<string, string>,
  canvasId: string
): string {
  return titleByCanvasId.get(canvasId) ?? `${t("taskCanvas")} ${canvasId}`;
}

function CanvasEdgeInspector({
  edge,
  graph,
  onBlockOpen,
  onCanvasOpen,
  onTaskOpen,
  titleByCanvasId,
  t
}: {
  edge: DesktopCanvasGraphEdgeViewModel;
  graph: DesktopCanvasGraphViewModel;
  onBlockOpen: (canvasId: string, blockRef: string) => void;
  onCanvasOpen: (canvasId: string) => void;
  onTaskOpen: (canvasId: string, taskId: string) => void;
  titleByCanvasId: Map<string, string>;
  t: ReturnType<typeof createTranslator>;
}) {
  const edgeHealth = graph.health.edges.find(
    (summary) => summary.from === edge.from && summary.to === edge.to && summary.type === edge.type
  );
  const blockers = graph.health.blockedBlocks.filter(
    (item) =>
      item.blocked.canvasId === edge.from &&
      item.blockers.some((blocker) => blocker.canvasId === edge.to)
  );
  return (
    <Card className="min-w-0 max-w-full overflow-hidden" size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span>{t("canvasDependency")}</span>
          {edgeHealth && edgeHealth.severity !== "ok" ? (
            <Badge variant="secondary">{t("dependencyHealth")}</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{t("from")}</div>
          <div className="truncate font-medium" title={canvasTitle(t, titleByCanvasId, edge.from)}>
            {canvasTitle(t, titleByCanvasId, edge.from)}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{t("type")}</div>
          <Badge variant="outline">{edge.type}</Badge>
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{t("to")}</div>
          <div className="truncate font-medium" title={canvasTitle(t, titleByCanvasId, edge.to)}>
            {canvasTitle(t, titleByCanvasId, edge.to)}
          </div>
        </div>
        <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
          {t("fromWaitsForTo")}
        </div>
        <CanvasMapBlockedBlocksList
          blockers={blockers}
          onBlockOpen={onBlockOpen}
          onCanvasOpen={onCanvasOpen}
          onTaskOpen={onTaskOpen}
          t={t}
        />
      </CardContent>
    </Card>
  );
}

function parsePositiveIntegerInput(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function CanvasExecutionPolicyEditor({
  canvas,
  onSave,
  t
}: {
  canvas: DesktopCanvasNodeViewModel;
  onSave: (canvasId: string, input: DesktopCanvasExecutionPolicy) => Promise<void>;
  t: ReturnType<typeof createTranslator>;
}) {
  const policy = canvas.executionPolicy;
  const [parallelEnabled, setParallelEnabled] = useState(policy?.parallelEnabled ?? false);
  const [maxConcurrentDraft, setMaxConcurrentDraft] = useState(
    policy ? String(policy.maxConcurrent) : ""
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void canvas.canvasId;
    setParallelEnabled(policy?.parallelEnabled ?? false);
    setMaxConcurrentDraft(policy ? String(policy.maxConcurrent) : "");
    setSaving(false);
  }, [canvas.canvasId, policy]);

  const parsedMaxConcurrent = useMemo(
    () => parsePositiveIntegerInput(maxConcurrentDraft),
    [maxConcurrentDraft]
  );
  const validationMessage =
    policy && parsedMaxConcurrent === null ? t("maxConcurrentPositiveInteger") : null;
  const dirty = Boolean(
    policy &&
      parsedMaxConcurrent !== null &&
      (parallelEnabled !== policy.parallelEnabled || parsedMaxConcurrent !== policy.maxConcurrent)
  );
  const canSave = Boolean(policy && dirty && !saving && !validationMessage);

  const savePolicy = async () => {
    if (!policy || parsedMaxConcurrent === null || saving) {
      return;
    }
    setSaving(true);
    await onSave(canvas.canvasId, {
      parallelEnabled,
      maxConcurrent: parsedMaxConcurrent
    });
    setSaving(false);
  };

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden rounded-md border bg-muted/30 p-3">
      <div className="text-xs font-semibold uppercase text-muted-foreground">
        {t("executionPolicy")}
      </div>
      {policy ? (
        <>
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("parallelExecution")}</div>
              {!parallelEnabled ? (
                <div className="text-xs text-muted-foreground">{t("parallelClaimsDisabled")}</div>
              ) : null}
            </div>
            <Switch
              aria-label={t("parallelExecution")}
              checked={parallelEnabled}
              disabled={saving}
              onCheckedChange={setParallelEnabled}
            />
          </div>
          <label
            className="flex min-w-0 flex-col gap-1"
            htmlFor={`canvas-max-concurrent-${canvas.canvasId}`}
          >
            <span className="text-xs text-muted-foreground">{t("maxConcurrentBlocks")}</span>
            <Input
              id={`canvas-max-concurrent-${canvas.canvasId}`}
              aria-invalid={validationMessage ? true : undefined}
              aria-label={t("maxConcurrentBlocks")}
              disabled={saving}
              min={1}
              step={1}
              type="number"
              value={maxConcurrentDraft}
              onChange={(event) => setMaxConcurrentDraft(event.target.value)}
            />
          </label>
          <div
            className={
              validationMessage ? "text-xs text-destructive" : "text-xs text-muted-foreground"
            }
          >
            {validationMessage ?? t("maxConcurrentPositiveInteger")}
          </div>
          <Button className="w-full" disabled={!canSave} onClick={() => void savePolicy()}>
            {saving ? t("saving") : t("saveChanges")}
          </Button>
        </>
      ) : (
        <div className="text-xs text-muted-foreground">{t("executionPolicyUnavailable")}</div>
      )}
    </div>
  );
}

export function CanvasMapInspector({
  graph,
  onClose,
  onBlockOpen,
  onCanvasOpen,
  onExecutionPolicySave,
  onTaskOpen,
  selectedCanvas,
  selectedCanvasId,
  selectedEdge,
  t
}: CanvasMapInspectorProps) {
  const titleByCanvasId = new Map(graph.canvases.map((canvas) => [canvas.canvasId, canvas.title]));
  const upstreamCanvasIds = graph.edges
    .filter((edge) => edge.from === selectedCanvasId)
    .map((edge) => edge.to);
  const downstreamCanvasIds = graph.edges
    .filter((edge) => edge.to === selectedCanvasId)
    .map((edge) => edge.from);
  const relatedCrossTaskEdges = graph.crossTaskEdges.filter(
    (edge) => edge.from.canvasId === selectedCanvasId || edge.to.canvasId === selectedCanvasId
  );
  const selectedCanvasHealth =
    graph.health.canvases.find((canvas) => canvas.canvasId === selectedCanvasId) ?? null;
  const relatedHealthBlockers = graph.health.blockedBlocks.filter(
    (item) =>
      item.blocked.canvasId === selectedCanvasId ||
      item.blockers.some((blocker) => blocker.canvasId === selectedCanvasId)
  );
  const selectedCanvasDiagnosticSeverity = selectedCanvas?.diagnostics.some(
    (diagnostic) => diagnostic.severity === "error"
  )
    ? "error"
    : selectedCanvas?.diagnostics.some((diagnostic) => diagnostic.severity === "warning")
      ? "warning"
      : null;

  if (selectedEdge) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex justify-end">
          <Button size="icon-sm" variant="ghost" aria-label={t("close")} onClick={onClose}>
            <XIcon data-icon="inline-start" />
          </Button>
        </div>
        <CanvasEdgeInspector
          edge={selectedEdge}
          graph={graph}
          onBlockOpen={onBlockOpen}
          onCanvasOpen={onCanvasOpen}
          onTaskOpen={onTaskOpen}
          titleByCanvasId={titleByCanvasId}
          t={t}
        />
      </div>
    );
  }

  if (!selectedCanvas) {
    return (
      <div className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden">
        <div className="text-sm text-muted-foreground">{t("noCanvasSelected")}</div>
        <CanvasMapHealthDiagnostics
          diagnostics={graph.health.diagnostics}
          severity={graph.health.severity}
          t={t}
        />
      </div>
    );
  }

  return (
    <Card className="min-w-0 max-w-full overflow-hidden" size="sm">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center justify-between gap-2 text-sm">
          <span className="truncate">{selectedCanvas.title}</span>
          <span className="flex shrink-0 items-center gap-1">
            {selectedCanvasDiagnosticSeverity ? (
              <Badge
                className={
                  selectedCanvasDiagnosticSeverity === "warning"
                    ? "border-state-warning/60 bg-state-warning-surface text-text-strong"
                    : undefined
                }
                variant={selectedCanvasDiagnosticSeverity === "error" ? "destructive" : "secondary"}
              >
                {t(selectedCanvasDiagnosticSeverity)}
              </Badge>
            ) : null}
            {selectedCanvasHealth && selectedCanvasHealth.blockerCount > 0 ? (
              <Badge variant="secondary">{t("dependencyHealth")}</Badge>
            ) : null}
            <Button size="icon-sm" variant="ghost" aria-label={t("close")} onClick={onClose}>
              <XIcon data-icon="inline-start" />
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden text-sm">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{t("canvasName")}</div>
          <div
            className="block max-w-full whitespace-normal break-words font-mono text-xs text-text-strong"
            style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
            title={selectedCanvas.title}
          >
            {selectedCanvas.title}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{t("canvasId")}</div>
          <div className="font-mono text-xs" style={{ overflowWrap: "anywhere" }}>
            {selectedCanvas.canvasId}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{t("packageDir")}</div>
          <div className="font-mono text-xs" style={{ overflowWrap: "anywhere" }}>
            {selectedCanvas.packageDir}
          </div>
        </div>
        <CanvasExecutionPolicyEditor canvas={selectedCanvas} onSave={onExecutionPolicySave} t={t} />
        <CanvasBadgeList
          ids={upstreamCanvasIds}
          label={t("upstreamCanvases")}
          titleByCanvasId={titleByCanvasId}
          t={t}
        />
        <CanvasBadgeList
          ids={downstreamCanvasIds}
          label={t("downstreamCanvases")}
          titleByCanvasId={titleByCanvasId}
          t={t}
        />
        <div>
          <div className="mb-1 text-xs text-muted-foreground">{t("crossCanvasTasks")}</div>
          <div className="flex flex-col gap-1">
            {relatedCrossTaskEdges.length > 0 ? (
              relatedCrossTaskEdges.map((edge) => (
                <div
                  className="rounded-md border bg-muted/40 p-2 font-mono text-xs"
                  style={{ overflowWrap: "anywhere" }}
                  key={`${edge.from.canvasId}:${edge.from.taskId}-${edge.to.canvasId}:${edge.to.taskId}`}
                >
                  {edge.from.canvasId}:{edge.from.taskId}
                  {" -> "}
                  {edge.to.canvasId}:{edge.to.taskId}
                </div>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">{t("none")}</span>
            )}
          </div>
        </div>
        <CanvasMapBlockedBlocksList
          blockers={relatedHealthBlockers}
          onBlockOpen={onBlockOpen}
          onCanvasOpen={onCanvasOpen}
          onTaskOpen={onTaskOpen}
          t={t}
        />
        {selectedCanvas.diagnostics.length > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="text-xs text-muted-foreground">{t("diagnostics")}</div>
            {selectedCanvas.diagnostics.map((diagnostic) => (
              <div
                className={cn(
                  "rounded-md border p-2 text-xs",
                  diagnostic.severity === "error"
                    ? "border-destructive/30 bg-destructive/10"
                    : "border-state-warning/60 bg-state-warning-surface"
                )}
                style={{ overflowWrap: "anywhere" }}
                key={`${diagnostic.code}-${diagnostic.path ?? ""}-${diagnostic.message}`}
              >
                <div className="font-medium">{diagnostic.code}</div>
                <div>{diagnostic.message}</div>
              </div>
            ))}
          </div>
        ) : null}
        <CanvasMapHealthDiagnostics
          diagnostics={graph.health.diagnostics}
          severity={graph.health.severity}
          t={t}
        />
        <Button
          className="w-full min-w-0 justify-start overflow-hidden"
          onClick={() => onCanvasOpen(selectedCanvas.canvasId)}
        >
          <GitBranchIcon data-icon="inline-start" />
          <span className="min-w-0 truncate">{t("enterCanvas")}</span>
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
    <div className="min-w-0 max-w-full overflow-hidden">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1">
        {ids.length > 0 ? (
          ids.map((canvasId) => (
            <Badge className="min-w-0 max-w-full" key={canvasId} variant="outline">
              {canvasTitle(t, titleByCanvasId, canvasId)}
            </Badge>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">{t("none")}</span>
        )}
      </div>
    </div>
  );
}
