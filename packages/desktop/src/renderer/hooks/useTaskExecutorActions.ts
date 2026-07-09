import { useCallback } from "react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";

type UseTaskExecutorActionsArgs = {
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
};

export function useTaskExecutorActions({
  refreshGraph,
  selectedCanvasId,
  selectedProject,
  setError
}: UseTaskExecutorActionsArgs) {
  const handleTaskExecutorChange = useCallback(
    async (taskId: string, executorName: string | null) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        const result = await bridge.updateTaskExecutor(
          desktopCanvasReference(selectedProject, selectedCanvasId),
          taskId,
          executorName
        );
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedCanvasId, selectedProject, setError]
  );

  return { handleTaskExecutorChange };
}
