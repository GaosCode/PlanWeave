import type { ReactNode } from "react";
import type {
  TaskWorkspaceController,
  TaskWorkspaceLabels,
  TaskWorkspaceSlotRenderers
} from "./contracts";
import { TaskWorkspaceShell, TaskWorkspaceStateShell } from "./TaskWorkspaceShell";
import { useTaskWorkspaceLayout } from "./useTaskWorkspaceLayout";

function EmptySlot({ description, title }: { description: string; title: string }) {
  return (
    <section className="flex min-h-full flex-col gap-2 p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-sm text-text-muted">{description}</p>
    </section>
  );
}

function SlotError({ message, title }: { message: string; title: string }) {
  return (
    <section className="flex min-h-full flex-col gap-2 p-4" role="alert">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-sm text-destructive">{message}</p>
    </section>
  );
}

export type TaskWorkspaceRouteProps = {
  controller: TaskWorkspaceController;
  labels: TaskWorkspaceLabels;
  slots?: Partial<TaskWorkspaceSlotRenderers>;
};

export function TaskWorkspaceRoute({ controller, labels, slots = {} }: TaskWorkspaceRouteProps) {
  const sessionKey = controller.navigation
    ? `${controller.navigation.projectRoot}\0${controller.navigation.canvasId}\0${controller.navigation.taskId}`
    : "task-workspace-unavailable";
  const layout = useTaskWorkspaceLayout(sessionKey);

  if (controller.status === "idle") {
    return (
      <TaskWorkspaceStateShell labels={labels} onReturnToCanvas={controller.returnToCanvas}>
        <EmptySlot title={labels.noTask} description={labels.noTask} />
      </TaskWorkspaceStateShell>
    );
  }
  if (controller.status === "loading") {
    return (
      <TaskWorkspaceStateShell labels={labels} onReturnToCanvas={controller.returnToCanvas}>
        <EmptySlot title={labels.loading} description={labels.loading} />
      </TaskWorkspaceStateShell>
    );
  }
  if (controller.status === "error" || !controller.workspace) {
    return (
      <TaskWorkspaceStateShell labels={labels} onReturnToCanvas={controller.returnToCanvas}>
        <section className="flex h-full items-center justify-center p-6" role="alert">
          <p className="max-w-xl text-sm text-destructive">{controller.error ?? labels.noTask}</p>
        </section>
      </TaskWorkspaceStateShell>
    );
  }

  const timelineProps = {
    getRunScrollTop: controller.getRunScrollTop,
    onRunScrollTopChange: controller.onRunScrollTopChange,
    selectRun: controller.selectRun,
    selectedRun: controller.selectedRun,
    setTimelineWidth: layout.setTimelineWidth,
    timelineWidth: layout.timelineWidth,
    workspace: controller.workspace
  };
  const conversationProps = {
    getRunScrollTop: controller.getRunScrollTop,
    liveStatus: controller.liveStatus,
    liveUnavailableReason: controller.liveUnavailableReason,
    onRunScrollTopChange: controller.onRunScrollTopChange,
    recordError: controller.recordError,
    runnerModel: controller.runnerModel,
    selectedRecord: controller.selectedRecord,
    selectedRun: controller.selectedRun,
    subscriptionError: controller.subscriptionError
  };
  const inspectorProps = {
    inspectorCollapsed: layout.inspectorCollapsed,
    inspectorWidth: layout.inspectorWidth,
    selectedRecord: controller.selectedRecord,
    selectedRun: controller.selectedRun,
    setInspectorCollapsed: layout.setInspectorCollapsed,
    setInspectorWidth: layout.setInspectorWidth,
    workspace: controller.workspace
  };
  const composerProps = {
    liveStatus: controller.liveStatus,
    runnerModel: controller.runnerModel,
    selectedRun: controller.selectedRun,
    workspace: controller.workspace
  };
  const timeline: ReactNode = slots.timeline?.(timelineProps) ?? (
    <EmptySlot title={labels.timeline} description={labels.noRuns} />
  );
  const conversation: ReactNode = controller.recordError ? (
    <SlotError title={labels.conversation} message={controller.recordError} />
  ) : (
    (slots.conversation?.(conversationProps) ?? (
      <EmptySlot
        title={labels.conversation}
        description={
          controller.liveStatus === "unavailable"
            ? (controller.liveUnavailableReason ?? labels.liveUnavailable)
            : labels.noConversation
        }
      />
    ))
  );
  const inspector: ReactNode = slots.inspector?.(inspectorProps) ?? (
    <EmptySlot title={labels.inspector} description={labels.noInspector} />
  );
  const composer: ReactNode = slots.composer?.(composerProps) ?? (
    <EmptySlot title={labels.composer} description={labels.noConversation} />
  );
  const headerAction: ReactNode =
    slots.headerAction?.({
      runnerModel: controller.runnerModel,
      selectedRun: controller.selectedRun
    }) ?? null;

  return (
    <TaskWorkspaceShell
      composer={composer}
      conversation={conversation}
      headerAction={headerAction}
      inspector={inspector}
      labels={labels}
      layout={layout}
      onReturnToCanvas={controller.returnToCanvas}
      selectedRun={controller.selectedRun}
      timeline={timeline}
      workspace={controller.workspace}
    />
  );
}
