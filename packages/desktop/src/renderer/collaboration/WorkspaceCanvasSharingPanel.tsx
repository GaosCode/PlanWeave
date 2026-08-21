import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import type { WorkspaceCanvasSharingCandidate } from "../../shared/workspaceCanvasSharing.js";
import type { createTranslator } from "../i18n";
import { collaborationErrorMessage } from "./formatCollaborationError";

function statusLabel(
  candidate: WorkspaceCanvasSharingCandidate,
  t: ReturnType<typeof createTranslator>
): string {
  if (candidate.state === "published_shared") return t("workspaceCanvasStateShared");
  if (candidate.state === "published_private") return t("workspaceCanvasStatePrivate");
  if (candidate.state === "registered_unpublished") return t("workspaceCanvasStateUnpublished");
  return t("workspaceCanvasStateLocalOnly");
}

export function WorkspaceCanvasSharingPanel({
  api,
  connected,
  connectionKey,
  t
}: {
  api: PlanWeaveCollaborationApi | null;
  connected: boolean;
  connectionKey: string | null;
  t: ReturnType<typeof createTranslator>;
}) {
  const [candidates, setCandidates] = useState<WorkspaceCanvasSharingCandidate[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api || !connected || !connectionKey) {
      setCandidates([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setCandidates(await api.listWorkspaceCanvasSharingCandidates());
    } catch (cause) {
      setError(collaborationErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [api, connected, connectionKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const publish = async (candidate: WorkspaceCanvasSharingCandidate) => {
    if (!api) return;
    const key = `${candidate.localProjectId}\u0000${candidate.canvasId}`;
    setBusyKey(key);
    setError(null);
    try {
      const updated = await api.publishWorkspaceCanvas({
        localProjectId: candidate.localProjectId,
        canvasId: candidate.canvasId
      });
      setCandidates((current) =>
        current.map((item) =>
          item.localProjectId === updated.localProjectId && item.canvasId === updated.canvasId
            ? updated
            : item
        )
      );
    } catch (cause) {
      setError(collaborationErrorMessage(cause));
      await load();
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section data-testid="workspace-canvas-sharing">
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          data-testid="workspace-canvas-sharing-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          <span>
            <h2 className="text-base font-semibold text-text-strong">
              {t("workspaceCanvasSharingTitle")}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
              {t("workspaceCanvasSharingDescription")}
            </p>
          </span>
          <ChevronDownIcon
            className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </button>
        {expanded ? (
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
            {t("peopleRefresh")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-4 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {expanded && loading && candidates.length === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground" role="status">
          {t("workspaceCanvasSharingLoading")}
        </p>
      ) : expanded && candidates.length === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground">{t("workspaceCanvasSharingEmpty")}</p>
      ) : expanded ? (
        <div className="mt-5 divide-y divide-border/70">
          {candidates.map((candidate) => {
            const key = `${candidate.localProjectId}\u0000${candidate.canvasId}`;
            const canPublish =
              candidate.state === "local_only" || candidate.state === "registered_unpublished";
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-5 py-4"
                data-testid={`workspace-canvas-sharing-${candidate.canvasId}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-strong">
                    {candidate.canvasName}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {candidate.projectName} · {candidate.canvasId}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <span
                    className={
                      candidate.state === "published_shared"
                        ? "text-xs font-medium text-emerald-600"
                        : "text-xs font-medium text-muted-foreground"
                    }
                    data-testid={`workspace-canvas-state-${candidate.canvasId}`}
                  >
                    {statusLabel(candidate, t)}
                  </span>
                  {canPublish ? (
                    <Button
                      size="sm"
                      disabled={busyKey !== null}
                      onClick={() => void publish(candidate)}
                    >
                      {busyKey === key
                        ? t("workspaceCanvasPublishing")
                        : candidate.state === "registered_unpublished"
                          ? t("workspaceCanvasRetryPublish")
                          : t("workspaceCanvasPublish")}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
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
