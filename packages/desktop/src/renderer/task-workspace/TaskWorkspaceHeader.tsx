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
import type { TaskWorkspaceLayout } from "./useTaskWorkspaceLayout";

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
  return (
    <header
      className="app-drag-region flex min-h-11 shrink-0 items-center gap-3 border-b border-border/80 bg-app-topbar py-1.5 pr-3 pl-[124px]"
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
