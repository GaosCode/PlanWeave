import { useCallback } from "react";
import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { WorkspaceCanvasCommandsResult } from "../hooks/useWorkspaceCanvasCommands";
import {
  isWorkspaceTaskWorkspaceNavigation,
  type TaskWorkspaceNavigationIdentity
} from "../taskWorkspaceNavigation";

type TaskWorkspaceExecutorApi = Pick<
  DesktopBridgeApi,
  "getBlockDetail" | "getTaskDetail" | "updateBlockExecutor" | "updateTaskExecutor"
>;

function graphEditError(
  result: Awaited<ReturnType<DesktopBridgeApi["updateTaskExecutor"]>>
): string {
  return (
    result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ||
    "The executor could not be saved."
  );
}

export function useTaskWorkspaceExecutorActions(options: {
  api: TaskWorkspaceExecutorApi | null | undefined;
  navigation: TaskWorkspaceNavigationIdentity | null;
  onSaved: () => void;
  workspaceCanvas?: WorkspaceCanvasCommandsResult | null;
}): {
  saveBlockExecutor: (blockRef: string, executorName: string | null) => Promise<void>;
  saveTaskExecutor: (executorName: string | null) => Promise<void>;
} {
  const { api, navigation, onSaved, workspaceCanvas = null } = options;

  const saveTaskExecutor = useCallback(
    async (executorName: string | null) => {
      if (!api || !navigation) {
        throw new Error(
          "Cannot save a Task executor without a Task Workspace bridge and identity."
        );
      }
      const localNavigation = isWorkspaceTaskWorkspaceNavigation(navigation) ? null : navigation;
      const canvasRef = localNavigation
        ? { projectRoot: localNavigation.projectRoot, canvasId: localNavigation.canvasId }
        : null;
      const current = canvasRef ? await api.getTaskDetail(canvasRef, navigation.taskId) : null;
      if (current && current.taskId !== navigation.taskId) {
        throw new Error("The loaded Task does not match this Task Workspace.");
      }
      let sharedError: string | null = null;
      const mode = await runDurablePackageWrite({
        workspaceCanvas,
        intent: {
          kind: "update_task_fields",
          taskId: navigation.taskId,
          fields: { executor: executorName }
        },
        onError: (message) => {
          sharedError = message;
        },
        localWrite: async () => {
          if (!canvasRef) {
            throw new Error("The local Task executor authority is unavailable.");
          }
          const result = await api.updateTaskExecutor(canvasRef, navigation.taskId, executorName);
          if (!result.ok) {
            throw new Error(graphEditError(result));
          }
        }
      });
      if (mode === "failed") {
        throw new Error(sharedError ?? "Shared canvas command failed.");
      }
      onSaved();
    },
    [api, navigation, onSaved, workspaceCanvas]
  );

  const saveBlockExecutor = useCallback(
    async (blockRef: string, executorName: string | null) => {
      if (!api || !navigation) {
        throw new Error(
          "Cannot save a Block executor without a Task Workspace bridge and identity."
        );
      }
      const localNavigation = isWorkspaceTaskWorkspaceNavigation(navigation) ? null : navigation;
      const canvasRef = localNavigation
        ? { projectRoot: localNavigation.projectRoot, canvasId: localNavigation.canvasId }
        : null;
      const current = canvasRef ? await api.getBlockDetail(canvasRef, blockRef) : null;
      if (current && (current.ref !== blockRef || current.taskId !== navigation.taskId)) {
        throw new Error("The loaded Block does not belong to this Task Workspace.");
      }
      let sharedError: string | null = null;
      const mode = await runDurablePackageWrite({
        workspaceCanvas,
        intent: {
          kind: "update_block_fields",
          blockRef,
          fields: { executor: executorName }
        },
        onError: (message) => {
          sharedError = message;
        },
        localWrite: async () => {
          if (!canvasRef) {
            throw new Error("The local Block executor authority is unavailable.");
          }
          const result = await api.updateBlockExecutor(canvasRef, blockRef, executorName);
          if (!result.ok) {
            throw new Error(graphEditError(result));
          }
        }
      });
      if (mode === "failed") {
        throw new Error(sharedError ?? "Shared canvas command failed.");
      }
      onSaved();
    },
    [api, navigation, onSaved, workspaceCanvas]
  );

  return { saveBlockExecutor, saveTaskExecutor };
}
