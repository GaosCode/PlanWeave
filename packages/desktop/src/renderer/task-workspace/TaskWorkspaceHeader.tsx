import type { TaskWorkspace } from "@planweave-ai/runtime";
import {
  ArrowLeftIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { TaskWorkspaceLabels } from "./contracts";
import type { TaskWorkspaceLayout } from "./useTaskWorkspaceLayout";

export function TaskWorkspaceHeader({
  headerAction,
  labels,
  layout,
  onReturnToCanvas,
  workspace
}: {
  headerAction: ReactNode;
  labels: TaskWorkspaceLabels;
  layout: TaskWorkspaceLayout;
  onReturnToCanvas: () => void;
  workspace: TaskWorkspace;
}) {
  return (
    <header
      className="app-drag-region grid min-h-11 shrink-0 grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border/80 bg-app-topbar py-1.5 pr-3 pl-[124px]"
      data-testid="task-workspace-header"
    >
      <div className="app-no-drag flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={onReturnToCanvas}>
          <ArrowLeftIcon data-icon="inline-start" />
          {labels.backToCanvas}
        </Button>
        <Button
          aria-label={labels.timeline}
          aria-pressed={!layout.timelineCollapsed}
          onClick={() => layout.setTimelineCollapsed((current) => !current)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {layout.timelineCollapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
        </Button>
      </div>
      <div
        aria-hidden="true"
        className="h-4 w-px shrink-0 bg-border/80"
        data-testid="task-workspace-header-divider"
      />
      <div className="flex min-w-0 items-center gap-2" data-testid="task-workspace-title-block">
        <span className="truncate text-sm leading-5 font-medium">{workspace.task.title}</span>
      </div>
      <div className="app-no-drag flex shrink-0 items-center gap-2">{headerAction}</div>
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
