import type { ReactNode } from "react";
import { ArrowLeftIcon, PanelLeftCloseIcon, PanelRightCloseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TaskWorkspaceLabels } from "./contracts";
import type { TaskWorkspaceLayout } from "./useTaskWorkspaceLayout";

export type TaskWorkspaceShellProps = {
  composer: ReactNode;
  conversation: ReactNode;
  inspector: ReactNode;
  labels: TaskWorkspaceLabels;
  layout: TaskWorkspaceLayout;
  onReturnToCanvas: () => void;
  taskStatus: string;
  taskTitle: string;
  timeline: ReactNode;
};

export function TaskWorkspaceShell({
  composer,
  conversation,
  inspector,
  labels,
  layout,
  onReturnToCanvas,
  taskStatus,
  taskTitle,
  timeline
}: TaskWorkspaceShellProps) {
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-shell text-text"
      data-testid="task-workspace-shell"
    >
      <header className="app-drag-region flex h-11 shrink-0 items-center gap-3 border-b border-border/80 bg-app-topbar px-3">
        <Button className="app-no-drag" size="sm" variant="ghost" onClick={onReturnToCanvas}>
          <ArrowLeftIcon data-icon="inline-start" />
          {labels.backToCanvas}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{taskTitle}</div>
          <div className="truncate text-xs text-text-muted">{taskStatus}</div>
        </div>
        <Button
          className="app-no-drag"
          size="icon-sm"
          variant="ghost"
          aria-label={labels.timeline}
          aria-pressed={layout.timelineCollapsed}
          onClick={() => layout.setTimelineCollapsed((current) => !current)}
        >
          <PanelLeftCloseIcon data-icon="inline-start" />
        </Button>
        <Button
          className="app-no-drag"
          size="icon-sm"
          variant="ghost"
          aria-label={labels.inspector}
          aria-pressed={layout.inspectorCollapsed}
          onClick={() => layout.setInspectorCollapsed((current) => !current)}
        >
          <PanelRightCloseIcon data-icon="inline-start" />
        </Button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {layout.timelineCollapsed ? null : (
          <aside
            className="min-h-0 shrink-0 overflow-y-auto border-r border-border/80 bg-app-panel"
            data-testid="task-workspace-timeline-slot"
            style={{ width: layout.timelineWidth }}
          >
            {timeline}
          </aside>
        )}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div
            className="min-h-0 min-w-0 flex-1 overflow-y-auto"
            data-testid="task-workspace-conversation-slot"
          >
            {conversation}
          </div>
          <div
            className="shrink-0 border-t border-border/80 bg-app-panel"
            data-testid="task-workspace-composer-slot"
          >
            {composer}
          </div>
        </main>
        {layout.inspectorCollapsed ? null : (
          <aside
            className="min-h-0 shrink-0 overflow-y-auto border-l border-border/80 bg-app-panel"
            data-testid="task-workspace-inspector-slot"
            style={{ width: layout.inspectorWidth }}
          >
            {inspector}
          </aside>
        )}
      </div>
    </section>
  );
}
