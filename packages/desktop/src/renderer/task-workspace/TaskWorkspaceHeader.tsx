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
      className="app-drag-region grid h-12 shrink-0 items-center bg-app-topbar"
      data-testid="task-workspace-header"
      style={{
        gridTemplateColumns: `${layout.timelineCollapsed ? "auto" : `${layout.timelineWidth}px`} minmax(0, 1fr)`
      }}
    >
      <div
        className="app-no-drag flex h-full min-w-0 items-center justify-end gap-1 overflow-hidden border-r border-b border-border/80 pr-2 pl-[124px]"
        data-testid="task-workspace-header-timeline"
      >
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
        className="grid h-full min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center border-b border-border/80 pr-3"
        data-testid="task-workspace-header-main"
      >
        <div
          className="flex h-6 min-w-0 items-center gap-2 pl-4"
          data-testid="task-workspace-title-block"
        >
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
      </div>
    </header>
  );
}
