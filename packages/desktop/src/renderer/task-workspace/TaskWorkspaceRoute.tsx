import { useEffect, useRef, type ReactNode } from "react";
import type {
  TaskWorkspaceController,
  TaskWorkspaceLabels,
  TaskWorkspaceSlotRenderers
} from "./contracts";
import { TaskWorkspaceAnnotationDetail } from "./TaskWorkspaceAnnotationDetail";
import { TaskWorkspaceShell, TaskWorkspaceStateShell } from "./TaskWorkspaceShell";
import { TaskWorkspaceOverviewPanel } from "./timeline/TaskWorkspaceOverview";
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

function LoadingBar({ className }: { className: string }) {
  return <span aria-hidden="true" className={`block rounded-full bg-border/70 ${className}`} />;
}

function TaskWorkspaceLoadingState({ label }: { label: string }) {
  return (
    <section
      aria-busy="true"
      aria-label={label}
      className="flex h-full min-h-0 min-w-0 animate-pulse overflow-hidden motion-reduce:animate-none"
      data-testid="task-workspace-loading-state"
      role="status"
    >
      <h2 className="sr-only">{label}</h2>
      <aside
        aria-hidden="true"
        className="flex w-72 shrink-0 flex-col border-r border-border/80 bg-app-panel"
        data-testid="task-workspace-loading-timeline"
      >
        <div className="space-y-4 border-b border-border/70 p-4">
          <LoadingBar className="h-3 w-24" />
          <LoadingBar className="h-5 w-4/5" />
          <div className="space-y-2 pt-1">
            <LoadingBar className="h-2.5 w-full" />
            <LoadingBar className="h-2.5 w-2/3" />
          </div>
        </div>
        <div className="space-y-3 p-4">
          <LoadingBar className="h-3 w-20" />
          <div className="h-24 rounded-lg border border-border/70 bg-app-canvas/55 p-3">
            <LoadingBar className="h-3 w-3/4" />
            <LoadingBar className="mt-4 h-2.5 w-1/2" />
            <LoadingBar className="mt-2 h-2.5 w-2/3" />
          </div>
        </div>
      </aside>
      <main
        aria-hidden="true"
        className="flex min-w-0 flex-1 flex-col bg-app-canvas"
        data-testid="task-workspace-loading-main"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-8 py-10">
          <div className="space-y-3">
            <LoadingBar className="h-4 w-36" />
            <LoadingBar className="h-7 w-3/5" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="h-24 rounded-xl border border-border/70 bg-app-panel/45 p-4">
              <LoadingBar className="h-3 w-24" />
              <LoadingBar className="mt-5 h-4 w-2/3" />
            </div>
            <div className="h-24 rounded-xl border border-border/70 bg-app-panel/45 p-4">
              <LoadingBar className="h-3 w-28" />
              <LoadingBar className="mt-5 h-4 w-1/2" />
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-border/70 bg-app-panel/35 p-4">
            <LoadingBar className="h-3 w-28" />
            <LoadingBar className="h-3 w-full" />
            <LoadingBar className="h-3 w-11/12" />
            <LoadingBar className="h-3 w-3/4" />
          </div>
        </div>
      </main>
      <aside
        aria-hidden="true"
        className="hidden w-80 shrink-0 flex-col border-l border-border/80 bg-app-panel xl:flex"
        data-testid="task-workspace-loading-inspector"
      >
        <div className="space-y-4 p-4">
          <LoadingBar className="h-3 w-24" />
          <LoadingBar className="h-5 w-3/4" />
          <div className="space-y-3 pt-3">
            <LoadingBar className="h-3 w-full" />
            <LoadingBar className="h-3 w-5/6" />
            <LoadingBar className="h-3 w-2/3" />
          </div>
        </div>
      </aside>
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
  const directTargetKey =
    controller.navigation && !controller.navigation.recordId
      ? `${controller.navigation.projectRoot}\0${controller.navigation.canvasId}\0${controller.navigation.taskId}\0${controller.navigation.blockRef ?? "task"}`
      : null;
  const pendingDirectTargetRef = useRef<string | null>(null);
  const openedDirectTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (directTargetKey) {
      pendingDirectTargetRef.current = directTargetKey;
    }
    const pendingTarget = pendingDirectTargetRef.current;
    if (
      !controller.selectedRun ||
      !pendingTarget ||
      openedDirectTargetRef.current === pendingTarget
    ) {
      return;
    }
    openedDirectTargetRef.current = pendingTarget;
    pendingDirectTargetRef.current = null;
    layout.setInspectorCollapsed(false);
  }, [controller.selectedRun, directTargetKey, layout.setInspectorCollapsed]);

  if (controller.status === "idle") {
    return (
      <TaskWorkspaceStateShell
        labels={labels}
        onReturnToCanvas={controller.returnToCanvas}
        status="idle"
        taskId={controller.navigation?.taskId ?? null}
      >
        <EmptySlot title={labels.noTask} description={labels.noTask} />
      </TaskWorkspaceStateShell>
    );
  }
  if (controller.status === "loading") {
    return (
      <TaskWorkspaceStateShell
        labels={labels}
        onReturnToCanvas={controller.returnToCanvas}
        status="loading"
        taskId={controller.navigation?.taskId ?? null}
      >
        <TaskWorkspaceLoadingState label={labels.loading} />
      </TaskWorkspaceStateShell>
    );
  }
  if (controller.status === "error" || !controller.workspace) {
    return (
      <TaskWorkspaceStateShell
        labels={labels}
        onReturnToCanvas={controller.returnToCanvas}
        status="error"
        taskId={controller.navigation?.taskId ?? null}
      >
        <section className="flex h-full items-center justify-center p-6" role="alert">
          <p className="max-w-xl text-sm text-destructive">{controller.error ?? labels.noTask}</p>
        </section>
      </TaskWorkspaceStateShell>
    );
  }

  const timelineProps = {
    getRunScrollTop: controller.getRunScrollTop,
    hasMoreRuns: controller.hasMoreRuns,
    loadMoreRuns: controller.loadMoreRuns,
    loadMoreRunsError: controller.loadMoreRunsError,
    loadingMoreRuns: controller.loadingMoreRuns,
    onRunScrollTopChange: controller.onRunScrollTopChange,
    selectAnnotation: controller.selectAnnotation,
    selectRun: controller.selectRun,
    selectedAnnotation: controller.selectedAnnotation,
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
    focusedBlock:
      controller.selectedAnnotation?.block ??
      controller.selectedRun?.block ??
      (controller.navigation?.blockRef
        ? (controller.workspace.blocks.find(
            (block) => block.ref === controller.navigation?.blockRef
          ) ?? null)
        : null),
    inspectorCollapsed: layout.inspectorCollapsed,
    inspectorWidth: layout.inspectorWidth,
    runnerModel: controller.runnerModel,
    selectedRecord: controller.selectedRecord,
    selectedRun: controller.selectedRun,
    setInspectorCollapsed: layout.setInspectorCollapsed,
    setInspectorWidth: layout.setInspectorWidth,
    workspace: controller.workspace
  };
  const composerProps = {
    liveStatus: controller.liveStatus,
    refresh: controller.refresh,
    runnerModel: controller.runnerModel,
    selectedRun: controller.selectedRun,
    workspace: controller.workspace
  };
  const routedRunLoading =
    !controller.selectedRun &&
    Boolean(controller.navigation?.recordId) &&
    controller.liveStatus === "loading";
  const timeline: ReactNode = slots.timeline?.(timelineProps) ?? (
    <EmptySlot title={labels.timeline} description={labels.noRuns} />
  );
  const conversation: ReactNode = controller.selectedAnnotation ? (
    <TaskWorkspaceAnnotationDetail labels={labels} selected={controller.selectedAnnotation} />
  ) : routedRunLoading ? (
    (slots.conversation?.(conversationProps) ?? (
      <EmptySlot title={labels.conversation} description={labels.loading} />
    ))
  ) : !controller.selectedRun ? (
    <TaskWorkspaceOverviewPanel
      executorOptions={controller.executorOptions}
      focusedBlockRef={controller.navigation?.blockRef ?? null}
      labels={labels}
      onSaveBlockExecutor={controller.saveBlockExecutor}
      onSaveBlockPrompt={controller.saveBlockPrompt}
      onSaveTaskExecutor={controller.saveTaskExecutor}
      onSaveTaskPrompt={controller.saveTaskPrompt}
      packageExecutorNames={controller.packageExecutorNames}
      workspace={controller.workspace}
    />
  ) : controller.recordError ? (
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
  const composer: ReactNode = controller.selectedRun
    ? (slots.composer?.(composerProps) ?? (
        <EmptySlot title={labels.composer} description={labels.noConversation} />
      ))
    : null;
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
      timeline={timeline}
      workspace={controller.workspace}
    />
  );
}
