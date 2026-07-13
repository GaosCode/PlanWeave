import type { TaskWorkspace } from "@planweave-ai/runtime";
import {
  ArrowLeftIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TaskWorkspaceLabels, TaskWorkspaceSelectedRun } from "./contracts";
import { displayConfigurationValue } from "./inspector/formatters";
import { taskWorkspaceRunStatus } from "./timeline";
import type { TaskWorkspaceLayout } from "./useTaskWorkspaceLayout";

function configurationValue(
  selectedRun: TaskWorkspaceSelectedRun | null,
  field: "mode" | "model" | "permission" | "reasoning",
  labels: TaskWorkspaceLabels
): string {
  const configuration = selectedRun?.item.run.actualConfiguration;
  if (!configuration?.available) return labels.unavailable;
  const value = configuration.fields[field];
  if (!value.available) return labels.unavailable;
  return displayConfigurationValue(value.value, {
    false: labels.booleanFalse,
    true: labels.booleanTrue
  });
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-16 shrink-0">
      <span className="text-[10px] text-text-muted">{label}</span>
      <span className="block max-w-32 truncate text-xs font-medium" title={value}>
        {value}
      </span>
    </span>
  );
}

export function TaskWorkspaceHeader({
  headerAction,
  labels,
  layout,
  onReturnToCanvas,
  selectedRun,
  workspace
}: {
  headerAction: ReactNode;
  labels: TaskWorkspaceLabels;
  layout: TaskWorkspaceLayout;
  onReturnToCanvas: () => void;
  selectedRun: TaskWorkspaceSelectedRun | null;
  workspace: TaskWorkspace;
}) {
  const run = selectedRun?.item.run ?? null;
  const agent = run?.metadata.agentId ?? run?.metadata.executor ?? run?.metadata.adapter;
  const status = selectedRun
    ? labels.runStatus[taskWorkspaceRunStatus(selectedRun.item)]
    : labels.unavailable;
  const elapsed = run?.duration.wallClockMs;

  return (
    <header
      className="app-drag-region flex min-h-11 shrink-0 items-center gap-3 border-b border-border/80 bg-app-topbar px-3 py-1.5"
      data-testid="task-workspace-header"
    >
      <Button className="app-no-drag" size="sm" variant="ghost" onClick={onReturnToCanvas}>
        <ArrowLeftIcon data-icon="inline-start" />
        {labels.backToCanvas}
      </Button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{workspace.task.title}</span>
          <Badge className="shrink-0 font-mono" variant="outline">
            {workspace.task.taskId}
          </Badge>
          <Badge className="shrink-0" variant="secondary">
            {labels.taskStatus[workspace.task.status]}
          </Badge>
        </div>
        <div className="truncate font-mono text-[10px] text-text-muted">
          {selectedRun?.item.run.record.runId ?? labels.unavailable}
        </div>
      </div>
      <div
        className="app-no-drag flex max-w-[50vw] min-w-0 items-center gap-3 overflow-x-auto border-l border-border/80 pl-3"
        data-testid="task-workspace-run-summary"
      >
        <RunMetric label={labels.agent} value={agent ?? labels.unavailable} />
        <RunMetric label={labels.status} value={status} />
        <RunMetric label={labels.model} value={configurationValue(selectedRun, "model", labels)} />
        <RunMetric
          label={labels.reasoning}
          value={configurationValue(selectedRun, "reasoning", labels)}
        />
        <RunMetric label={labels.mode} value={configurationValue(selectedRun, "mode", labels)} />
        <RunMetric
          label={labels.permission}
          value={configurationValue(selectedRun, "permission", labels)}
        />
        <RunMetric
          label={labels.elapsed}
          value={
            elapsed === null || elapsed === undefined
              ? labels.unavailable
              : labels.formatDuration(elapsed)
          }
        />
      </div>
      {headerAction}
      <Button
        aria-label={labels.timeline}
        aria-pressed={layout.timelineCollapsed}
        className="app-no-drag"
        onClick={() => layout.setTimelineCollapsed((current) => !current)}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        {layout.timelineCollapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
      </Button>
      <Button
        aria-label={labels.inspector}
        aria-pressed={!layout.inspectorCollapsed}
        className="app-no-drag"
        onClick={() => layout.setInspectorCollapsed((current) => !current)}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        {layout.inspectorCollapsed ? <PanelRightOpenIcon /> : <PanelRightCloseIcon />}
      </Button>
    </header>
  );
}
