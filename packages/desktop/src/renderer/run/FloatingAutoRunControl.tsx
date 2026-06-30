import { useEffect, useState, type CSSProperties, type Dispatch, type PointerEvent, type ReactNode, type Ref, type SetStateAction } from "react";
import type { DesktopAutoRunRetrospectiveSummary, DesktopAutoRunState, DesktopProjectSummary, ValidationIssue } from "@planweave-ai/runtime";
import { ChevronDownIcon, ChevronRightIcon, ClipboardIcon, FolderOpenIcon, MoveIcon, PauseIcon, PlayIcon, RefreshCwIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useExecutorPreflight } from "../hooks/useExecutorPreflight";
import type { createTranslator } from "../i18n";
import type { AutoRunNextActionDescriptor } from "./autoRunNextActions";
import type { AutoRunScopeMode } from "../types";
import { formatElapsed } from "../viewHelpers";

type FloatingAutoRunControlProps = {
  affectedTasks: string[];
  autoRunNextAction: AutoRunNextActionDescriptor | null;
  autoRunRetrospective: DesktopAutoRunRetrospectiveSummary | null;
  autoRunScopeMode: AutoRunScopeMode;
  autoRunState: DesktopAutoRunState | null;
  controlRef: Ref<HTMLDivElement>;
  diagnostics: ValidationIssue[];
  dirtyPromptCount: number;
  dirtyPromptRefs: string[];
  autoRunPreflightExecutorHint: string | null;
  handleAutoRunClick: () => Promise<void>;
  handleAutoRunNextAction: (action: AutoRunNextActionDescriptor) => Promise<void>;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
  miniRunPanelOpen: boolean;
  moveAutoRunControl: (event: PointerEvent<HTMLButtonElement>) => void;
  onOpenFileSyncRef: (ref: string) => void;
  refreshPackageFiles: () => Promise<void>;
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
  setMiniRunPanelOpen: Dispatch<SetStateAction<boolean>>;
  startAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  stopAutoRunClick: () => Promise<void>;
  stopAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  style: CSSProperties;
  t: ReturnType<typeof createTranslator>;
};

function isFailureState(state: DesktopAutoRunState | null): state is DesktopAutoRunState {
  return state?.phase === "blocked" || state?.phase === "failed";
}

function FailureDetailRow({ label, testId, value }: { label: string; testId?: string; value: string | null | undefined }) {
  if (!value) {
    return null;
  }
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words" data-testid={testId}>{value}</span>
    </div>
  );
}

function AutoRunFailureDetails({ state, t }: { state: DesktopAutoRunState; t: ReturnType<typeof createTranslator> }) {
  const explanation = state.explanation;
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs" data-testid="auto-run-failure-details">
      <div className="mb-2 font-medium text-destructive">{t("failureDetails")}</div>
      <div className="flex flex-col gap-1.5">
        <FailureDetailRow label={t("phase")} value={state.phase} />
        <FailureDetailRow label={t("error")} testId="auto-run-error" value={explanation.error ?? state.error} />
        <FailureDetailRow label={t("nextAction")} value={explanation.nextAction.message} />
        <FailureDetailRow label={t("actionKind")} value={explanation.nextAction.kind} />
        <FailureDetailRow label={t("suggestedCommand")} testId="auto-run-command" value={explanation.nextAction.command} />
        <FailureDetailRow label={t("latestRecordPath")} testId="auto-run-latest-record-path" value={explanation.latestRecordPath} />
        <FailureDetailRow label={t("currentBlock")} value={explanation.currentRef} />
        <FailureDetailRow label={t("agent")} value={explanation.currentExecutor} />
        <FailureDetailRow label={t("latestOutput")} value={explanation.latestOutputSummary} />
      </div>
    </div>
  );
}

function DisclosureSection({
  children,
  defaultOpen = false,
  testId,
  title
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border bg-muted/20 text-xs" data-testid={testId}>
      <Button
        className="h-auto w-full justify-start gap-1.5 rounded-none px-2 py-1.5 text-left text-xs font-medium"
        size="sm"
        type="button"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
        {title}
      </Button>
      {open ? <div className="border-t border-border/70 p-2">{children}</div> : null}
    </div>
  );
}

function AutoRunActionRow({
  action,
  handleAutoRunNextAction,
  t
}: {
  action: AutoRunNextActionDescriptor | null;
  handleAutoRunNextAction: (action: AutoRunNextActionDescriptor) => Promise<void>;
  t: ReturnType<typeof createTranslator>;
}) {
  if (!action) {
    return null;
  }
  return (
    <div className="rounded-md border bg-muted/30 p-2 text-xs" data-testid="auto-run-action-row">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-text-strong">{t("nextAction")}</div>
          <div className="break-words text-muted-foreground">{action.message}</div>
          {action.disabledReason ? <div className="mt-1 break-words text-text-faint">{action.disabledReason}</div> : null}
        </div>
        <Button
          data-action-kind={action.nextActionKind}
          data-testid="auto-run-next-action"
          disabled={!action.enabled}
          size="sm"
          variant={action.command === "retry_ref" ? "destructive" : "outline"}
          onClick={() => void handleAutoRunNextAction(action)}
        >
          {action.command === "copy_manual_command" ? <ClipboardIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          {action.label}
        </Button>
      </div>
      {action.manualCommand ? (
        <div className="break-all rounded border border-border/70 bg-background px-2 py-1 font-mono text-[11px]" data-testid="auto-run-manual-command">
          {action.manualCommand}
        </div>
      ) : null}
    </div>
  );
}

function AutoRunRetrospectiveDetails({
  retrospective,
  handleRevealPathInFinder,
  t
}: {
  retrospective: DesktopAutoRunRetrospectiveSummary | null;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
  t: ReturnType<typeof createTranslator>;
}) {
  if (!retrospective) {
    return null;
  }
  const verdicts = retrospective.reviewVerdicts.map((review) => review.verdict ?? t("none")).join(", ");
  return (
    <div className="text-xs" data-testid="auto-run-retrospective-details">
      <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-muted-foreground">
        <span>{t("completedRefs")}</span>
        <span data-testid="auto-run-completed-refs">{retrospective.completedBlockRefs.length}</span>
        <span>{t("failedReason")}</span>
        <span className="min-w-0 break-words">{retrospective.failedReason ?? "-"}</span>
        <span>{t("reviewVerdict")}</span>
        <span className="min-w-0 break-words">{verdicts || "-"}</span>
        <span>{t("elapsedTime")}</span>
        <span>{formatElapsed(retrospective.elapsedMs)}</span>
        <span>{t("latestReportPath")}</span>
        <span className="min-w-0 break-all" data-testid="auto-run-latest-report-path">{retrospective.latestReportPath ?? "-"}</span>
        <span>{t("nextSuggestion")}</span>
        <span className="min-w-0 break-words">{retrospective.nextAction.message}</span>
      </div>
      {retrospective.latestReportPath ? (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => void handleRevealPathInFinder(retrospective.latestReportPath)}>
            <FolderOpenIcon data-icon="inline-start" />
            {t("openReport")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function fileSyncChangeKey(options: { affectedTasks: string[]; diagnostics: ValidationIssue[]; dirtyPromptRefs: string[] }): string {
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

function FileSyncRefList({
  emptyLabel,
  items,
  label,
  onOpenFileSyncRef
}: {
  emptyLabel: string;
  items: string[];
  label: string;
  onOpenFileSyncRef: (ref: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold text-text-strong">{label}</div>
      {items.length > 0 ? (
        <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
          {items.map((item) => (
            <Button
              className="h-auto justify-start px-2 py-1.5 text-left text-xs"
              data-testid="file-sync-ref"
              key={item}
              size="sm"
              variant="ghost"
              onClick={() => onOpenFileSyncRef(item)}
            >
              <span className="min-w-0 break-all">{item}</span>
            </Button>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</div>
      )}
    </div>
  );
}

function FileSyncDiagnosticsList({ diagnostics, emptyLabel, label }: { diagnostics: ValidationIssue[]; emptyLabel: string; label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold text-text-strong">{label}</div>
      {diagnostics.length > 0 ? (
        <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
          {diagnostics.map((diagnostic, index) => (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs" data-testid="file-sync-diagnostic" key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`}>
              <div className="font-medium text-destructive">{diagnostic.code}</div>
              <div className="break-words text-muted-foreground">{diagnostic.message}</div>
              {diagnostic.path ? <div className="mt-1 break-all text-text-faint">{diagnostic.path}</div> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</div>
      )}
    </div>
  );
}

export function FloatingAutoRunControl({
  affectedTasks,
  autoRunNextAction,
  autoRunRetrospective,
  autoRunScopeMode,
  autoRunState,
  controlRef,
  diagnostics,
  dirtyPromptCount,
  dirtyPromptRefs,
  autoRunPreflightExecutorHint,
  handleAutoRunClick,
  handleAutoRunNextAction,
  handleRevealPathInFinder,
  miniRunPanelOpen,
  moveAutoRunControl,
  onOpenFileSyncRef,
  refreshPackageFiles,
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
  setMiniRunPanelOpen,
  startAutoRunControlDrag,
  stopAutoRunClick,
  stopAutoRunControlDrag,
  style,
  t
}: FloatingAutoRunControlProps) {
  const canStop = autoRunState ? ["running", "pausing", "paused", "manual"].includes(autoRunState.phase) : false;
  const hasProject = Boolean(selectedProject);
  const explanation = autoRunState?.explanation ?? null;
  const currentExecutor = explanation?.currentExecutor ?? null;
  const startupPreflightExecutor = autoRunScopeMode === "project" ? autoRunPreflightExecutorHint : null;
  const preflightExecutor = currentExecutor ?? startupPreflightExecutor;
  const preflightCanvasId = autoRunState?.canvasId ?? selectedCanvasId;
  const canvasRef = selectedProject ? { projectRoot: selectedProject.rootPath, canvasId: preflightCanvasId } : null;
  const executorPreflight = useExecutorPreflight({
    bridgeUnavailableMessage: t("bridgeUnavailable"),
    cacheKey: autoRunState?.runSessionId ?? autoRunState?.runId ?? autoRunPreflightExecutorHint ?? "",
    canvasRef,
    executorName: preflightExecutor
  });
  const showFailureDetails = isFailureState(autoRunState);
  const fileSyncDirtyRefs = uniqueStrings(dirtyPromptRefs);
  const fileSyncAffectedTasks = uniqueStrings(affectedTasks);
  const fileSyncDirtyCount = Math.max(dirtyPromptCount, fileSyncDirtyRefs.length);
  const fileSyncIssueCount = fileSyncDirtyCount + fileSyncAffectedTasks.length + diagnostics.length;
  const currentFileSyncChangeKey = fileSyncIssueCount > 0 ? fileSyncChangeKey({ affectedTasks: fileSyncAffectedTasks, diagnostics, dirtyPromptRefs: fileSyncDirtyRefs }) : null;
  const [fileSyncPopoverOpen, setFileSyncPopoverOpen] = useState(false);
  const [viewedFileSyncChangeKey, setViewedFileSyncChangeKey] = useState<string | null>(null);
  const showFileSyncUnreadCount = fileSyncIssueCount > 0 && currentFileSyncChangeKey !== viewedFileSyncChangeKey;

  useEffect(() => {
    if (fileSyncPopoverOpen) {
      setViewedFileSyncChangeKey(currentFileSyncChangeKey);
    }
  }, [currentFileSyncChangeKey, fileSyncPopoverOpen]);

  return (
    <div className="absolute flex items-center gap-2 rounded-xl border bg-background p-2 shadow-lg" data-auto-run-control ref={controlRef} style={style}>
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
      <Popover open={fileSyncPopoverOpen} onOpenChange={setFileSyncPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            className="relative"
            data-testid="file-sync-trigger"
            size="icon-sm"
            variant={fileSyncIssueCount ? "outline" : "ghost"}
            aria-label={t("viewFileSyncChanges")}
            title={t("viewFileSyncChanges")}
            disabled={!hasProject}
          >
            <RefreshCwIcon data-icon="inline-start" />
            {showFileSyncUnreadCount ? (
              <span
                className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full border border-background bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
                data-testid="file-sync-unread-count"
              >
                {fileSyncIssueCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80" data-testid="file-sync-popover">
          <PopoverHeader>
            <PopoverTitle>{t("fileSyncChanges")}</PopoverTitle>
            <PopoverDescription>{fileSyncIssueCount > 0 ? t("fileSyncChangesHint") : t("fileSyncNoChanges")}</PopoverDescription>
          </PopoverHeader>
          <div className="flex flex-col gap-3">
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => void refreshPackageFiles()}>
                <RefreshCwIcon data-icon="inline-start" />
                {t("recheckFiles")}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
              <span>{t("refreshedPrompts")}</span>
              <span data-testid="file-sync-refreshed-prompt-count">{refreshedPromptCount}</span>
              <span>{t("refreshConcurrency")}</span>
              <span data-testid="file-sync-refresh-concurrency">{refreshConcurrency ?? "-"}</span>
              <span>{t("changedPaths")}</span>
              <span data-testid="file-sync-changed-path-count">{watcherChangedPathCount ?? "-"}</span>
              <span>{t("watchBackend")}</span>
              <span data-testid="file-sync-watch-backend">{watcherBackendKind ?? "-"}</span>
              <span>{t("watchElapsed")}</span>
              <span data-testid="file-sync-watch-elapsed">{watcherRefreshElapsedMs === undefined ? "-" : formatElapsed(watcherRefreshElapsedMs)}</span>
            </div>
            <DisclosureSection title={t("dirtyPrompts")} testId="file-sync-dirty-prompts-section">
              <FileSyncRefList
                emptyLabel={t("fileSyncNoChanges")}
                items={fileSyncDirtyRefs}
                label={t("dirtyPrompts")}
                onOpenFileSyncRef={onOpenFileSyncRef}
              />
            </DisclosureSection>
            <DisclosureSection title={t("affectedTasks")} testId="file-sync-affected-tasks-section">
              <FileSyncRefList
                emptyLabel={t("fileSyncNoChanges")}
                items={fileSyncAffectedTasks}
                label={t("affectedTasks")}
                onOpenFileSyncRef={onOpenFileSyncRef}
              />
            </DisclosureSection>
            <DisclosureSection title={t("diagnostics")} testId="file-sync-diagnostics-section">
              <FileSyncDiagnosticsList diagnostics={diagnostics} emptyLabel={t("fileSyncNoChanges")} label={t("diagnostics")} />
            </DisclosureSection>
          </div>
        </PopoverContent>
      </Popover>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <span>
            <Popover open={miniRunPanelOpen} onOpenChange={setMiniRunPanelOpen}>
              <PopoverTrigger asChild>
                <Button
                  data-testid="auto-run-trigger"
                  size="icon-lg"
                  variant={autoRunState?.phase === "blocked" || autoRunState?.phase === "failed" ? "destructive" : "default"}
                  aria-label={t("autoRun")}
                  title={t("autoRun")}
                  disabled={!hasProject}
                  onClick={() => void handleAutoRunClick()}
                >
                  {autoRunState?.phase === "running" ? (
                    <PauseIcon data-icon="inline-start" />
                  ) : autoRunState?.phase === "pausing" ? (
                    <RefreshCwIcon className="animate-spin" data-icon="inline-start" />
                  ) : (
                    <PlayIcon data-icon="inline-start" />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-96" data-testid="auto-run-mini-panel">
                <PopoverHeader>
                  <PopoverTitle>{t("miniRunPanel")}</PopoverTitle>
                  <PopoverDescription>{selectedProject?.name ?? t("autoRunNoProjectHint")}</PopoverDescription>
                </PopoverHeader>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{t("runStatus")}</span>
                    <Badge
                      data-phase={autoRunState?.phase ?? "idle"}
                      data-run-id={autoRunState?.runId ?? ""}
                      data-testid="auto-run-mini-status"
                      variant={autoRunState?.phase === "blocked" || autoRunState?.phase === "failed" ? "destructive" : "outline"}
                    >
                      {autoRunState?.phase ?? t("miniPanelEmpty")}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <span>
                      {t("currentBlock")}: {explanation?.currentRef ?? "-"}
                    </span>
                    <span>
                      {t("agent")}: {explanation?.currentExecutor ?? "-"}
                    </span>
                    <span>
                      {t("elapsedTime")}: {autoRunState ? formatElapsed(autoRunState.elapsedMs) : "-"}
                    </span>
                    <span>
                      {t("stepCount")}: {autoRunState ? `${autoRunState.stepCount}` : "-"}
                    </span>
                    {autoRunState?.runSessionId ? (
                      <span className="col-span-2 min-w-0">
                        {t("runSession")}:{" "}
                        <span className="break-all font-mono" data-testid="auto-run-session-id">
                          {autoRunState.runSessionId}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {preflightExecutor ? (
                    <DisclosureSection title={t("executorPreflight")} testId="auto-run-executor-preflight-section">
                      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        <span>{preflightExecutor}</span>
                        {executorPreflight.result ? (
                          <Badge data-testid="auto-run-executor-preflight-status" variant={executorPreflight.result.ok ? "secondary" : "destructive"}>
                            {executorPreflight.result.ok ? t("preflightPassed") : t("preflightFailed")}
                          </Badge>
                        ) : executorPreflight.error ? (
                          <span className="text-destructive">{executorPreflight.error}</span>
                        ) : (
                          <span>{t("executorPreflightNotRun")}</span>
                        )}
                        <Button
                          data-testid="auto-run-executor-preflight"
                          disabled={!selectedProject || executorPreflight.loading}
                          size="sm"
                          variant="outline"
                          onClick={() => void executorPreflight.runPreflight()}
                        >
                          <RefreshCwIcon className={executorPreflight.loading ? "animate-spin" : undefined} data-icon="inline-start" />
                          {executorPreflight.loading ? t("preflightRunning") : t("runPreflight")}
                        </Button>
                      </div>
                    </DisclosureSection>
                  ) : null}
                  <AutoRunActionRow action={autoRunNextAction} handleAutoRunNextAction={handleAutoRunNextAction} t={t} />
                  {explanation?.latestOutputSummary ? (
                    <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                      {t("latestOutput")}: {explanation.latestOutputSummary}
                    </div>
                  ) : null}
                  {explanation && !autoRunNextAction ? (
                    <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                      {t("nextAction")}: {explanation.nextAction.message}
                    </div>
                  ) : null}
                  {showFailureDetails ? (
                    <DisclosureSection title={t("failureDetails")} testId="auto-run-failure-section">
                      <AutoRunFailureDetails state={autoRunState} t={t} />
                    </DisclosureSection>
                  ) : explanation?.error ? (
                    <div className="rounded-md border border-destructive p-2 text-xs text-destructive" data-testid="auto-run-error">{explanation.error}</div>
                  ) : null}
                  {autoRunRetrospective ? (
                    <DisclosureSection title={t("retrospective")} testId="auto-run-retrospective">
                      <AutoRunRetrospectiveDetails
                        retrospective={autoRunRetrospective}
                        handleRevealPathInFinder={handleRevealPathInFinder}
                        t={t}
                      />
                    </DisclosureSection>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={!hasProject} onClick={() => void resetRuntimeStateClick()}>
                      <RotateCcwIcon data-icon="inline-start" />
                      {t("resetRuntimeState")}
                    </Button>
                    {explanation?.latestRecordPath ? (
                      <Button
                        data-record-path={explanation.latestRecordPath}
                        data-run-id={autoRunState?.runId ?? ""}
                        data-testid="auto-run-open-record"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleRevealPathInFinder(explanation.latestRecordPath)}
                      >
                        <FolderOpenIcon data-icon="inline-start" />
                        {t("openRecord")}
                      </Button>
                    ) : null}
                    {canStop ? (
                      <Button size="sm" variant="outline" onClick={() => void stopAutoRunClick()}>
                        <SquareIcon data-icon="inline-start" />
                        {t("stop")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>{t("autoRunScope")}</ContextMenuLabel>
          <ContextMenuRadioGroup value={autoRunScopeMode} onValueChange={(value) => setAutoRunScopeMode(value as AutoRunScopeMode)}>
            <ContextMenuRadioItem disabled={!hasProject} value="project">{t("projectScope")}</ContextMenuRadioItem>
            <ContextMenuRadioItem disabled={!hasProject || (!selectedTaskPanelId && !selectedBlockPresent)} value="selectedTask">
              {t("selectedTaskScope")}
            </ContextMenuRadioItem>
            <ContextMenuRadioItem disabled={!hasProject || !selectedBlockPresent} value="selectedBlock">
              {t("selectedBlockScope")}
            </ContextMenuRadioItem>
          </ContextMenuRadioGroup>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setMiniRunPanelOpen(true)}>{t("miniRunPanel")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {canStop ? (
        <Button size="icon-sm" variant="outline" aria-label={t("stop")} title={t("stop")} onClick={() => void stopAutoRunClick()}>
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
      {!hasProject ? <span className="max-w-[180px] text-xs text-muted-foreground">{t("autoRunNoProjectHint")}</span> : null}
      <Select value={autoRunScopeMode} onValueChange={(value) => setAutoRunScopeMode(value as AutoRunScopeMode)}>
        <SelectTrigger className="h-9 w-36" disabled={!hasProject} title={t("autoRunScope")}>
          <SelectValue aria-label={t("autoRunScope")} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="project">{t("projectScope")}</SelectItem>
            <SelectItem disabled={!selectedTaskPanelId && !selectedBlockPresent} value="selectedTask">
              {t("selectedTaskScope")}
            </SelectItem>
            <SelectItem disabled={!selectedBlockPresent} value="selectedBlock">
              {t("selectedBlockScope")}
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Badge title={t("runStatus")} variant={autoRunState?.phase === "blocked" || autoRunState?.phase === "failed" ? "destructive" : "outline"}>
        {autoRunState?.phase ?? t("autoRunStopped")}
      </Badge>
    </div>
  );
}
