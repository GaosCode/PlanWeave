import { CheckIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { WorkspaceCanvasSharingCandidate } from "../../shared/workspaceCanvasSharing.js";
import type { createTranslator } from "../i18n";

export type WorkspaceCanvasShareStage = "publish" | "visibility" | "verify" | "open";

export type WorkspaceCanvasShareError = {
  candidateKey: string;
  localProjectId: string;
  canvasId: string;
  canvasName: string;
  code: string | null;
  stage: WorkspaceCanvasShareStage;
};

export type WorkspaceCanvasProjectGroup = {
  localProjectId: string;
  projectName: string;
  canvases: WorkspaceCanvasSharingCandidate[];
};

function statusLabel(
  candidate: WorkspaceCanvasSharingCandidate,
  t: ReturnType<typeof createTranslator>
): string {
  if (candidate.state === "published_shared") return t("workspaceCanvasStateShared");
  if (candidate.state === "published_private") return t("workspaceCanvasStatePrivate");
  if (candidate.state === "registered_unpublished") return t("workspaceCanvasStateUnpublished");
  return t("workspaceCanvasStateLocalOnly");
}

function statusDescription(
  candidate: WorkspaceCanvasSharingCandidate,
  t: ReturnType<typeof createTranslator>
): string {
  if (candidate.state === "published_shared") return t("workspaceCanvasSharedDescription");
  if (candidate.state === "published_private") return t("workspaceCanvasPrivateDescription");
  if (candidate.state === "registered_unpublished") {
    return t("workspaceCanvasIncompleteDescription");
  }
  return t("workspaceCanvasLocalDescription");
}

function shareStageLabel(
  stage: WorkspaceCanvasShareStage,
  t: ReturnType<typeof createTranslator>
): string {
  if (stage === "publish") return t("workspaceCanvasShareStagePublish");
  if (stage === "visibility") return t("workspaceCanvasShareStageVisibility");
  if (stage === "open") return t("workspaceCanvasShareStageOpen");
  return t("workspaceCanvasShareStageVerify");
}

function shareStageMessage(
  stage: WorkspaceCanvasShareStage,
  t: ReturnType<typeof createTranslator>
): string {
  if (stage === "publish") return t("workspaceCanvasShareFailedPublish");
  if (stage === "visibility") return t("workspaceCanvasShareFailedVisibility");
  if (stage === "open") return t("workspaceCanvasShareRetryOpen");
  return t("workspaceCanvasShareFailedVerify");
}

export function WorkspaceCanvasSharingProjectPanel({
  project,
  sharedCanvases,
  shareableCanvases,
  selectedCanvasId,
  busyKey,
  shareError,
  pendingAuthoritySwitch,
  t,
  onSelectCanvas,
  onShare,
  onRetryShare,
  onRetryOpen
}: {
  project: WorkspaceCanvasProjectGroup;
  sharedCanvases: WorkspaceCanvasSharingCandidate[];
  shareableCanvases: WorkspaceCanvasSharingCandidate[];
  selectedCanvasId: string | null;
  busyKey: string | null;
  shareError: WorkspaceCanvasShareError | null;
  pendingAuthoritySwitch: boolean;
  t: ReturnType<typeof createTranslator>;
  onSelectCanvas: (canvasId: string) => void;
  onShare: (candidate: WorkspaceCanvasSharingCandidate) => void;
  onRetryShare: () => void;
  onRetryOpen: () => void;
}) {
  const selectedCanvas =
    shareableCanvases.find((candidate) => candidate.canvasId === selectedCanvasId) ?? null;

  return (
    <div data-testid={`workspace-canvas-sharing-project-${project.localProjectId}`}>
      <div className="flex items-end justify-between gap-4 border-b border-border/70 pb-3">
        <div>
          <h3 className="text-sm font-semibold text-text-strong">
            {t("workspaceCanvasSharedListTitle")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("workspaceCanvasSharedListDescription").replace("{project}", project.projectName)}
          </p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {t("workspaceCanvasSharedCount").replace("{count}", String(sharedCanvases.length))}
        </span>
      </div>

      {sharedCanvases.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-border bg-muted/10 px-4 py-7 text-center">
          <p className="text-sm font-medium text-text-strong">
            {t("workspaceCanvasSharedEmptyTitle")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("workspaceCanvasSharedEmptyDescription")}
          </p>
        </div>
      ) : (
        <div className="mt-1 divide-y divide-border/60">
          {sharedCanvases.map((candidate) => (
            <div
              key={`${candidate.localProjectId}\u0000${candidate.canvasId}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 py-4"
              data-testid={`workspace-canvas-sharing-${candidate.canvasId}`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-strong">
                  {candidate.canvasName}
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground">{candidate.canvasId}</p>
              </div>
              <span
                className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-700"
                data-testid={`workspace-canvas-state-${candidate.canvasId}`}
              >
                <span className="grid size-6 place-items-center rounded-full bg-emerald-500/10">
                  <CheckIcon className="size-3.5" aria-hidden="true" />
                </span>
                {t("workspaceCanvasStateShared")}
              </span>
            </div>
          ))}
        </div>
      )}

      <section
        className="mt-5 rounded-xl border border-border/70 bg-muted/15 p-4"
        aria-labelledby="workspace-canvas-add-title"
      >
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background text-text-strong shadow-xs ring-1 ring-border/70">
            <PlusIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 id="workspace-canvas-add-title" className="text-sm font-semibold text-text-strong">
              {t("workspaceCanvasAddTitle")}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("workspaceCanvasAddDescription")}
            </p>
          </div>
        </div>

        {shareableCanvases.length > 0 ? (
          <div className="mt-4 flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <label
                id="workspace-canvas-add-label"
                htmlFor="workspace-canvas-add-select"
                className="text-xs font-semibold text-text-strong"
              >
                {t("workspaceCanvasAddLabel")}
              </label>
              <Select
                value={selectedCanvasId ?? ""}
                onValueChange={onSelectCanvas}
                disabled={busyKey !== null || pendingAuthoritySwitch}
              >
                <SelectTrigger
                  id="workspace-canvas-add-select"
                  className="mt-2 h-9 w-full bg-background"
                  aria-labelledby="workspace-canvas-add-label"
                  data-testid="workspace-canvas-add-select"
                  data-value={selectedCanvasId ?? ""}
                >
                  <SelectValue placeholder={t("workspaceCanvasAddPlaceholder")} />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {shareableCanvases.map((candidate) => (
                    <SelectItem key={candidate.canvasId} value={candidate.canvasId}>
                      {candidate.canvasName} · {statusLabel(candidate, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="shrink-0"
              disabled={!selectedCanvas || busyKey !== null || pendingAuthoritySwitch}
              onClick={() => selectedCanvas && onShare(selectedCanvas)}
            >
              {selectedCanvas &&
              busyKey === `${selectedCanvas.localProjectId}\u0000${selectedCanvas.canvasId}`
                ? t("workspaceCanvasSharing")
                : t("workspaceCanvasAddAction")}
            </Button>
          </div>
        ) : (
          <p className="mt-4 rounded-lg bg-background px-3 py-2.5 text-xs text-muted-foreground ring-1 ring-border/60">
            {t("workspaceCanvasAddEmpty")}
          </p>
        )}

        {selectedCanvas ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {statusDescription(selectedCanvas, t)}
          </p>
        ) : null}

        {shareError?.localProjectId === project.localProjectId ? (
          <div
            className="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5"
            role="alert"
          >
            <p className="text-xs font-semibold text-destructive">
              {t("workspaceCanvasShareFailedTitle").replace("{canvas}", shareError.canvasName)}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {shareStageMessage(shareError.stage, t)}
            </p>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer font-medium text-text-strong marker:text-muted-foreground">
                {t("workspaceCanvasShareDiagnostics")}
              </summary>
              <dl className="mt-2 grid gap-x-5 gap-y-1.5 border-t border-destructive/15 pt-2 sm:grid-cols-[auto_1fr]">
                <dt>{t("workspaceCanvasShareDiagnosticStep")}</dt>
                <dd className="font-medium text-text-strong">
                  {shareStageLabel(shareError.stage, t)}
                </dd>
                <dt>{t("workspaceCanvasShareDiagnosticCode")}</dt>
                <dd className="break-all font-mono text-text-strong">
                  {shareError.code ?? t("workspaceCanvasShareDiagnosticUnavailable")}
                </dd>
                <dt>{t("workspaceCanvasShareDiagnosticCanvas")}</dt>
                <dd className="break-all font-mono text-text-strong">{shareError.canvasId}</dd>
              </dl>
            </details>
            {pendingAuthoritySwitch ? (
              <Button
                size="sm"
                className="mt-2"
                disabled={busyKey !== null}
                onClick={shareError.stage === "open" ? onRetryOpen : onRetryShare}
              >
                {t(
                  shareError.stage === "open"
                    ? "workspaceCanvasRetryOpen"
                    : "workspaceCanvasRetryShare"
                )}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
