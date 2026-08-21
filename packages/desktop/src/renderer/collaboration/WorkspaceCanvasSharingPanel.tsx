import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import type { WorkspaceCanvasSharingCandidate } from "../../shared/workspaceCanvasSharing.js";
import type { createTranslator } from "../i18n";
import { WorkspaceSectionHeader } from "../team/WorkspaceSectionHeader";
import {
  collaborationErrorCode,
  collaborationErrorMessage,
  logCollaborationRendererError
} from "./formatCollaborationError";

type WorkspaceCanvasShareStage = "publish" | "visibility" | "verify";

type WorkspaceCanvasShareError = {
  candidateKey: string;
  canvasId: string;
  canvasName: string;
  code: string | null;
  stage: WorkspaceCanvasShareStage;
};

function shareStageLabel(
  stage: WorkspaceCanvasShareStage,
  t: ReturnType<typeof createTranslator>
): string {
  if (stage === "publish") return t("workspaceCanvasShareStagePublish");
  if (stage === "visibility") return t("workspaceCanvasShareStageVisibility");
  return t("workspaceCanvasShareStageVerify");
}

function shareStageMessage(
  stage: WorkspaceCanvasShareStage,
  t: ReturnType<typeof createTranslator>
): string {
  if (stage === "publish") return t("workspaceCanvasShareFailedPublish");
  if (stage === "visibility") return t("workspaceCanvasShareFailedVisibility");
  return t("workspaceCanvasShareFailedVerify");
}

function statusLabel(
  candidate: WorkspaceCanvasSharingCandidate,
  t: ReturnType<typeof createTranslator>
): string {
  if (candidate.state === "published_shared") return t("workspaceCanvasStateShared");
  if (candidate.state === "published_outdated") return t("workspaceCanvasStateOutdated");
  if (candidate.state === "published_private") return t("workspaceCanvasStatePrivate");
  if (candidate.state === "registered_unpublished") return t("workspaceCanvasStateUnpublished");
  return t("workspaceCanvasStateLocalOnly");
}

function statusDescription(
  candidate: WorkspaceCanvasSharingCandidate,
  t: ReturnType<typeof createTranslator>
): string {
  if (candidate.state === "published_shared") return t("workspaceCanvasSharedDescription");
  if (candidate.state === "published_outdated") return t("workspaceCanvasOutdatedDescription");
  if (candidate.state === "published_private") return t("workspaceCanvasPrivateDescription");
  if (candidate.state === "registered_unpublished") {
    return t("workspaceCanvasIncompleteDescription");
  }
  return t("workspaceCanvasLocalDescription");
}

export function WorkspaceCanvasSharingPanel({
  api,
  connected,
  connectionKey,
  onPublished,
  t
}: {
  api: PlanWeaveCollaborationApi | null;
  connected: boolean;
  connectionKey: string | null;
  onPublished?: (candidate: WorkspaceCanvasSharingCandidate) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const [candidates, setCandidates] = useState<WorkspaceCanvasSharingCandidate[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<WorkspaceCanvasShareError | null>(null);
  const loadRequestIdRef = useRef(0);

  const load = useCallback(async (): Promise<WorkspaceCanvasSharingCandidate[]> => {
    const requestId = ++loadRequestIdRef.current;
    if (!api || !connected || !connectionKey) {
      setCandidates([]);
      return [];
    }
    setLoading(true);
    setLoadError(null);
    try {
      const nextCandidates = await api.listWorkspaceCanvasSharingCandidates();
      if (requestId !== loadRequestIdRef.current) return [];
      setCandidates(nextCandidates);
      return nextCandidates;
    } catch (cause) {
      if (requestId !== loadRequestIdRef.current) return [];
      setLoadError(collaborationErrorMessage(cause));
      return [];
    } finally {
      if (requestId === loadRequestIdRef.current) setLoading(false);
    }
  }, [api, connected, connectionKey]);

  useEffect(() => {
    setCandidates([]);
    setLoadError(null);
    setShareError(null);
    void load();
    return () => {
      loadRequestIdRef.current += 1;
    };
  }, [load]);

  const projectGroups = useMemo(() => {
    const groups = new Map<
      string,
      { localProjectId: string; projectName: string; canvases: WorkspaceCanvasSharingCandidate[] }
    >();
    for (const candidate of candidates) {
      const group = groups.get(candidate.localProjectId);
      if (group) {
        group.canvases.push(candidate);
      } else {
        groups.set(candidate.localProjectId, {
          localProjectId: candidate.localProjectId,
          projectName: candidate.projectName,
          canvases: [candidate]
        });
      }
    }
    return [...groups.values()];
  }, [candidates]);

  const share = async (candidate: WorkspaceCanvasSharingCandidate) => {
    if (!api) return;
    const key = `${candidate.localProjectId}\u0000${candidate.canvasId}`;
    let stage: WorkspaceCanvasShareStage =
      candidate.state === "local_only" || candidate.state === "registered_unpublished"
        ? "publish"
        : "visibility";
    setBusyKey(key);
    setShareError(null);
    try {
      let updated = candidate;
      if (candidate.state === "local_only" || candidate.state === "registered_unpublished") {
        updated = await api.publishWorkspaceCanvas({
          localProjectId: candidate.localProjectId,
          canvasId: candidate.canvasId
        });
      }
      if (updated.state !== "published_shared") {
        stage = "visibility";
        const access = await api.getCurrentCanvasAccess({ canvasId: candidate.canvasId });
        const result = await api.mutateCurrentCanvasAccess({
          canvasId: candidate.canvasId,
          request: {
            operation: "visibility",
            scope: access.scope,
            expectedAclRevision: access.canvasAclRevision,
            visibility: "shared"
          }
        });
        if (result.status !== "applied") throw new Error(result.reason);
      }
      stage = "verify";
      const refreshed = await load();
      const verified = refreshed.find(
        (item) =>
          item.localProjectId === candidate.localProjectId && item.canvasId === candidate.canvasId
      );
      if (!verified || verified.state !== "published_shared") {
        throw new Error("workspace_canvas_share_not_verified");
      }
      onPublished?.(verified);
    } catch (cause) {
      logCollaborationRendererError(`workspace_canvas_share.${stage}`, cause);
      await load();
      setShareError({
        candidateKey: key,
        canvasId: candidate.canvasId,
        canvasName: candidate.canvasName,
        code: collaborationErrorCode(cause),
        stage
      });
    } finally {
      setBusyKey(null);
    }
  };

  const toggleProject = (localProjectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(localProjectId)) {
        next.delete(localProjectId);
      } else {
        next.add(localProjectId);
      }
      return next;
    });
  };

  return (
    <section
      aria-labelledby="workspace-canvas-sharing-title"
      data-testid="workspace-canvas-sharing"
    >
      <WorkspaceSectionHeader
        title={t("workspaceCanvasSharingTitle")}
        description={t("workspaceCanvasSharingDescription")}
        titleId="workspace-canvas-sharing-title"
        toggle={{
          expanded,
          onToggle: () => setExpanded((current) => !current),
          label: t(expanded ? "workspaceCanvasSharingCollapse" : "workspaceCanvasSharingExpand"),
          testId: "workspace-canvas-sharing-toggle",
          indicator: (
            <ChevronDownIcon
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            />
          )
        }}
        action={
          expanded ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => {
                setShareError(null);
                void load();
              }}
            >
              {t("peopleRefresh")}
            </Button>
          ) : null
        }
      />
      {expanded && candidates.length > 0 ? (
        <div className="mt-5 grid grid-cols-3 divide-x divide-border/70 rounded-lg border border-border/70 bg-muted/20 py-3">
          {[
            [
              t("workspaceCanvasSummaryLocal"),
              candidates.filter(
                (item) =>
                  item.state === "local_only" ||
                  item.state === "registered_unpublished" ||
                  item.state === "published_outdated"
              ).length
            ],
            [
              t("workspaceCanvasSummaryPrivate"),
              candidates.filter((item) => item.state === "published_private").length
            ],
            [
              t("workspaceCanvasSummaryShared"),
              candidates.filter((item) => item.state === "published_shared").length
            ]
          ].map(([label, value]) => (
            <div key={String(label)} className="px-4">
              <p className="text-lg font-semibold tabular-nums text-text-strong">{value}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
      ) : null}
      {loadError ? (
        <p className="mt-4 text-xs text-destructive" role="alert">
          {loadError}
        </p>
      ) : null}
      {expanded && loading && candidates.length === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground" role="status">
          {t("workspaceCanvasSharingLoading")}
        </p>
      ) : expanded && candidates.length === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground">{t("workspaceCanvasSharingEmpty")}</p>
      ) : expanded ? (
        <div className="mt-5 flex flex-col gap-4">
          {projectGroups.map((group) => (
            <section
              key={group.localProjectId}
              aria-labelledby={`workspace-sharing-project-${group.localProjectId}`}
              data-testid={`workspace-canvas-sharing-project-${group.localProjectId}`}
            >
              <div className="group relative rounded-lg border border-border/70 bg-background px-4 py-3 transition-colors hover:bg-muted/20">
                <button
                  type="button"
                  className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-expanded={!collapsedProjectIds.has(group.localProjectId)}
                  aria-controls={`workspace-sharing-canvases-${group.localProjectId}`}
                  aria-label={`${t(
                    collapsedProjectIds.has(group.localProjectId)
                      ? "workspaceCanvasProjectExpand"
                      : "workspaceCanvasProjectCollapse"
                  )}: ${group.projectName}`}
                  data-testid={`workspace-canvas-project-toggle-${group.localProjectId}`}
                  onClick={() => toggleProject(group.localProjectId)}
                />
                <div className="pointer-events-none relative flex min-w-0 items-center justify-between gap-4">
                  <div className="min-w-0">
                    <h3
                      id={`workspace-sharing-project-${group.localProjectId}`}
                      className="truncate text-sm font-semibold text-text-strong"
                    >
                      {group.projectName}
                    </h3>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {group.localProjectId}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t("workspaceCanvasProjectCount").replace(
                        "{count}",
                        String(group.canvases.length)
                      )}
                    </span>
                    <span className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-text-strong">
                      <ChevronDownIcon
                        className={`size-4 transition-transform ${
                          collapsedProjectIds.has(group.localProjectId) ? "" : "rotate-180"
                        }`}
                        aria-hidden="true"
                      />
                    </span>
                  </div>
                </div>
              </div>
              <div
                id={`workspace-sharing-canvases-${group.localProjectId}`}
                className="mx-3 divide-y divide-border/60 border-x border-b border-border/60 px-3"
                hidden={collapsedProjectIds.has(group.localProjectId)}
              >
                {group.canvases.map((candidate) => {
                  const key = `${candidate.localProjectId}\u0000${candidate.canvasId}`;
                  return (
                    <div
                      key={key}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(13rem,0.72fr)_auto] items-center gap-5 py-4"
                      data-testid={`workspace-canvas-sharing-${candidate.canvasId}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-strong">
                          {candidate.canvasName}
                        </p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {candidate.canvasId}
                        </p>
                      </div>
                      <div className="min-w-0">
                        <span
                          className={`inline-flex min-w-0 items-center gap-2 text-xs font-semibold ${
                            candidate.state === "published_shared"
                              ? "text-emerald-700"
                              : "text-muted-foreground"
                          }`}
                          data-testid={`workspace-canvas-state-${candidate.canvasId}`}
                          title={statusLabel(candidate, t)}
                        >
                          {candidate.state === "published_shared" ? (
                            <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
                          ) : candidate.state === "published_outdated" ? (
                            <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden="true" />
                          ) : (
                            <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
                          )}
                          <span className="truncate">{statusLabel(candidate, t)}</span>
                        </span>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {statusDescription(candidate, t)}
                        </p>
                      </div>
                      <div className="flex min-w-[8.5rem] justify-end">
                        {candidate.state === "published_outdated" ? (
                          <span className="text-xs font-medium text-amber-700">
                            {t("workspaceCanvasNeedsAttention")}
                          </span>
                        ) : candidate.state !== "published_shared" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyKey !== null}
                            onClick={() => void share(candidate)}
                          >
                            {busyKey === key
                              ? t("workspaceCanvasSharing")
                              : candidate.state === "published_private"
                                ? t("workspaceCanvasMakeShared")
                                : t("workspaceCanvasShare")}
                          </Button>
                        ) : (
                          <span className="inline-flex h-7 items-center justify-center rounded-lg px-2.5 text-xs font-medium text-emerald-700">
                            {t("workspaceCanvasVerified")}
                          </span>
                        )}
                      </div>
                      {shareError?.candidateKey === key ? (
                        <div
                          className="col-span-full rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5"
                          role="alert"
                        >
                          <p className="text-xs font-semibold text-destructive">
                            {t("workspaceCanvasShareFailedTitle").replace(
                              "{canvas}",
                              shareError.canvasName
                            )}
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
                              <dd className="break-all font-mono text-text-strong">
                                {shareError.canvasId}
                              </dd>
                            </dl>
                          </details>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {t("workspaceCanvasSharingVisibilityHint")}
        </p>
      ) : null}
    </section>
  );
}
