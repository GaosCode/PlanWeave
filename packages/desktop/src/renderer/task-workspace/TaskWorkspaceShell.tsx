import type { TaskWorkspace } from "@planweave-ai/runtime";
import { ArrowLeftIcon, PanelLeftOpenIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskWorkspaceLabels, TaskWorkspaceSelectedRun } from "./contracts";
import { TaskWorkspaceHeader } from "./TaskWorkspaceHeader";
import { taskWorkspaceRunStatus } from "./timeline";
import type { TaskWorkspaceLayout } from "./useTaskWorkspaceLayout";
import { useTaskWorkspaceReturnShortcut } from "./useTaskWorkspaceReturnShortcut";

export type TaskWorkspaceShellProps = {
  composer: ReactNode;
  conversation: ReactNode;
  headerAction: ReactNode;
  inspector: ReactNode;
  labels: TaskWorkspaceLabels;
  layout: TaskWorkspaceLayout;
  onReturnToCanvas: () => void;
  selectedRun: TaskWorkspaceSelectedRun | null;
  timeline: ReactNode;
  workspace: TaskWorkspace;
};

export function TaskWorkspaceStateShell({
  children,
  labels,
  onReturnToCanvas
}: {
  children: ReactNode;
  labels: TaskWorkspaceLabels;
  onReturnToCanvas: () => void;
}) {
  useTaskWorkspaceReturnShortcut(onReturnToCanvas);

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-shell text-text"
      data-testid="task-workspace-shell"
    >
      <header className="app-drag-region flex min-h-11 shrink-0 items-center border-b border-border/80 bg-app-topbar px-3 py-1.5">
        <Button className="app-no-drag" size="sm" variant="ghost" onClick={onReturnToCanvas}>
          <ArrowLeftIcon data-icon="inline-start" />
          {labels.backToCanvas}
        </Button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

const compactStatusClassName = {
  active: "rounded-full bg-primary",
  cancelled: "rounded-[1px] border border-text-muted bg-surface-muted",
  completed: "rounded-full border-2 border-emerald-500 bg-transparent",
  empty: "rounded-full border border-border bg-transparent",
  failed: "rounded-[1px] bg-destructive",
  waiting: "rotate-45 border border-amber-500 bg-amber-500/20"
} as const;

export function TaskWorkspaceShell({
  composer,
  conversation,
  headerAction,
  inspector,
  labels,
  layout,
  onReturnToCanvas,
  selectedRun,
  timeline,
  workspace
}: TaskWorkspaceShellProps) {
  useTaskWorkspaceReturnShortcut(onReturnToCanvas);
  const compactStatus = selectedRun
    ? labels.runStatus[taskWorkspaceRunStatus(selectedRun.item)]
    : labels.noRuns;
  const compactStatusKey = selectedRun ? taskWorkspaceRunStatus(selectedRun.item) : "empty";
  const compactAgent = selectedRun
    ? (selectedRun.item.run.metadata.agentId ??
      selectedRun.item.run.metadata.executor ??
      selectedRun.item.run.metadata.adapter ??
      labels.unavailable)
    : labels.unavailable;

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-shell text-text"
      data-testid="task-workspace-shell"
    >
      <TaskWorkspaceHeader
        headerAction={headerAction}
        labels={labels}
        layout={layout}
        onReturnToCanvas={onReturnToCanvas}
        selectedRun={selectedRun}
        workspace={workspace}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {layout.timelineCollapsed ? (
          <aside
            aria-label={labels.timeline}
            className="flex w-20 shrink-0 flex-col items-center gap-2 border-r border-border/80 bg-app-panel px-1 py-2"
            data-testid="task-workspace-timeline-compact"
          >
            <Button
              aria-label={labels.expandTimeline}
              onClick={() => layout.setTimelineCollapsed(false)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <PanelLeftOpenIcon />
            </Button>
            <span
              className="w-full truncate text-center font-mono text-[10px] text-text-muted"
              title={compactAgent}
            >
              {compactAgent}
            </span>
            <span className="flex max-w-full items-center gap-1" role="status">
              <span
                aria-hidden="true"
                className={cn("size-2 shrink-0", compactStatusClassName[compactStatusKey])}
                data-run-status={compactStatusKey}
                data-testid="task-workspace-timeline-status-indicator"
              />
              <span className="truncate text-[10px]" title={compactStatus}>
                {compactStatus}
              </span>
            </span>
          </aside>
        ) : (
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
          {composer ? (
            <div
              className="shrink-0 border-t border-border/80 bg-app-panel"
              data-testid="task-workspace-composer-slot"
            >
              {composer}
            </div>
          ) : null}
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
