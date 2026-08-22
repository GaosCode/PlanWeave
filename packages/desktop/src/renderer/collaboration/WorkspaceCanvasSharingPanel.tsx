import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import type {
  WorkspaceCanvasPublishResult,
  WorkspaceCanvasSharingCandidate
} from "../../shared/workspaceCanvasSharing.js";
import type { createTranslator } from "../i18n";
import { WorkspaceSectionHeader } from "../team/WorkspaceSectionHeader";
import {
  collaborationErrorCode,
  collaborationErrorMessage,
  logCollaborationRendererError
} from "./formatCollaborationError";
import {
  WorkspaceCanvasSharingProjectPanel,
  type WorkspaceCanvasProjectGroup,
  type WorkspaceCanvasShareError,
  type WorkspaceCanvasShareStage
} from "./WorkspaceCanvasSharingProjectPanel";

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
  onPublished?: (result: WorkspaceCanvasPublishResult) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const [candidates, setCandidates] = useState<WorkspaceCanvasSharingCandidate[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<WorkspaceCanvasShareError | null>(null);
  const [pendingAuthoritySwitch, setPendingAuthoritySwitch] =
    useState<WorkspaceCanvasPublishResult | null>(null);
  const loadRequestIdRef = useRef(0);
  const operationContextRef = useRef({ api, connected, connectionKey, epoch: 0 });
  const currentOperationContext = operationContextRef.current;
  if (
    currentOperationContext.api !== api ||
    currentOperationContext.connected !== connected ||
    currentOperationContext.connectionKey !== connectionKey
  ) {
    operationContextRef.current = {
      api,
      connected,
      connectionKey,
      epoch: currentOperationContext.epoch + 1
    };
  }

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
    setSelectedProjectId(null);
    setSelectedCanvasId(null);
    setLoadError(null);
    setShareError(null);
    setPendingAuthoritySwitch(null);
    setBusyKey(null);
    void load();
    return () => {
      loadRequestIdRef.current += 1;
    };
  }, [load]);

  const projectGroups = useMemo<WorkspaceCanvasProjectGroup[]>(() => {
    const groups = new Map<string, WorkspaceCanvasProjectGroup>();
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

  useEffect(() => {
    setSelectedProjectId((current) => {
      if (current && projectGroups.some((group) => group.localProjectId === current)) {
        return current;
      }
      return projectGroups[0]?.localProjectId ?? null;
    });
  }, [projectGroups]);

  const selectedProject = useMemo(
    () => projectGroups.find((group) => group.localProjectId === selectedProjectId) ?? null,
    [projectGroups, selectedProjectId]
  );
  const sharedCanvases = useMemo(
    () =>
      selectedProject?.canvases.filter((candidate) => candidate.state === "published_shared") ?? [],
    [selectedProject]
  );
  const shareableCanvases = useMemo(
    () =>
      selectedProject?.canvases.filter((candidate) => candidate.state !== "published_shared") ?? [],
    [selectedProject]
  );

  useEffect(() => {
    if (
      selectedCanvasId &&
      !shareableCanvases.some((candidate) => candidate.canvasId === selectedCanvasId)
    ) {
      setSelectedCanvasId(null);
    }
  }, [selectedCanvasId, shareableCanvases]);

  const share = async (candidate: WorkspaceCanvasSharingCandidate) => {
    if (!api || !connected || !connectionKey) return;
    const operationEpoch = operationContextRef.current.epoch;
    const isCurrentOperation = () => operationContextRef.current.epoch === operationEpoch;
    const key = `${candidate.localProjectId}\u0000${candidate.canvasId}`;
    let stage: WorkspaceCanvasShareStage =
      candidate.state === "local_only" || candidate.state === "registered_unpublished"
        ? "publish"
        : "visibility";
    setBusyKey(key);
    setShareError(null);
    try {
      const recoverablePublish =
        pendingAuthoritySwitch?.candidate.localProjectId === candidate.localProjectId &&
        pendingAuthoritySwitch.candidate.canvasId === candidate.canvasId
          ? pendingAuthoritySwitch
          : null;
      if (pendingAuthoritySwitch && !recoverablePublish) return;
      let published = recoverablePublish;
      let updated = recoverablePublish?.candidate ?? candidate;
      if (
        !published &&
        (candidate.state === "local_only" || candidate.state === "registered_unpublished")
      ) {
        published = await api.publishWorkspaceCanvas({
          localProjectId: candidate.localProjectId,
          canvasId: candidate.canvasId
        });
        if (!isCurrentOperation()) return;
        updated = published.candidate;
        setPendingAuthoritySwitch(published);
      }
      if (updated.state !== "published_shared") {
        stage = "visibility";
        const canvasId = updated.workspaceCanvasId;
        if (canvasId === null) throw new Error("workspace_canvas_server_identity_missing");
        const access = await api.getCurrentCanvasAccess({ canvasId });
        if (!isCurrentOperation()) return;
        const result = await api.mutateCurrentCanvasAccess({
          canvasId,
          request: {
            operation: "visibility",
            scope: access.scope,
            expectedAclRevision: access.canvasAclRevision,
            visibility: "shared"
          }
        });
        if (!isCurrentOperation()) return;
        if (result.status !== "applied") throw new Error(result.reason);
      }
      stage = "verify";
      if (!isCurrentOperation()) return;
      const refreshed = await load();
      if (!isCurrentOperation()) return;
      const verified = refreshed.find(
        (item) =>
          item.localProjectId === candidate.localProjectId && item.canvasId === candidate.canvasId
      );
      if (!verified || verified.state !== "published_shared") {
        throw new Error("workspace_canvas_share_not_verified");
      }
      if (published?.authoritySwitch === "retry_open") {
        stage = "open";
        throw new Error("workspace_canvas_authority_switch_retry");
      }
      setSelectedCanvasId(null);
      if (published) {
        setPendingAuthoritySwitch(null);
        onPublished?.(published);
      }
    } catch (cause) {
      if (!isCurrentOperation()) return;
      logCollaborationRendererError(`workspace_canvas_share.${stage}`, cause);
      if (stage !== "open") {
        await load();
        if (!isCurrentOperation()) return;
      }
      setShareError({
        candidateKey: key,
        localProjectId: candidate.localProjectId,
        canvasId: candidate.canvasId,
        canvasName: candidate.canvasName,
        code: collaborationErrorCode(cause),
        stage
      });
    } finally {
      if (isCurrentOperation()) setBusyKey(null);
    }
  };

  const retryOpen = async (): Promise<void> => {
    if (!api || !connected || !connectionKey || !pendingAuthoritySwitch || !shareError) return;
    const operationEpoch = operationContextRef.current.epoch;
    const isCurrentOperation = () => operationContextRef.current.epoch === operationEpoch;
    const key = shareError.candidateKey;
    const failedOpen = shareError;
    setBusyKey(key);
    setShareError(null);
    try {
      await api.openWorkspaceCanvasSession(pendingAuthoritySwitch.locator);
      if (!isCurrentOperation()) return;
      const opened = { ...pendingAuthoritySwitch, authoritySwitch: "opened" as const };
      setPendingAuthoritySwitch(null);
      onPublished?.(opened);
    } catch (error) {
      if (!isCurrentOperation()) return;
      const message = error instanceof Error ? error.message : "unknown error";
      setShareError({ ...failedOpen, stage: "open", code: message });
    } finally {
      if (isCurrentOperation()) {
        setBusyKey((current) => (current === key ? null : current));
      }
    }
  };

  const retryShare = (): void => {
    if (!pendingAuthoritySwitch) return;
    void share(pendingAuthoritySwitch.candidate);
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
        <div className="mt-5 flex flex-col gap-6">
          <div className="max-w-xl">
            <label
              id="workspace-canvas-project-label"
              htmlFor="workspace-canvas-project-select"
              className="text-xs font-semibold text-text-strong"
            >
              {t("workspaceCanvasProjectLabel")}
            </label>
            <Select
              value={selectedProjectId ?? ""}
              disabled={pendingAuthoritySwitch !== null}
              onValueChange={(value) => {
                setSelectedProjectId(value);
                setSelectedCanvasId(null);
              }}
            >
              <SelectTrigger
                id="workspace-canvas-project-select"
                className="mt-2 h-10 w-full bg-background"
                aria-labelledby="workspace-canvas-project-label"
                data-testid="workspace-canvas-project-select"
                data-value={selectedProjectId ?? ""}
              >
                <SelectValue placeholder={t("workspaceCanvasProjectPlaceholder")} />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {projectGroups.map((group) => (
                  <SelectItem key={group.localProjectId} value={group.localProjectId}>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{group.projectName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {group.localProjectId}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedProject ? (
            <WorkspaceCanvasSharingProjectPanel
              project={selectedProject}
              sharedCanvases={sharedCanvases}
              shareableCanvases={shareableCanvases}
              selectedCanvasId={selectedCanvasId}
              busyKey={busyKey}
              shareError={shareError}
              pendingAuthoritySwitch={pendingAuthoritySwitch !== null}
              t={t}
              onSelectCanvas={setSelectedCanvasId}
              onShare={(candidate) => void share(candidate)}
              onRetryShare={retryShare}
              onRetryOpen={() => void retryOpen()}
            />
          ) : null}
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
