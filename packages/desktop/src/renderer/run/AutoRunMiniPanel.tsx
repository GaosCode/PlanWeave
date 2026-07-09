import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type {
  DesktopAutoRunRetrospectiveSummary,
  DesktopAutoRunState,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardIcon,
  FolderOpenIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SquareIcon
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from "@/components/ui/popover";
import { formatElapsed } from "../viewHelpers";
import type { AutoRunNextActionDescriptor } from "./autoRunNextActions";
import type { ExecutorPreflightView, FloatingAutoRunTranslator } from "./floatingAutoRunTypes";

type AutoRunMiniPanelProps = {
  autoRunNextAction: AutoRunNextActionDescriptor | null;
  autoRunRetrospective: DesktopAutoRunRetrospectiveSummary | null;
  autoRunState: DesktopAutoRunState | null;
  canStop: boolean;
  executorPreflight: ExecutorPreflightView;
  handleAutoRunClick: () => Promise<void>;
  handleAutoRunNextAction: (action: AutoRunNextActionDescriptor) => Promise<void>;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
  hasProject: boolean;
  miniRunPanelOpen: boolean;
  preflightExecutor: string | null;
  resetRuntimeStateClick: () => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  setMiniRunPanelOpen: Dispatch<SetStateAction<boolean>>;
  stopAutoRunClick: () => Promise<void>;
  t: FloatingAutoRunTranslator;
};

function isFailureState(state: DesktopAutoRunState | null): state is DesktopAutoRunState {
  return state?.phase === "blocked" || state?.phase === "failed";
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
        {open ? (
          <ChevronDownIcon data-icon="inline-start" />
        ) : (
          <ChevronRightIcon data-icon="inline-start" />
        )}
        {title}
      </Button>
      {open ? <div className="border-t border-border/70 p-2">{children}</div> : null}
    </div>
  );
}

function FailureDetailRow({
  label,
  testId,
  value
}: {
  label: string;
  testId?: string;
  value: string | null | undefined;
}) {
  if (!value) {
    return null;
  }
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function AutoRunFailureDetails({
  state,
  t
}: {
  state: DesktopAutoRunState;
  t: FloatingAutoRunTranslator;
}) {
  const explanation = state.explanation;
  return (
    <div
      className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs"
      data-testid="auto-run-failure-details"
    >
      <div className="mb-2 font-medium text-destructive">{t("failureDetails")}</div>
      <div className="flex flex-col gap-1.5">
        <FailureDetailRow label={t("phase")} value={state.phase} />
        <FailureDetailRow
          label={t("error")}
          testId="auto-run-error"
          value={explanation.error ?? state.error}
        />
        <FailureDetailRow label={t("nextAction")} value={explanation.nextAction.message} />
        <FailureDetailRow label={t("actionKind")} value={explanation.nextAction.kind} />
        <FailureDetailRow
          label={t("suggestedCommand")}
          testId="auto-run-command"
          value={explanation.nextAction.command}
        />
        <FailureDetailRow
          label={t("latestRecordPath")}
          testId="auto-run-latest-record-path"
          value={explanation.latestRecordPath}
        />
        <FailureDetailRow label={t("currentBlock")} value={explanation.currentRef} />
        <FailureDetailRow label={t("agent")} value={explanation.currentExecutor} />
        <FailureDetailRow label={t("latestOutput")} value={explanation.latestOutputSummary} />
      </div>
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
  t: FloatingAutoRunTranslator;
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
          {action.disabledReason ? (
            <div className="mt-1 break-words text-text-faint">{action.disabledReason}</div>
          ) : null}
        </div>
        <Button
          data-action-kind={action.nextActionKind}
          data-testid="auto-run-next-action"
          disabled={!action.enabled}
          size="sm"
          variant={action.command === "retry_ref" ? "destructive" : "outline"}
          onClick={() => void handleAutoRunNextAction(action)}
        >
          {action.command === "copy_manual_command" ? (
            <ClipboardIcon data-icon="inline-start" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {action.label}
        </Button>
      </div>
      {action.manualCommand ? (
        <div
          className="break-all rounded border border-border/70 bg-background px-2 py-1 font-mono text-[11px]"
          data-testid="auto-run-manual-command"
        >
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
  t: FloatingAutoRunTranslator;
}) {
  if (!retrospective) {
    return null;
  }
  const verdicts = retrospective.reviewVerdicts
    .map((review) => review.verdict ?? t("none"))
    .join(", ");
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
        <span className="min-w-0 break-all" data-testid="auto-run-latest-report-path">
          {retrospective.latestReportPath ?? "-"}
        </span>
        <span>{t("nextSuggestion")}</span>
        <span className="min-w-0 break-words">{retrospective.nextAction.message}</span>
      </div>
      {retrospective.latestReportPath ? (
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleRevealPathInFinder(retrospective.latestReportPath)}
          >
            <FolderOpenIcon data-icon="inline-start" />
            {t("openReport")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function AutoRunMiniPanel({
  autoRunNextAction,
  autoRunRetrospective,
  autoRunState,
  canStop,
  executorPreflight,
  handleAutoRunClick,
  handleAutoRunNextAction,
  handleRevealPathInFinder,
  hasProject,
  miniRunPanelOpen,
  preflightExecutor,
  resetRuntimeStateClick,
  selectedProject,
  setMiniRunPanelOpen,
  stopAutoRunClick,
  t
}: AutoRunMiniPanelProps) {
  const explanation = autoRunState?.explanation ?? null;
  const showFailureDetails = isFailureState(autoRunState);
  return (
    <Popover open={miniRunPanelOpen} onOpenChange={setMiniRunPanelOpen}>
      <PopoverTrigger asChild>
        <Button
          data-testid="auto-run-trigger"
          size="icon-lg"
          variant={
            autoRunState?.phase === "blocked" || autoRunState?.phase === "failed"
              ? "destructive"
              : "default"
          }
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
          <PopoverDescription>
            {selectedProject?.name ?? t("autoRunNoProjectHint")}
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t("runStatus")}</span>
            <Badge
              data-phase={autoRunState?.phase ?? "idle"}
              data-run-id={autoRunState?.runId ?? ""}
              data-testid="auto-run-mini-status"
              variant={
                autoRunState?.phase === "blocked" || autoRunState?.phase === "failed"
                  ? "destructive"
                  : "outline"
              }
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
            <DisclosureSection
              title={t("executorPreflight")}
              testId="auto-run-executor-preflight-section"
            >
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span>{preflightExecutor}</span>
                {executorPreflight.result ? (
                  <Badge
                    data-testid="auto-run-executor-preflight-status"
                    variant={executorPreflight.result.ok ? "secondary" : "destructive"}
                  >
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
                  <RefreshCwIcon
                    className={executorPreflight.loading ? "animate-spin" : undefined}
                    data-icon="inline-start"
                  />
                  {executorPreflight.loading ? t("preflightRunning") : t("runPreflight")}
                </Button>
              </div>
            </DisclosureSection>
          ) : null}
          <AutoRunActionRow
            action={autoRunNextAction}
            handleAutoRunNextAction={handleAutoRunNextAction}
            t={t}
          />
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
            <div
              className="rounded-md border border-destructive p-2 text-xs text-destructive"
              data-testid="auto-run-error"
            >
              {explanation.error}
            </div>
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
            <Button
              size="sm"
              variant="outline"
              disabled={!hasProject}
              onClick={() => void resetRuntimeStateClick()}
            >
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
  );
}
