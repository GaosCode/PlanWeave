import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { TaskWorkspaceAnnotation } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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

function AnnotationNote({
  annotation,
  labels
}: {
  annotation: TaskWorkspaceAnnotation;
  labels: TaskWorkspaceTimelineLabels;
}) {
  let preview: ReactNode = null;
  if ("contentPreview" in annotation && annotation.contentPreview) {
    preview = <div className="mt-0.5 line-clamp-2">{annotation.contentPreview}</div>;
  }
  return (
    <div
      className="ml-2 border-l-2 border-border px-2 py-1 text-xs text-text-muted"
      data-annotation-kind={annotation.kind}
      role="note"
    >
      <div className="font-medium text-text">{labels.annotationKinds[annotation.kind]}</div>
      {preview}
    </div>
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
    retryBadge = <Badge variant="secondary">{labels.retry(run.retryIndex)}</Badge>;
  }
  let waveBadge: ReactNode = null;
  if (run.executionWave) {
    waveBadge = (
      <Badge variant="outline">
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
  const elapsed =
    run.item.run.duration.wallClockMs === null
      ? labels.unavailable
      : labels.formatDuration(run.item.run.duration.wallClockMs);
  return (
    <button
      aria-label={labels.run(run.blockTitle, run.retryIndex)}
      aria-selected={selected}
      className={cn(
        "w-full cursor-pointer rounded-md border border-transparent px-2 py-2 text-left outline-none transition-colors",
        "hover:bg-app-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
        selected && "border-primary/40 bg-primary/10"
      )}
      data-record-id={run.recordId}
      data-retry={run.isRetry || undefined}
      data-status={run.status}
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
        <span className="truncate text-xs font-medium">
          {labels.run(run.blockTitle, run.retryIndex)}
        </span>
        <Badge className={statusClasses[run.status]} variant="outline">
          {statusLabel(run.status, labels)}
        </Badge>
      </span>
      <span className="mt-1 flex flex-wrap gap-1">
        {retryBadge}
        {waveBadge}
      </span>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[10px] text-text-muted">
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
  labels,
  selectRun,
  selectedRun,
  setTimelineWidth,
  timelineWidth,
  workspace
}: TaskWorkspaceTimelineProps) {
  const projection = useMemo(() => projectTaskWorkspaceTimeline(workspace), [workspace]);
  const selectedRecordId = selectedRun?.item.run.record.recordId ?? null;
  const recordIds = useMemo(() => projection.runs.map((run) => run.recordId), [projection.runs]);
  const [focusedRecordId, setFocusedRecordId] = useState<string | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const effectiveFocusedRecordId = effectiveFocusRecord(
    focusedRecordId,
    selectedRecordId,
    recordIds
  );
  const resize = useTimelineResize({ setTimelineWidth, timelineWidth });

  const focusRecord = (recordId: string) => {
    setFocusedRecordId(recordId);
    optionRefs.current.get(recordId)?.focus();
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
        onKeyDown={handleListKeyDown}
        role="listbox"
      >
        {projection.runs.map((run) => (
          <TimelineRunOption
            focused={run.recordId === effectiveFocusedRecordId}
            key={run.recordId}
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
        ))}
        {projection.blocks.flatMap((block) =>
          block.annotations.map((annotation) => (
            <AnnotationNote annotation={annotation} key={annotation.annotationId} labels={labels} />
          ))
        )}
      </div>
    );
  }

  return (
    <div className="relative min-h-full pr-1">
      <TaskWorkspaceOverview
        labels={labels}
        onSelect={() => selectRun(null)}
        selected={selectedRun === null}
        workspace={workspace}
      />
      <section className="p-3">
        <h2 className="mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
          {labels.timeline}
        </h2>
        {timelineContent}
      </section>
      <div
        aria-label={labels.resizeTimeline}
        aria-orientation="vertical"
        aria-valuemax={taskWorkspacePanelMaxWidth}
        aria-valuemin={taskWorkspacePanelMinWidth}
        aria-valuenow={timelineWidth}
        className="app-no-drag absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize bg-transparent transition-colors duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)] after:absolute after:inset-y-2 after:left-1/2 after:w-px after:-translate-x-1/2 after:rounded-full after:bg-border/80 after:opacity-0 hover:bg-state-selected/10 hover:after:opacity-100 focus-visible:bg-state-selected/10 focus-visible:after:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:bg-state-selected/20"
        onKeyDown={resize.resizeWithKeyboard}
        onPointerDown={resize.startResize}
        role="separator"
        tabIndex={0}
      />
    </div>
  );
}
