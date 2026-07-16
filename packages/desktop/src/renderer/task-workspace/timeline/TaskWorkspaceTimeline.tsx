import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { TaskWorkspaceAnnotation } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { VerticalResizeHandle } from "../../components/VerticalResizeHandle";
import { LiveRunElapsedText } from "../LiveDurationText";
import { taskWorkspacePanelMaxWidth, taskWorkspacePanelMinWidth } from "../useTaskWorkspaceLayout";
import { TaskWorkspaceOverview } from "./TaskWorkspaceOverview";
import { projectTaskWorkspaceTimeline } from "./timelineProjection";
import type {
  TaskWorkspaceTimelineLabels,
  TaskWorkspaceTimelineProps,
  TimelineRunProjection,
  TimelineRunStatus
} from "./types";
import { useTimelineResize } from "./useTimelineResize";
import { useTimelineWindow } from "./useTimelineWindow";

const statusClasses: Record<TimelineRunStatus, string> = {
  active: "border-primary/50 bg-primary/10 text-primary",
  cancelled: "border-border bg-surface-muted text-text-muted",
  completed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  waiting: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
};

function statusLabel(status: TimelineRunStatus, labels: TaskWorkspaceTimelineLabels): string {
  const labelsByStatus: Record<TimelineRunStatus, string> = {
    active: labels.running,
    cancelled: labels.cancelled,
    completed: labels.completed,
    failed: labels.failed,
    waiting: labels.waiting
  };
  return labelsByStatus[status];
}

function effectiveFocusRecord(
  focusedRecordId: string | null,
  selectedRecordId: string | null,
  recordIds: string[]
): string | null {
  if (focusedRecordId && recordIds.includes(focusedRecordId)) {
    return focusedRecordId;
  }
  if (selectedRecordId && recordIds.includes(selectedRecordId)) {
    return selectedRecordId;
  }
  return recordIds[0] ?? null;
}

function nextRecordIndex(key: string, currentIndex: number, runCount: number): number | null {
  switch (key) {
    case "ArrowDown":
      return Math.min(runCount - 1, currentIndex + 1);
    case "ArrowUp":
      return Math.max(0, currentIndex - 1);
    case "Home":
      return 0;
    case "End":
      return runCount - 1;
    default:
      return null;
  }
}

function annotationStatus(
  annotation: TaskWorkspaceAnnotation,
  labels: TaskWorkspaceTimelineLabels
): string | null {
  if (annotation.kind === "review_attempt") {
    return annotation.verdict ? labels.reviewVerdict[annotation.verdict] : labels.unavailable;
  }
  if (annotation.status) return labels.feedbackStatus[annotation.status];
  return annotation.finishedAt ? labels.completed : labels.running;
}

function TimelineAnnotationOption({
  annotation,
  labels,
  onSelect,
  selected
}: {
  annotation: TaskWorkspaceAnnotation;
  labels: TaskWorkspaceTimelineLabels;
  onSelect: () => void;
  selected: boolean;
}) {
  const occurredAt =
    annotation.kind === "review_attempt"
      ? annotation.reviewedAt
      : annotation.kind === "feedback"
        ? annotation.createdAt
        : annotation.startedAt;
  const identity =
    annotation.kind === "review_attempt"
      ? annotation.attemptId
      : annotation.kind === "feedback"
        ? annotation.feedbackId
        : annotation.recordId;
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "w-full cursor-pointer rounded-xl border border-border/75 bg-background/65 px-3.5 py-3 text-left outline-none transition-colors",
        "hover:bg-app-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
        selected && "border-primary/50 bg-primary/5 ring-1 ring-primary/15"
      )}
      data-annotation-kind={annotation.kind}
      data-record-id={annotation.associatedRunRecordId ?? undefined}
      onClick={onSelect}
      type="button"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-text">
          {labels.annotationKinds[annotation.kind]}
        </span>
        <Badge className="h-6 shrink-0 px-2 text-xs" variant="outline">
          {annotationStatus(annotation, labels)}
        </Badge>
      </span>
      {annotation.contentPreview ? (
        <span
          className="mt-2.5 block max-h-10 overflow-hidden text-xs leading-5 text-text-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
          data-testid="task-workspace-annotation-preview"
        >
          {annotation.contentPreview}
        </span>
      ) : null}
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-4 text-text-muted">
        <dt>{labels.annotationKinds[annotation.kind]}</dt>
        <dd className="truncate font-mono" title={identity}>
          {identity}
        </dd>
        <dt>{labels.startedAt}</dt>
        <dd className="truncate" title={occurredAt ?? labels.unavailable}>
          {occurredAt ? labels.formatDateTime(occurredAt) : labels.unavailable}
        </dd>
      </dl>
    </button>
  );
}

function TimelineRunOption({
  focused,
  labels,
  onFocus,
  onSelect,
  register,
  run,
  selected
}: {
  focused: boolean;
  labels: TaskWorkspaceTimelineLabels;
  onFocus: () => void;
  onSelect: () => void;
  register: (element: HTMLButtonElement | null) => void;
  run: TimelineRunProjection;
  selected: boolean;
}) {
  let tabIndex = -1;
  if (focused) {
    tabIndex = 0;
  }
  let retryBadge: ReactNode = null;
  if (run.isRetry) {
    retryBadge = (
      <Badge className="h-4 px-1 text-[9px]" variant="secondary">
        {labels.retry(run.retryIndex)}
      </Badge>
    );
  }
  let waveBadge: ReactNode = null;
  if (run.executionWave) {
    waveBadge = (
      <Badge className="h-4 px-1 text-[9px]" variant="outline">
        {labels.parallelWave(
          run.executionWave.waveId,
          run.executionWave.index,
          run.executionWave.total
        )}
      </Badge>
    );
  }
  const agent =
    run.item.run.metadata.agentId ??
    run.item.run.metadata.executor ??
    run.item.run.metadata.adapter ??
    labels.unavailable;
  const startedAt = run.startedAt ? labels.formatDateTime(run.startedAt) : labels.unavailable;
  // Leaf owns the clock: only this text node re-renders on the 1 Hz tick.
  const elapsed = (
    <LiveRunElapsedText
      active={run.active}
      finishedAt={run.finishedAt}
      formatDuration={labels.formatDuration}
      startedAt={run.startedAt}
      unavailable={labels.unavailable}
      wallClockMs={run.item.run.duration.wallClockMs}
    />
  );
  return (
    <button
      aria-label={labels.run(run.blockTitle, run.retryIndex)}
      aria-selected={selected}
      className={cn(
        "w-full cursor-pointer rounded-xl border border-border/75 bg-background/65 px-3.5 py-3 text-left outline-none transition-colors",
        "hover:bg-app-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
        selected && "border-primary/50 bg-primary/5 ring-1 ring-primary/15"
      )}
      data-block-ref={run.blockRef}
      data-record-id={run.recordId}
      data-retry={run.isRetry || undefined}
      data-run-id={run.runId}
      data-status={run.status}
      data-testid="task-workspace-run-summary"
      data-wave-id={run.executionWave?.waveId}
      onClick={onSelect}
      onFocus={onFocus}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
        }
      }}
      ref={register}
      role="option"
      tabIndex={tabIndex}
      type="button"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold">
          {labels.run(run.blockTitle, run.retryIndex)}
        </span>
        <Badge
          className={cn("h-6 shrink-0 px-2 text-xs", statusClasses[run.status])}
          variant="outline"
        >
          {statusLabel(run.status, labels)}
        </Badge>
      </span>
      <span className="mt-1.5 flex flex-wrap gap-1 empty:hidden">
        {retryBadge}
        {waveBadge}
      </span>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-4 text-text-muted">
        <dt>{labels.agent}</dt>
        <dd className="truncate" title={agent}>
          {agent}
        </dd>
        <dt>{labels.runId}</dt>
        <dd className="truncate font-mono" title={run.runId}>
          {run.runId}
        </dd>
        <dt>{labels.startedAt}</dt>
        <dd className="truncate" title={startedAt}>
          {startedAt}
        </dd>
        <dt>{labels.elapsed}</dt>
        <dd className="truncate tabular-nums">{elapsed}</dd>
      </dl>
    </button>
  );
}

export function TaskWorkspaceTimeline({
  hasMoreRuns = false,
  labels,
  loadMoreRuns,
  loadMoreRunsError = null,
  loadingMoreRuns = false,
  selectAnnotation,
  selectRun,
  selectedAnnotation,
  selectedRun,
  setTimelineWidth,
  timelineWidth,
  workspace
}: TaskWorkspaceTimelineProps) {
  const projection = useMemo(() => projectTaskWorkspaceTimeline(workspace), [workspace]);
  const selectedRecordId = selectedRun?.item.run.record.recordId ?? null;
  const recordIds = useMemo(() => projection.runs.map((run) => run.recordId), [projection.runs]);
  const [focusedRecordId, setFocusedRecordId] = useState<string | null>(null);
  const pendingFocusRecordId = useRef<string | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const effectiveFocusedRecordId = effectiveFocusRecord(
    focusedRecordId,
    selectedRecordId,
    recordIds
  );
  const resize = useTimelineResize({ setTimelineWidth, timelineWidth });
  const timelineWindow = useTimelineWindow(recordIds.length);
  const visibleRuns = projection.runs.slice(timelineWindow.start, timelineWindow.end);

  useEffect(() => {
    const pending = pendingFocusRecordId.current;
    if (!pending) return;
    const option = optionRefs.current.get(pending);
    if (option) {
      pendingFocusRecordId.current = null;
      option.focus();
    }
  }, [timelineWindow.end, timelineWindow.start]);

  useEffect(() => {
    if (focusedRecordId && !recordIds.includes(focusedRecordId)) {
      setFocusedRecordId(null);
      pendingFocusRecordId.current = null;
    }
    const anchorRecordId = effectiveFocusedRecordId;
    if (!anchorRecordId) return;
    const anchorIndex = recordIds.indexOf(anchorRecordId);
    if (anchorIndex < 0) return;
    if (!optionRefs.current.has(anchorRecordId)) {
      pendingFocusRecordId.current = anchorRecordId;
    }
    timelineWindow.ensureIndexVisible(anchorIndex);
  }, [effectiveFocusedRecordId, focusedRecordId, recordIds, timelineWindow.ensureIndexVisible]);

  const focusRecord = (recordId: string) => {
    setFocusedRecordId(recordId);
    const index = recordIds.indexOf(recordId);
    if (index < 0) return;
    const option = optionRefs.current.get(recordId);
    if (option) {
      option.focus();
      return;
    }
    pendingFocusRecordId.current = recordId;
    timelineWindow.ensureIndexVisible(index);
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (recordIds.length === 0 || effectiveFocusedRecordId === null) {
      return;
    }
    const currentIndex = Math.max(0, recordIds.indexOf(effectiveFocusedRecordId));
    if (event.key === "Enter") {
      const run = projection.runs[currentIndex];
      if (run) {
        selectRun({ blockRef: run.blockRef, recordId: run.recordId });
      }
      event.preventDefault();
      return;
    }
    const nextIndex = nextRecordIndex(event.key, currentIndex, recordIds.length);
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextRecordId = recordIds[nextIndex];
    if (nextRecordId) {
      focusRecord(nextRecordId);
    }
  };

  const selectTimelineAnnotation = (annotation: TaskWorkspaceAnnotation) => {
    const recordId = annotation.associatedRunRecordId;
    if (recordId) {
      selectRun({ blockRef: annotation.sourceReviewBlockRef, recordId });
      return;
    }
    selectAnnotation({
      blockRef: annotation.sourceReviewBlockRef,
      annotationId: annotation.annotationId
    });
  };

  const isEmpty =
    projection.runs.length === 0 &&
    projection.blocks.every((block) => block.annotations.length === 0);
  let timelineContent: ReactNode = (
    <p className="py-6 text-center text-xs text-text-muted">{labels.empty}</p>
  );
  if (!isEmpty) {
    timelineContent = (
      <div
        aria-label={labels.timeline}
        className="space-y-3"
        data-testid="task-workspace-run-list"
        onKeyDown={handleListKeyDown}
        onScroll={timelineWindow.onScroll}
        role="listbox"
        style={timelineWindow.windowed ? { maxHeight: 720, overflowY: "auto" } : undefined}
      >
        {timelineWindow.beforeHeight > 0 ? (
          <div aria-hidden="true" style={{ height: timelineWindow.beforeHeight }} />
        ) : null}
        {visibleRuns.map((run, visibleIndex) => {
          const absoluteIndex = timelineWindow.start + visibleIndex;
          return (
            <div
              key={run.recordId}
              role="presentation"
              style={timelineWindow.windowed ? { height: timelineWindow.rowExtent } : undefined}
            >
              <TimelineRunOption
                focused={run.recordId === effectiveFocusedRecordId}
                labels={labels}
                onFocus={() => setFocusedRecordId(run.recordId)}
                onSelect={() => selectRun({ blockRef: run.blockRef, recordId: run.recordId })}
                register={(element) => {
                  if (element) {
                    optionRefs.current.set(run.recordId, element);
                  } else {
                    optionRefs.current.delete(run.recordId);
                  }
                }}
                run={run}
                selected={run.recordId === selectedRecordId}
              />
              <span className="sr-only">
                {absoluteIndex + 1} / {recordIds.length}
              </span>
            </div>
          );
        })}
        {timelineWindow.afterHeight > 0 ? (
          <div aria-hidden="true" style={{ height: timelineWindow.afterHeight }} />
        ) : null}
        {projection.blocks.flatMap((block) =>
          block.annotations.map((annotation) => (
            <TimelineAnnotationOption
              annotation={annotation}
              key={annotation.annotationId}
              labels={labels}
              onSelect={() => selectTimelineAnnotation(annotation)}
              selected={
                annotation.associatedRunRecordId
                  ? annotation.associatedRunRecordId === selectedRecordId
                  : selectedAnnotation?.annotation.annotationId === annotation.annotationId &&
                    selectedAnnotation.block.ref === annotation.sourceReviewBlockRef
              }
            />
          ))
        )}
        {hasMoreRuns && loadMoreRuns ? (
          <div className="pt-1">
            <button
              className="w-full rounded-md border border-border bg-surface-muted px-2 py-1.5 text-xs font-medium text-text transition-colors hover:bg-app-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="task-workspace-load-more-runs"
              disabled={loadingMoreRuns}
              onClick={() => {
                void loadMoreRuns();
              }}
              type="button"
            >
              {loadingMoreRuns ? labels.loadingMore : labels.loadMore}
            </button>
            {loadMoreRunsError ? (
              <p className="mt-1 text-xs text-destructive" role="alert">
                {loadMoreRunsError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative min-h-full pr-1">
      <TaskWorkspaceOverview
        labels={labels}
        onSelect={() => selectRun(null)}
        selected={selectedRun === null && selectedAnnotation === null}
        workspace={workspace}
      />
      <section className="p-3">
        <h2 className="mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
          {labels.timeline}
        </h2>
        {timelineContent}
      </section>
      <VerticalResizeHandle
        aria-label={labels.resizeTimeline}
        aria-orientation="vertical"
        aria-valuemax={taskWorkspacePanelMaxWidth}
        aria-valuemin={taskWorkspacePanelMinWidth}
        aria-valuenow={timelineWidth}
        onKeyDown={resize.resizeWithKeyboard}
        onPointerDown={resize.startResize}
        role="separator"
        side="right"
        tabIndex={0}
      />
    </div>
  );
}
