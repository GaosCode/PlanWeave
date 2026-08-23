import { useCallback } from "react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { WorkspaceCanvasCommandsResult } from "./useWorkspaceCanvasCommands";

type UseTaskExecutorActionsArgs = {
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  /** When enabled, task executor writes go through Workspace Canvas commands. */
  workspaceCanvas?: WorkspaceCanvasCommandsResult | null;
};

export function useTaskExecutorActions({
  refreshGraph,
  selectedCanvasId,
  selectedProject,
  setError,
  workspaceCanvas = null
}: UseTaskExecutorActionsArgs) {
  const handleTaskExecutorChange = useCallback(
    async (taskId: string, executorName: string | null) => {
      if (!selectedProject && !workspaceCanvas?.enabled) {
        return false;
      }
      try {
        const mode = await runDurablePackageWrite({
          workspaceCanvas,
          intent: {
            kind: "update_task_fields",
            taskId,
            fields: { executor: executorName }
          },
          onError: setError,
          localWrite: async () => {
            if (!bridge || !selectedProject) return;
            const result = await bridge.updateTaskExecutor(
              desktopCanvasReference(selectedProject, selectedCanvasId),
              taskId,
              executorName
            );
            if (!result.ok) {
              throw new Error(
                result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")
              );
            }
          }
        });
        if (mode === "failed") return false;
        await refreshGraph();
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      }
    },
    [refreshGraph, selectedCanvasId, selectedProject, setError, workspaceCanvas]
  );

  return { handleTaskExecutorChange };
}
