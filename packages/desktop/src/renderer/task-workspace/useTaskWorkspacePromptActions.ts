import { useCallback } from "react";
import {
  useTaskWorkspacePromptDrafts,
  type TaskWorkspacePromptAuthority
} from "./useTaskWorkspacePromptDrafts";
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
  authority: TaskWorkspacePromptAuthority;
  navigation: TaskWorkspaceNavigationIdentity | null;
  onLocalSaved: () => void;
  workspace: TaskWorkspace | null;
  workspaceCanvas?: WorkspaceCanvasCommandsResult | null;
}): Pick<TaskWorkspaceController, "saveBlockPrompt" | "saveTaskPrompt" | "getPromptDraft"> {
  const { api, navigation, onLocalSaved, workspace, workspaceCanvas = null } = options;
  const { confirmProjection, getProjection, getPromptDraft, getWriteContext } =
    useTaskWorkspacePromptDrafts({
      authority: options.authority,
      navigation,
      workspaceCanvas
    });
  const localNavigation =
    navigation && !isWorkspaceTaskWorkspaceNavigation(navigation) ? navigation : null;
  const localCanvasRef = localNavigation
    ? { projectRoot: localNavigation.projectRoot, canvasId: localNavigation.canvasId }
    : null;

  const saveTaskPrompt = useCallback<TaskWorkspaceController["saveTaskPrompt"]>(
    async ({ baseMarkdown, markdown }) => {
      const context = getWriteContext();
      if (!context) return "retired";
      const workspaceCanvas = context.workspaceCanvas;
      if (!api || !navigation || !workspace) {
        throw new Error("Cannot save a Task prompt without a Task Workspace bridge and identity.");
      }
      const sharedProjection = workspaceCanvas?.enabled ? getProjection() : null;
      const sharedPrompt = workspaceCanvas?.enabled
        ? sharedTaskPromptMarkdown(sharedProjection, workspace, navigation.taskId)
        : null;
      const current = workspaceCanvas?.enabled
        ? null
        : localCanvasRef
          ? await api.getTaskDetail(localCanvasRef, navigation.taskId)
          : null;
      if (!getWriteContext()) return "retired";
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
        onSharedSaved: (projection) => {
          if (
            !projection ||
            sharedTaskPromptMarkdown(projection, workspace, navigation.taskId) !== markdown
          ) {
            throw new Error("The shared Task prompt changed before its save was confirmed.");
          }
          confirmProjection(projection);
        },
        intent: {
          kind: "update_task_prompt",
          taskId: navigation.taskId,
          promptMarkdown: markdown,
          baseContentDigest: sharedProjection?.contentDigest
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
      if (mode === "retired") return "retired";
      if (mode === "failed") throw new Error(sharedError ?? "Shared canvas command failed.");
      if (mode === "local" && getWriteContext()) onLocalSaved();
      return "saved";
    },
    [
      api,
      confirmProjection,
      getProjection,
      getWriteContext,
      localCanvasRef,
      navigation,
      onLocalSaved,
      workspace
    ]
  );

  const saveBlockPrompt = useCallback<TaskWorkspaceController["saveBlockPrompt"]>(
    async (blockRef, { baseMarkdown, markdown }) => {
      const context = getWriteContext();
      if (!context) return "retired";
      const workspaceCanvas = context.workspaceCanvas;
      if (!api || !navigation || !workspace) {
        throw new Error("Cannot save a Block prompt without a Task Workspace bridge and identity.");
      }
      const sharedProjection = workspaceCanvas?.enabled ? getProjection() : null;
      const sharedPrompt = workspaceCanvas?.enabled
        ? sharedBlockPromptMarkdown(sharedProjection, workspace, blockRef)
        : null;
      const current = workspaceCanvas?.enabled
        ? null
        : localCanvasRef
          ? await api.getBlockDetail(localCanvasRef, blockRef)
          : null;
      if (!getWriteContext()) return "retired";
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
        onSharedSaved: (projection) => {
          if (
            !projection ||
            sharedBlockPromptMarkdown(projection, workspace, blockRef) !== markdown
          ) {
            throw new Error("The shared Block prompt changed before its save was confirmed.");
          }
          confirmProjection(projection);
        },
        intent: {
          kind: "update_block_prompt",
          blockRef,
          promptMarkdown: markdown,
          baseContentDigest: sharedProjection?.contentDigest
        },
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
      if (mode === "retired") return "retired";
      if (mode === "failed") throw new Error(sharedError ?? "Shared canvas command failed.");
      if (mode === "local" && getWriteContext()) onLocalSaved();
      return "saved";
    },
    [
      api,
      confirmProjection,
      getProjection,
      getWriteContext,
      localCanvasRef,
      navigation,
      onLocalSaved,
      workspace
    ]
  );

  return { getPromptDraft, saveBlockPrompt, saveTaskPrompt };
}
