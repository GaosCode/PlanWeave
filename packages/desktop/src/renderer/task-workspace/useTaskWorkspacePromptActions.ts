import { useCallback } from "react";
import type { DesktopBridgeApi, TaskWorkspace } from "@planweave-ai/runtime";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { WorkspaceCanvasCommandsResult } from "../hooks/useWorkspaceCanvasCommands";
import {
  isWorkspaceTaskWorkspaceNavigation,
  type TaskWorkspaceNavigationIdentity
} from "../taskWorkspaceNavigation";
import type { TaskWorkspaceController } from "./contracts";
import {
  sharedBlockPromptMarkdown,
  sharedTaskPromptMarkdown
} from "./taskWorkspaceSharedProjection";

type TaskWorkspacePromptApi = Pick<
  DesktopBridgeApi,
  "getBlockDetail" | "getTaskDetail" | "updateBlockPrompt" | "updateTaskPrompt"
>;

function graphEditError(result: Awaited<ReturnType<DesktopBridgeApi["updateTaskPrompt"]>>): string {
  return (
    result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ||
    "The graph edit could not be saved."
  );
}

export function useTaskWorkspacePromptActions(options: {
  api: TaskWorkspacePromptApi | null | undefined;
  navigation: TaskWorkspaceNavigationIdentity | null;
  onLocalSaved: () => void;
  workspace: TaskWorkspace | null;
  workspaceCanvas?: WorkspaceCanvasCommandsResult | null;
}): Pick<TaskWorkspaceController, "saveBlockPrompt" | "saveTaskPrompt"> {
  const { api, navigation, onLocalSaved, workspace, workspaceCanvas = null } = options;
  const localNavigation =
    navigation && !isWorkspaceTaskWorkspaceNavigation(navigation) ? navigation : null;
  const localCanvasRef = localNavigation
    ? { projectRoot: localNavigation.projectRoot, canvasId: localNavigation.canvasId }
    : null;

  const saveTaskPrompt = useCallback<TaskWorkspaceController["saveTaskPrompt"]>(
    async ({ baseMarkdown, markdown }) => {
      if (!api || !navigation || !workspace) {
        throw new Error("Cannot save a Task prompt without a Task Workspace bridge and identity.");
      }
      const sharedPrompt = workspaceCanvas?.enabled
        ? sharedTaskPromptMarkdown(workspaceCanvas.projection, workspace, navigation.taskId)
        : null;
      const current = workspaceCanvas?.enabled
        ? null
        : localCanvasRef
          ? await api.getTaskDetail(localCanvasRef, navigation.taskId)
          : null;
      if (workspaceCanvas?.enabled && sharedPrompt === null) {
        throw new Error("The shared Task prompt authority is unavailable.");
      }
      if (current && current.taskId !== navigation.taskId) {
        throw new Error("The loaded Task prompt does not match this Task Workspace.");
      }
      if ((sharedPrompt ?? current?.promptMarkdown) !== baseMarkdown) {
        throw new Error(
          "The Task prompt changed outside this editor. Reload the page and merge your changes before saving."
        );
      }
      if (current && (current.graphVersion === undefined || current.promptHash === undefined)) {
        throw new Error(
          "The Task prompt cannot be saved safely because its revision is unavailable."
        );
      }
      let sharedError: string | null = null;
      const mode = await runDurablePackageWrite({
        workspaceCanvas,
        intent: {
          kind: "update_task_prompt",
          taskId: navigation.taskId,
          promptMarkdown: markdown
        },
        onError: (message) => {
          sharedError = message;
        },
        localWrite: async () => {
          if (!current || !localCanvasRef) {
            throw new Error("The local Task prompt revision is unavailable.");
          }
          const result = await api.updateTaskPrompt(localCanvasRef, navigation.taskId, markdown, {
            baseGraphVersion: current.graphVersion,
            basePromptHash: current.promptHash
          });
          if (!result.ok) throw new Error(graphEditError(result));
        }
      });
      if (mode === "failed") throw new Error(sharedError ?? "Shared canvas command failed.");
      if (mode === "local") onLocalSaved();
    },
    [api, localCanvasRef, navigation, onLocalSaved, workspace, workspaceCanvas]
  );

  const saveBlockPrompt = useCallback<TaskWorkspaceController["saveBlockPrompt"]>(
    async (blockRef, { baseMarkdown, markdown }) => {
      if (!api || !navigation || !workspace) {
        throw new Error("Cannot save a Block prompt without a Task Workspace bridge and identity.");
      }
      const sharedPrompt = workspaceCanvas?.enabled
        ? sharedBlockPromptMarkdown(workspaceCanvas.projection, workspace, blockRef)
        : null;
      const current = workspaceCanvas?.enabled
        ? null
        : localCanvasRef
          ? await api.getBlockDetail(localCanvasRef, blockRef)
          : null;
      if (workspaceCanvas?.enabled && sharedPrompt === null) {
        throw new Error("The shared Block prompt authority is unavailable.");
      }
      if (current && (current.ref !== blockRef || current.taskId !== navigation.taskId)) {
        throw new Error("The loaded Block prompt does not belong to this Task Workspace.");
      }
      if ((sharedPrompt ?? current?.promptMarkdown) !== baseMarkdown) {
        throw new Error(
          "The Block prompt changed outside this editor. Reload the page and merge your changes before saving."
        );
      }
      if (current && (current.graphVersion === undefined || current.promptHash === undefined)) {
        throw new Error(
          "The Block prompt cannot be saved safely because its revision is unavailable."
        );
      }
      let sharedError: string | null = null;
      const mode = await runDurablePackageWrite({
        workspaceCanvas,
        intent: { kind: "update_block_prompt", blockRef, promptMarkdown: markdown },
        onError: (message) => {
          sharedError = message;
        },
        localWrite: async () => {
          if (!current || !localCanvasRef) {
            throw new Error("The local Block prompt revision is unavailable.");
          }
          const result = await api.updateBlockPrompt(localCanvasRef, blockRef, markdown, {
            baseGraphVersion: current.graphVersion,
            basePromptHash: current.promptHash
          });
          if (!result.ok) throw new Error(graphEditError(result));
        }
      });
      if (mode === "failed") throw new Error(sharedError ?? "Shared canvas command failed.");
      if (mode === "local") onLocalSaved();
    },
    [api, localCanvasRef, navigation, onLocalSaved, workspace, workspaceCanvas]
  );

  return { saveBlockPrompt, saveTaskPrompt };
}
