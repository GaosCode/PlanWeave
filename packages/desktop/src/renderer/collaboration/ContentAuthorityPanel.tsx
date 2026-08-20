import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentVersionDesktopReadModel } from "@planweave-ai/collaboration-protocol/content/authority";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  CollaborationContentBootstrapCandidate,
  CollaborationContentBootstrapResult,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import type { createTranslator } from "../i18n";
import {
  collaborationDeveloperErrorDetail,
  collaborationErrorCode,
  collaborationErrorMessage,
  logCollaborationRendererError
} from "./formatCollaborationError";

function formatContentAuthorityError(
  t: ReturnType<typeof createTranslator>,
  cause: unknown,
  diagnosticsEnabled = false
): string {
  const code = collaborationErrorCode(cause);
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : collaborationErrorMessage(cause);
  const formatted =
    code === "forbidden" ||
    code === "WORKSPACE_FORBIDDEN" ||
    message === "forbidden" ||
    /CollaborationClientError:\s*forbidden/i.test(message)
      ? t("contentAuthorityForbidden")
      : collaborationErrorMessage(cause);
  if (!diagnosticsEnabled) return formatted;
  const detail = collaborationDeveloperErrorDetail(cause, formatted);
  return detail ? `${formatted}\n${detail}` : formatted;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function shortIdentifier(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function replicaStatusLabel(
  status: ContentVersionDesktopReadModel["replicaStatus"],
  t: ReturnType<typeof createTranslator>
): string {
  if (status === "in_sync") return t("contentAuthorityStatusInSync");
  if (status === "behind") return t("contentAuthorityStatusBehind");
  if (status === "diverged") return t("contentAuthorityStatusDiverged");
  return t("contentAuthorityStatusSnapshotRequired");
}

function AuthorityDetail({
  label,
  value,
  title,
  mono = false,
  testId
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  testId?: string;
}) {
  return (
    <div className="min-w-0 border-l border-border/70 pl-3" data-testid={testId} title={title}>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`mt-1 truncate text-xs font-medium text-text-strong ${mono ? "font-mono" : ""}`}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

export function ContentAuthorityPanel({
  api,
  connectionKey,
  authorityProjectId,
  localProjectId,
  canvasId,
  connected,
  appearance = "flat",
  diagnosticsEnabled = false,
  onMaterialized,
  onReplicaReady,
  t
}: {
  api: PlanWeaveCollaborationApi | null;
  connectionKey: string | null;
  authorityProjectId: string | null;
  localProjectId: string | null;
  canvasId: string | null;
  connected: boolean;
  /** flat: People stack; settings: denser copy inside a Settings card. */
  appearance?: "flat" | "settings";
  diagnosticsEnabled?: boolean;
  onMaterialized?: () => Promise<void>;
  onReplicaReady?: (result: CollaborationContentBootstrapResult) => Promise<void>;
  t: ReturnType<typeof createTranslator>;
}) {
  const [model, setModel] = useState<ContentVersionDesktopReadModel | null>(null);
  const [candidates, setCandidates] = useState<CollaborationContentBootstrapCandidate[]>([]);
  const [candidatesReady, setCandidatesReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connectionKeyRef = useRef(connectionKey);
  const operationRef = useRef(0);
  connectionKeyRef.current = connectionKey;
  const canBindSelectedProject =
    authorityProjectId !== null && localProjectId === authorityProjectId;
  const matchingCandidate =
    authorityProjectId && canvasId
      ? (candidates.find(
          (candidate) =>
            candidate.projectId === authorityProjectId && candidate.canvasId === canvasId
        ) ?? null)
      : null;
  // Only auto-bind canvases the Server already authorizes. Binding an unhosted
  // selected canvas returns HTTP 403 (forbidden) while hosted siblings still list.
  const canBindSelectedCanvas = canBindSelectedProject && matchingCandidate !== null;

  const run = useCallback(
    async (action: () => Promise<ContentVersionDesktopReadModel>) => {
      const operation = ++operationRef.current;
      const expectedConnectionKey = connectionKeyRef.current;
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        const nextModel = await action();
        if (
          operation === operationRef.current &&
          expectedConnectionKey === connectionKeyRef.current
        ) {
          setModel(nextModel);
        }
      } catch (cause) {
        if (
          operation === operationRef.current &&
          expectedConnectionKey === connectionKeyRef.current
        ) {
          logCollaborationRendererError("contentAuthority.action", cause);
          setError(formatContentAuthorityError(t, cause, diagnosticsEnabled));
        }
      } finally {
        if (operation === operationRef.current) setBusy(false);
      }
    },
    [diagnosticsEnabled, t]
  );

  const loadCandidates = useCallback(async () => {
    if (!api || !connected || !connectionKey) {
      setCandidates([]);
      setCandidatesReady(true);
      return;
    }
    try {
      setCandidates(await api.listCollaborationContentBootstrapCandidates());
      setError(null);
    } catch (cause) {
      logCollaborationRendererError("contentAuthority.listBootstrapCandidates", cause);
      setError(formatContentAuthorityError(t, cause, diagnosticsEnabled));
    } finally {
      setCandidatesReady(true);
    }
  }, [api, connected, connectionKey, diagnosticsEnabled, t]);

  useEffect(() => {
    let current = true;
    setCandidatesReady(false);
    if (!api || !connected || !connectionKey) {
      setCandidates([]);
      setCandidatesReady(true);
      return () => {
        current = false;
      };
    }
    void api
      .listCollaborationContentBootstrapCandidates()
      .then((nextCandidates) => {
        if (current) {
          setCandidates(nextCandidates);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          logCollaborationRendererError("contentAuthority.listBootstrapCandidates", cause);
          setError(formatContentAuthorityError(t, cause, diagnosticsEnabled));
        }
      })
      .finally(() => {
        if (current) setCandidatesReady(true);
      });
    return () => {
      current = false;
    };
  }, [api, connected, connectionKey, diagnosticsEnabled, t]);

  useEffect(() => {
    if (!api || !connectionKey || !connected) {
      setModel(null);
      return;
    }
    if (!candidatesReady) return;
    if (!canBindSelectedCanvas || !localProjectId || !canvasId) {
      setModel((current) =>
        current?.authoritativeHead?.scope.projectId === authorityProjectId ? current : null
      );
      return;
    }
    void run(() =>
      api.bindCollaborationCanvasBindingContentAuthority({
        kind: "local",
        localProjectId,
        canvasId
      })
    );
  }, [
    api,
    authorityProjectId,
    canBindSelectedCanvas,
    candidatesReady,
    connectionKey,
    localProjectId,
    canvasId,
    connected,
    run
  ]);

  const selectedCanvasOutsideHostedScope =
    candidatesReady &&
    canBindSelectedProject &&
    Boolean(localProjectId && canvasId) &&
    matchingCandidate === null &&
    candidates.some((candidate) => candidate.projectId === authorityProjectId);

  if (!connected) return null;
  const head = model?.authoritativeHead ?? null;
  const localReplica = model?.localReplica ?? null;
  const acknowledgement = model?.lastAcknowledgement ?? null;
  const revision = head?.revision ?? t("contentAuthorityWaiting");
  const status = model ? replicaStatusLabel(model.replicaStatus, t) : t("contentAuthorityOffline");
  const activeRemoteScope = head?.scope ?? null;
  const visibleCandidates = candidates.filter(
    (candidate) =>
      !activeRemoteScope ||
      candidate.workspaceId !== activeRemoteScope.workspaceId ||
      candidate.projectId !== activeRemoteScope.projectId ||
      candidate.canvasId !== activeRemoteScope.canvasId
  );

  const bootstrap = async (candidate: CollaborationContentBootstrapCandidate) => {
    if (!api) return;
    const operation = ++operationRef.current;
    const expectedConnectionKey = connectionKeyRef.current;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await api.bootstrapCollaborationContent({
        workspaceId: candidate.workspaceId,
        projectId: candidate.projectId,
        canvasId: candidate.canvasId
      });
      if (
        operation !== operationRef.current ||
        expectedConnectionKey !== connectionKeyRef.current
      ) {
        return;
      }
      await onReplicaReady?.(result);
      setModel(result.authority);
      setInfo(
        result.acknowledgement === "acknowledged"
          ? t("contentBootstrapSuccess")
          : t("contentBootstrapAcknowledgementPending")
      );
      await loadCandidates();
    } catch (cause) {
      if (
        operation === operationRef.current &&
        expectedConnectionKey === connectionKeyRef.current
      ) {
        logCollaborationRendererError("contentAuthority.bootstrap", cause);
        setError(formatContentAuthorityError(t, cause, diagnosticsEnabled));
      }
    } finally {
      if (operation === operationRef.current) setBusy(false);
    }
  };
  const retryBinding = () => {
    if (api && canBindSelectedCanvas && localProjectId && canvasId) {
      void run(() =>
        api.bindCollaborationCanvasBindingContentAuthority({
          kind: "local",
          localProjectId,
          canvasId
        })
      );
    }
  };
  return (
    <section
      className={
        appearance === "settings"
          ? "min-w-0 flex flex-col gap-5"
          : "min-w-0 border-t border-border/70 py-7"
      }
      data-testid="content-authority-panel"
      data-appearance={appearance}
      aria-labelledby={appearance === "settings" ? undefined : "content-authority-title"}
    >
      {appearance === "flat" ? (
        <div className="min-w-0 px-1 pb-5">
          <h2 id="content-authority-title" className="text-base font-semibold text-text-strong">
            {t("contentAuthorityTitle")}
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            {t("contentAuthorityDescription")}
          </p>
        </div>
      ) : null}
      {selectedCanvasOutsideHostedScope ? (
        <p
          className={
            appearance === "settings"
              ? "text-xs leading-5 text-amber-800 dark:text-amber-200"
              : "border-t border-border/60 px-1 py-3 text-xs leading-5 text-amber-800 dark:text-amber-200"
          }
          data-testid="content-authority-canvas-not-hosted"
          role="status"
        >
          {t("contentAuthorityCanvasNotHosted")}
        </p>
      ) : null}
      {visibleCandidates.length > 0 ? (
        <div
          className={
            appearance === "settings"
              ? "border-b border-border/70 pb-5"
              : "border-t border-border/60 px-1 py-4"
          }
          data-testid="content-bootstrap-candidates"
        >
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-text-strong">{t("contentBootstrapTitle")}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("contentBootstrapDescription")}
            </p>
          </div>
          <div className="divide-y divide-border/60 border-y border-border/60">
            {visibleCandidates.map((candidate) => (
              <div
                key={`${candidate.workspaceId}:${candidate.projectId}:${candidate.canvasId}`}
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-strong">
                    {candidate.projectId} / {candidate.canvasId}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {candidate.authority.authoritativeHead
                      ? t("contentBootstrapRevision").replace(
                          "{revision}",
                          String(candidate.authority.authoritativeHead.revision)
                        )
                      : t("contentBootstrapWaitingForOwner")}
                    {candidate.localReplica ? ` · ${t("contentBootstrapStoredReplica")}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={candidate.localReplica ? "outline" : "default"}
                  disabled={busy || !candidate.authority.authoritativeHead}
                  onClick={() => void bootstrap(candidate)}
                >
                  <DownloadIcon className="mr-1.5 size-3.5" aria-hidden="true" />
                  {candidate.localReplica
                    ? t("contentBootstrapOpenLocal")
                    : t("contentBootstrapSync")}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {model && canvasId ? (
        <div
          className={
            appearance === "settings"
              ? "flex flex-col gap-5"
              : "flex flex-col gap-5 border-t border-border/60 px-1 py-5"
          }
        >
          <dl className="grid min-w-0 gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <AuthorityDetail
              label={t("contentAuthorityRevisionLabel")}
              value={String(revision)}
              testId="content-authority-revision"
            />
            <AuthorityDetail
              label={t("contentAuthorityStatusLabel")}
              value={status}
              testId="content-authority-status"
            />
            <AuthorityDetail
              label={t("contentAuthorityCanvas")}
              value={head?.scope.canvasId ?? canvasId}
              mono
            />
            <AuthorityDetail
              label={t("contentAuthorityAdvancedAt")}
              value={head ? formatTimestamp(head.advancedAt) : "—"}
            />
            <AuthorityDetail
              label={t("contentAuthorityVersionId")}
              value={head ? shortIdentifier(head.content.versionId) : "—"}
              title={head?.content.versionId}
              mono
              testId="content-authority-version"
            />
            <AuthorityDetail
              label={t("contentAuthorityDigest")}
              value={head ? shortIdentifier(head.content.canonicalDigest) : "—"}
              title={head?.content.canonicalDigest}
              mono
              testId="content-authority-digest"
            />
            <AuthorityDetail
              label={t("contentAuthorityLocalVersion")}
              value={
                localReplica
                  ? shortIdentifier(localReplica.versionId)
                  : t("contentAuthorityNoLocalReplica")
              }
              title={localReplica?.versionId}
              mono={localReplica !== null}
              testId="content-authority-local-version"
            />
            <AuthorityDetail
              label={t("contentAuthorityAcknowledgedAt")}
              value={acknowledgement ? formatTimestamp(acknowledgement.acknowledgedAt) : "—"}
              testId="content-authority-acknowledged-at"
            />
          </dl>
          <div className="flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-xs text-muted-foreground">
              {acknowledgement ? <p>{t("contentAuthorityAcknowledged")}</p> : null}
              {model?.offlineWriteReason ? (
                <p className="text-amber-800 dark:text-amber-200">
                  {t("contentAuthorityWriteBlocked").replace("{reason}", model.offlineWriteReason)}
                </p>
              ) : null}
              {error ? <p className="text-destructive sm:col-span-2">{error}</p> : null}
              {info ? (
                <p className="text-emerald-700 dark:text-emerald-300 sm:col-span-2">{info}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!api || !connected || busy}
                onClick={retryBinding}
              >
                {t("contentAuthorityRetry")}
              </Button>
              {model?.canPublishInitial ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => api && run(() => api.publishCollaborationInitialContent())}
                >
                  {t("contentAuthorityPublish")}
                </Button>
              ) : null}
              {model?.canMaterialize ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    api &&
                    run(async () => {
                      const nextModel = await api.materializeCollaborationContentHead();
                      try {
                        await onMaterialized?.();
                        setInfo(t("contentAuthorityMaterializedSuccess"));
                      } catch (cause) {
                        setError(formatContentAuthorityError(t, cause));
                      }
                      return nextModel;
                    })
                  }
                >
                  {model.canRecover
                    ? t("contentAuthorityRecover")
                    : t("contentAuthorityMaterialize")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : error || info ? (
        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-1 py-4 text-xs">
          <div>
            {error ? <p className="text-destructive">{error}</p> : null}
            {info ? <p className="text-emerald-700 dark:text-emerald-300">{info}</p> : null}
          </div>
          {error && canBindSelectedCanvas && localProjectId && canvasId ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={retryBinding}>
              {t("contentAuthorityRetry")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
