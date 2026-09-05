import { useMemo } from "react";
import { bridge } from "../bridge";
import {
  lookupBlockAssigneeChip,
  lookupTaskAssigneeChip
} from "../collaboration/assigneeSurfaceViewModels";
import { useProjectWorkspace } from "../ProjectWorkspaceProvider";
import { TaskWorkspaceRepositoryActions } from "../task-workspace/TaskWorkspaceRepositoryActions";
import { TaskWorkspaceRoute } from "../task-workspace/TaskWorkspaceRoute";
import {
  TaskWorkspaceCancelRunControllerScope,
  TaskWorkspaceComposer,
  TaskWorkspaceConversation
} from "../task-workspace/conversation";
import type {
  TaskWorkspaceComposerSlotProps,
  TaskWorkspaceConversationSlotProps,
  TaskWorkspaceInspectorSlotProps,
  TaskWorkspaceTimelineSlotProps
} from "../task-workspace/contracts";
import { TaskWorkspaceInspector } from "../task-workspace/inspector/TaskWorkspaceInspector";
import { TaskWorkspaceUsage } from "../task-workspace/inspector/TaskWorkspaceUsage";
import {
  taskWorkspaceInspectorLabels,
  taskWorkspaceLabels,
  taskWorkspaceTimelineLabels,
  taskWorkspaceUsageLabels
} from "../task-workspace/labels";
import { TaskWorkspaceTimeline } from "../task-workspace/timeline";
import { isWorkspaceTaskWorkspaceNavigation } from "../taskWorkspaceNavigation";

export function TaskWorkspaceAppRoute() {
  const { shell, taskWorkspace } = useProjectWorkspace();
  const navigation = taskWorkspace.navigation;
  const localNavigation =
    navigation && !isWorkspaceTaskWorkspaceNavigation(navigation) ? navigation : null;
  const localCanvasRef = localNavigation
    ? { canvasId: localNavigation.canvasId, projectRoot: localNavigation.projectRoot }
    : null;
  const repositoryRoot =
    shell.selectedProject?.sourceRoot ??
    (shell.selectedProject?.kind === "external" ? shell.selectedProject.rootPath : null);
  const assigneeChip = useMemo(() => {
    const index = shell.assigneeIndex;
    if (!index || !navigation) return null;
    if (navigation.blockRef) {
      return lookupBlockAssigneeChip(index, navigation.canvasId, navigation.blockRef);
    }
    return lookupTaskAssigneeChip(index, navigation.canvasId, navigation.taskId);
  }, [navigation, shell.assigneeIndex]);
  return (
    <TaskWorkspaceCancelRunControllerScope
      api={bridge}
      canvasRef={localCanvasRef}
      model={taskWorkspace.runnerModel}
      selectedRun={taskWorkspace.selectedRun}
    >
      {(cancelController) => {
        const slots = navigation
          ? {
              composer: (props: TaskWorkspaceComposerSlotProps) => (
                <TaskWorkspaceComposer
                  {...props}
                  accessory={
                    <TaskWorkspaceUsage
                      labels={taskWorkspaceUsageLabels(shell.t)}
                      remoteTelemetry={props.remoteConversation?.telemetry}
                      selectedRun={props.selectedRun}
                      workspace={props.workspace}
                    />
                  }
                  api={bridge}
                  canvasRef={localCanvasRef}
                  cancelController={cancelController}
                  t={shell.t}
                />
              ),
              conversation: (props: TaskWorkspaceConversationSlotProps) => (
                <TaskWorkspaceConversation
                  {...props}
                  api={bridge}
                  canvasRef={localCanvasRef}
                  t={shell.t}
                />
              ),
              headerAction: () => (
                <TaskWorkspaceRepositoryActions
                  api={bridge}
                  labels={{
                    repositoryActions: shell.t("repositoryActions")
                  }}
                  onError={shell.setError}
                  repositoryRoot={repositoryRoot}
                />
              ),
              inspector: (props: TaskWorkspaceInspectorSlotProps) => (
                <TaskWorkspaceInspector
                  {...props}
                  remoteTelemetry={taskWorkspace.remoteConversation?.telemetry}
                  labels={taskWorkspaceInspectorLabels(shell.t)}
                />
              ),
              timeline: (props: TaskWorkspaceTimelineSlotProps) => (
                <TaskWorkspaceTimeline {...props} labels={taskWorkspaceTimelineLabels(shell.t)} />
              )
            }
          : undefined;
        return (
          <TaskWorkspaceRoute
            assigneeChip={assigneeChip}
            assigneeLabel={shell.t("assignee")}
            controller={taskWorkspace}
            labels={taskWorkspaceLabels(shell.t)}
            slots={slots}
          />
        );
      }}
    </TaskWorkspaceCancelRunControllerScope>
  );
}
