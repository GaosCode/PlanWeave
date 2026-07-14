import type { TaskWorkspace } from "@planweave-ai/runtime";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskWorkspaceLabels } from "./contracts";
import { TaskWorkspaceHeader } from "./TaskWorkspaceHeader";
import {
  taskWorkspaceConversationMinWidth,
  taskWorkspacePanelMaxWidth,
  taskWorkspacePanelMinWidth,
  type TaskWorkspaceLayout
} from "./useTaskWorkspaceLayout";
import { useTaskWorkspaceReturnShortcut } from "./useTaskWorkspaceReturnShortcut";

interface AnimatedWorkspacePanelProps {
  children: ReactNode;
  collapsed: boolean;
  label: string;
  side: "left" | "right";
  testId?: string;
  width: number;
}

function AnimatedWorkspacePanel({
  children,
  collapsed,
  label,
  side,
  testId,
  width
}: AnimatedWorkspacePanelProps) {
  let interactionClassName = "opacity-100";
  let minimumWidth = taskWorkspacePanelMinWidth;
  let panelWidth = width;
  let inert: true | undefined;
  let borderClassName = "border-r border-border/80";
  if (collapsed) {
    interactionClassName = "pointer-events-none opacity-0";
    minimumWidth = 0;
    panelWidth = 0;
    inert = true;
  }
  if (side === "right") {
    borderClassName = "border-l border-border/80";
  }

  return (
    <aside
      aria-hidden={collapsed}
      aria-label={label}
      className={cn(
        "relative min-h-0 shrink overflow-x-hidden overflow-y-auto bg-app-panel transition-[width,opacity] duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)] motion-reduce:transition-none",
        borderClassName,
        interactionClassName
      )}
      data-testid={testId}
      inert={inert}
      style={{ maxWidth: taskWorkspacePanelMaxWidth, minWidth: minimumWidth, width: panelWidth }}
    >
      {children}
    </aside>
  );
}

export type TaskWorkspaceShellProps = {
  composer: ReactNode;
  conversation: ReactNode;
  headerAction: ReactNode;
  inspector: ReactNode;
  labels: TaskWorkspaceLabels;
  layout: TaskWorkspaceLayout;
  onReturnToCanvas: () => void;
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
      <header className="app-drag-region flex min-h-11 shrink-0 items-center border-b border-border/80 bg-app-topbar py-1.5 pr-3 pl-[124px]">
        <Button className="app-no-drag" size="sm" variant="ghost" onClick={onReturnToCanvas}>
          <ArrowLeftIcon data-icon="inline-start" />
          {labels.backToCanvas}
        </Button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

export function TaskWorkspaceShell({
  composer,
  conversation,
  headerAction,
  inspector,
  labels,
  layout,
  onReturnToCanvas,
  timeline,
  workspace
}: TaskWorkspaceShellProps) {
  useTaskWorkspaceReturnShortcut(onReturnToCanvas);
  const retainedInspector = useRef<{ content: ReactNode; workspaceIdentity: string } | null>(null);
  const workspaceIdentity = `${workspace.project.projectId}\0${workspace.project.canvasId}\0${workspace.task.taskId}`;

  useEffect(() => {
    if (!layout.inspectorCollapsed) {
      retainedInspector.current = { content: inspector, workspaceIdentity };
    }
  }, [inspector, layout.inspectorCollapsed, workspaceIdentity]);

  let inspectorContent: ReactNode = null;
  if (!layout.inspectorCollapsed) {
    inspectorContent = inspector;
  } else if (retainedInspector.current?.workspaceIdentity === workspaceIdentity) {
    inspectorContent = retainedInspector.current.content;
  }
  const hasOpenedInspector = inspectorContent !== null;

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
        workspace={workspace}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <AnimatedWorkspacePanel
          collapsed={layout.timelineCollapsed}
          label={labels.timeline}
          side="left"
          testId="task-workspace-timeline-slot"
          width={layout.timelineWidth}
        >
          {timeline}
        </AnimatedWorkspacePanel>
        <main
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          style={{ minWidth: taskWorkspaceConversationMinWidth }}
        >
          <div
            className="min-h-0 min-w-0 flex-1 overflow-y-auto"
            data-testid="task-workspace-conversation-slot"
          >
            {conversation}
          </div>
          {composer ? (
            <div className="shrink-0 bg-app-shell" data-testid="task-workspace-composer-slot">
              {composer}
            </div>
          ) : null}
        </main>
        <AnimatedWorkspacePanel
          collapsed={layout.inspectorCollapsed}
          label={labels.inspector}
          side="right"
          testId={hasOpenedInspector ? "task-workspace-inspector-slot" : undefined}
          width={layout.inspectorWidth}
        >
          {inspectorContent}
        </AnimatedWorkspacePanel>
      </div>
    </section>
  );
}
