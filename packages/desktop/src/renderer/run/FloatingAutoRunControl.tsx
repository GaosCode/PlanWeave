import {
  useEffect,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent,
  type Ref,
  type SetStateAction
} from "react";
import type {
  DesktopAutoRunRetrospectiveSummary,
  DesktopAutoRunState,
  DesktopCanvasReference,
  DesktopProjectSummary,
  ValidationIssue
} from "@planweave-ai/runtime";
import { MoveIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useExecutorPreflight } from "../hooks/useExecutorPreflight";
import type { createTranslator } from "../i18n";
import type { AutoRunNextActionDescriptor } from "./autoRunNextActions";
import type { AutoRunScopeMode } from "../types";
import { AutoRunMiniPanel } from "./AutoRunMiniPanel";
import { AutoRunScopeContextMenu, AutoRunScopeControl } from "./AutoRunScopeControl";
import { DesktopDiagnosticsPopover } from "./DesktopDiagnosticsPopover";
import { FileSyncPopover } from "./FileSyncPopover";

type FloatingAutoRunControlProps = {
  affectedTasks: string[];
  autoRunNextAction: AutoRunNextActionDescriptor | null;
  autoRunRetrospective: DesktopAutoRunRetrospectiveSummary | null;
  autoRunScopeMode: AutoRunScopeMode;
  autoRunState: DesktopAutoRunState | null;
  controlRef: Ref<HTMLDivElement>;
  diagnostics: ValidationIssue[];
  projectDiagnostics: ValidationIssue[];
  dirtyPromptCount: number;
  dirtyPromptRefs: string[];
  applyCanvasLaneLayout?: (ref: DesktopCanvasReference) => Promise<void>;
  copyText?: (text: string) => Promise<void>;
  autoRunPreflightExecutorHint: string | null;
  handleAutoRunClick: () => Promise<void>;
  handleAutoRunNextAction: (action: AutoRunNextActionDescriptor) => Promise<void>;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
  miniRunPanelOpen: boolean;
  moveAutoRunControl: (event: PointerEvent<HTMLButtonElement>) => void;
  onOpenFileSyncRef: (ref: string) => void;
  refreshPackageFiles: () => Promise<void>;
  refreshProjectDerivedState?: () => Promise<void>;
  refreshedPromptCount: number;
  refreshConcurrency: number | null;
  watcherBackendKind?: "native" | "polling";
  watcherChangedPathCount?: number;
  watcherRefreshElapsedMs?: number;
  resetRuntimeStateClick: () => Promise<void>;
  selectedBlockPresent: boolean;
  selectedCanvasId?: string | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setAutoRunScopeMode: Dispatch<SetStateAction<AutoRunScopeMode>>;
  setError?: (message: string | null) => void;
  setMiniRunPanelOpen: Dispatch<SetStateAction<boolean>>;
  startAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  stopAutoRunClick: () => Promise<void>;
  stopAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  style: CSSProperties;
  t: ReturnType<typeof createTranslator>;
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function fileSyncChangeKey(options: {
  affectedTasks: string[];
  diagnostics: ValidationIssue[];
  dirtyPromptRefs: string[];
}): string {
  return JSON.stringify({
    affectedTasks: uniqueStrings(options.affectedTasks).sort(),
    dirtyPromptRefs: uniqueStrings(options.dirtyPromptRefs).sort(),
    diagnostics: options.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      path: diagnostic.path ?? null
    }))
  });
}

export function FloatingAutoRunControl({
  affectedTasks,
  autoRunNextAction,
  autoRunRetrospective,
  autoRunScopeMode,
  autoRunState,
  controlRef,
  diagnostics,
  projectDiagnostics,
  dirtyPromptCount,
  dirtyPromptRefs,
  applyCanvasLaneLayout,
  copyText,
  autoRunPreflightExecutorHint,
  handleAutoRunClick,
  handleAutoRunNextAction,
  handleRevealPathInFinder,
  miniRunPanelOpen,
  moveAutoRunControl,
  onOpenFileSyncRef,
  refreshPackageFiles,
  refreshProjectDerivedState,
  refreshedPromptCount,
  refreshConcurrency,
  watcherBackendKind,
  watcherChangedPathCount,
  watcherRefreshElapsedMs,
  resetRuntimeStateClick,
  selectedBlockPresent,
  selectedCanvasId = null,
  selectedProject,
  selectedTaskPanelId,
  setAutoRunScopeMode,
  setError,
  setMiniRunPanelOpen,
  startAutoRunControlDrag,
  stopAutoRunClick,
  stopAutoRunControlDrag,
  style,
  t
}: FloatingAutoRunControlProps) {
  const canStop = autoRunState
    ? ["running", "pausing", "paused", "manual"].includes(autoRunState.phase)
    : false;
  const hasProject = Boolean(selectedProject);
  const explanation = autoRunState?.explanation ?? null;
  const currentExecutor = explanation?.currentExecutor ?? null;
  const startupPreflightExecutor =
    autoRunScopeMode === "project" ? autoRunPreflightExecutorHint : null;
  const preflightExecutor = currentExecutor ?? startupPreflightExecutor;
  const preflightCanvasId = autoRunState?.canvasId ?? selectedCanvasId;
  const canvasRef = selectedProject
    ? { projectRoot: selectedProject.rootPath, canvasId: preflightCanvasId }
    : null;
  const executorPreflight = useExecutorPreflight({
    bridgeUnavailableMessage: t("bridgeUnavailable"),
    cacheKey:
      autoRunState?.runSessionId ?? autoRunState?.runId ?? autoRunPreflightExecutorHint ?? "",
    canvasRef,
    executorName: preflightExecutor
  });
  const fileSyncDirtyRefs = uniqueStrings(dirtyPromptRefs);
  const fileSyncAffectedTasks = uniqueStrings(affectedTasks);
  const fileSyncDirtyCount = Math.max(dirtyPromptCount, fileSyncDirtyRefs.length);
  const fileSyncIssueCount = fileSyncDirtyCount + fileSyncAffectedTasks.length + diagnostics.length;
  const currentFileSyncChangeKey =
    fileSyncIssueCount > 0
      ? fileSyncChangeKey({
          affectedTasks: fileSyncAffectedTasks,
          diagnostics,
          dirtyPromptRefs: fileSyncDirtyRefs
        })
      : null;
  const [fileSyncPopoverOpen, setFileSyncPopoverOpen] = useState(false);
  const [viewedFileSyncChangeKey, setViewedFileSyncChangeKey] = useState<string | null>(null);
  const showFileSyncUnreadCount =
    fileSyncIssueCount > 0 && currentFileSyncChangeKey !== viewedFileSyncChangeKey;
  const diagnosticActionContext =
    selectedProject &&
    selectedCanvasId &&
    applyCanvasLaneLayout &&
    copyText &&
    refreshProjectDerivedState &&
    setError
      ? {
          projectId: selectedProject.projectId,
          projectRoot: selectedProject.rootPath,
          canvasId: selectedCanvasId,
          applyCanvasLaneLayout,
          copyText,
          refreshProjectDerivedState,
          setError
        }
      : null;

  useEffect(() => {
    if (fileSyncPopoverOpen) {
      setViewedFileSyncChangeKey(currentFileSyncChangeKey);
    }
  }, [currentFileSyncChangeKey, fileSyncPopoverOpen]);

  return (
    <div
      className="absolute flex items-center gap-2 rounded-xl border bg-background p-2 shadow-lg"
      data-auto-run-control
      ref={controlRef}
      style={style}
    >
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("dragAutoRunControl")}
        title={t("dragAutoRunControl")}
        onPointerDown={startAutoRunControlDrag}
        onPointerMove={moveAutoRunControl}
        onPointerUp={stopAutoRunControlDrag}
        onPointerCancel={stopAutoRunControlDrag}
      >
        <MoveIcon data-icon="inline-start" />
      </Button>
      <FileSyncPopover
        affectedTasks={fileSyncAffectedTasks}
        diagnostics={diagnostics}
        dirtyPromptRefs={fileSyncDirtyRefs}
        disabled={!hasProject}
        issueCount={fileSyncIssueCount}
        onOpenChange={setFileSyncPopoverOpen}
        onOpenFileSyncRef={onOpenFileSyncRef}
        open={fileSyncPopoverOpen}
        refreshConcurrency={refreshConcurrency}
        refreshPackageFiles={refreshPackageFiles}
        refreshedPromptCount={refreshedPromptCount}
        showUnreadCount={showFileSyncUnreadCount}
        t={t}
        watcherBackendKind={watcherBackendKind}
        watcherChangedPathCount={watcherChangedPathCount}
        watcherRefreshElapsedMs={watcherRefreshElapsedMs}
      />
      <DesktopDiagnosticsPopover
        actionContext={diagnosticActionContext}
        diagnostics={projectDiagnostics}
        disabled={!hasProject}
        t={t}
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <span>
            <AutoRunMiniPanel
              autoRunNextAction={autoRunNextAction}
              autoRunRetrospective={autoRunRetrospective}
              autoRunState={autoRunState}
              canStop={canStop}
              executorPreflight={executorPreflight}
              handleAutoRunClick={handleAutoRunClick}
              handleAutoRunNextAction={handleAutoRunNextAction}
              handleRevealPathInFinder={handleRevealPathInFinder}
              hasProject={hasProject}
              miniRunPanelOpen={miniRunPanelOpen}
              preflightExecutor={preflightExecutor}
              resetRuntimeStateClick={resetRuntimeStateClick}
              selectedProject={selectedProject}
              setMiniRunPanelOpen={setMiniRunPanelOpen}
              stopAutoRunClick={stopAutoRunClick}
              t={t}
            />
          </span>
        </ContextMenuTrigger>
        <AutoRunScopeContextMenu
          autoRunScopeMode={autoRunScopeMode}
          hasProject={hasProject}
          selectedBlockPresent={selectedBlockPresent}
          selectedTaskPanelId={selectedTaskPanelId}
          setAutoRunScopeMode={setAutoRunScopeMode}
          setMiniRunPanelOpen={setMiniRunPanelOpen}
          t={t}
        />
      </ContextMenu>
      {canStop ? (
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={t("stop")}
          title={t("stop")}
          onClick={() => void stopAutoRunClick()}
        >
          <SquareIcon data-icon="inline-start" />
        </Button>
      ) : null}
      <Button
        size="icon-sm"
        variant="outline"
        aria-label={t("resetRuntimeState")}
        title={t("resetRuntimeState")}
        disabled={!hasProject}
        onClick={() => void resetRuntimeStateClick()}
      >
        <RotateCcwIcon data-icon="inline-start" />
      </Button>
      {!hasProject ? (
        <span className="max-w-[180px] text-xs text-muted-foreground">
          {t("autoRunNoProjectHint")}
        </span>
      ) : null}
      <AutoRunScopeControl
        autoRunScopeMode={autoRunScopeMode}
        hasProject={hasProject}
        selectedBlockPresent={selectedBlockPresent}
        selectedTaskPanelId={selectedTaskPanelId}
        setAutoRunScopeMode={setAutoRunScopeMode}
        t={t}
      />
      <Badge
        title={t("runStatus")}
        variant={
          autoRunState?.phase === "blocked" || autoRunState?.phase === "failed"
            ? "destructive"
            : "outline"
        }
      >
        {autoRunState?.phase ?? t("autoRunStopped")}
      </Badge>
    </div>
  );
}
