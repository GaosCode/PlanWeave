import { bridge } from "../bridge";
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

export function TaskWorkspaceAppRoute() {
  const { shell, taskWorkspace } = useProjectWorkspace();
  const navigation = taskWorkspace.navigation;
  const repositoryRoot =
    shell.selectedProject?.sourceRoot ??
    (shell.selectedProject?.kind === "external" ? shell.selectedProject.rootPath : null);
  return (
    <TaskWorkspaceCancelRunControllerScope
      api={bridge}
      canvasRef={
        navigation ? { canvasId: navigation.canvasId, projectRoot: navigation.projectRoot } : null
      }
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
                      selectedRun={props.selectedRun}
                      workspace={props.workspace}
                    />
                  }
                  api={bridge}
                  canvasRef={{
                    canvasId: navigation.canvasId,
                    projectRoot: navigation.projectRoot
                  }}
                  cancelController={cancelController}
                  t={shell.t}
                />
              ),
              conversation: (props: TaskWorkspaceConversationSlotProps) => (
                <TaskWorkspaceConversation
                  {...props}
                  api={bridge}
                  canvasRef={{ canvasId: navigation.canvasId, projectRoot: navigation.projectRoot }}
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
                <TaskWorkspaceInspector {...props} labels={taskWorkspaceInspectorLabels(shell.t)} />
              ),
              timeline: (props: TaskWorkspaceTimelineSlotProps) => (
                <TaskWorkspaceTimeline {...props} labels={taskWorkspaceTimelineLabels(shell.t)} />
              )
            }
          : undefined;
        return (
          <TaskWorkspaceRoute
            controller={taskWorkspace}
            labels={taskWorkspaceLabels(shell.t)}
            slots={slots}
          />
        );
      }}
    </TaskWorkspaceCancelRunControllerScope>
  );
}
