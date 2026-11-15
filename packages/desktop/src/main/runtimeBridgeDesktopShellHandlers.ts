import {
  getTaskFileManagerPath,
  probeDesktopAgentCapabilities,
  resolveRunRecordArtifactPath,
  resolveTaskCanvasWorkspace,
  testExecutorProfile
} from "@planweave-ai/runtime";
import { BrowserWindow, dialog, shell, type OpenDialogOptions } from "electron";
import { detectAgentTools, detectWslEnvironment } from "./agentTools.js";
import { DesktopSettingsStore } from "./desktopSettingsStore.js";
import { openBlockInspectorWindow } from "./blockInspectorWindow.js";
import {
  detectDevelopmentTools,
  isDesktopDevelopmentToolId,
  openProjectInDevelopmentTool
} from "./codeEditors.js";
import { openTaskInspectorWindow } from "./taskInspectorWindow.js";
import { resolveDesktopCanvasReference } from "./runtimeBridgeCanvasReference.js";
import type { RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";
import { detectRuntimeTools } from "./runtimeTools.js";

export const runtimeBridgeDesktopShellHandlers = {
  chooseProjectFolder: async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  },
  chooseSourceRootFolder: async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory"] };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  },
  openProjectInDevelopmentTool: async (_event, rootPath, toolId) => {
    if (!isDesktopDevelopmentToolId(toolId)) {
      throw new Error("Development tool id is invalid.");
    }
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    await openProjectInDevelopmentTool(rootPath, toolId);
  },
  revealProjectInFinder: async (_event, rootPath) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    await shell.openPath(rootPath);
  },
  revealPathInFinder: (_event, path) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    shell.showItemInFolder(path);
  },
  revealRunnerRecordArtifact: async (_event, ref, recordId, artifact) => {
    const path = await resolveRunRecordArtifactPath(
      await resolveDesktopCanvasReference(ref),
      recordId,
      artifact
    );
    if (process.env.PLANWEAVE_DESKTOP_SMOKE !== "1") shell.showItemInFolder(path);
  },
  revealTaskCanvasInFinder: async (_event, projectRoot, canvasId) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
    await shell.openPath(workspace.workspaceRoot);
  },
  revealTaskInFinder: async (_event, ref, taskId) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    const workspace = await resolveDesktopCanvasReference(ref);
    shell.showItemInFolder(await getTaskFileManagerPath(workspace, taskId));
  },
  detectAgentTools: () => detectAgentTools(),
  detectWslEnvironment: () => detectWslEnvironment(),
  detectRuntimeTools: () => detectRuntimeTools(),
  detectDevelopmentTools: () => detectDevelopmentTools(),
  testExecutorProfile: async (_event, ref, executorName) =>
    testExecutorProfile({ projectRoot: await resolveDesktopCanvasReference(ref), executorName }),
  probeDesktopAgentCapabilities: async (_event, input) => {
    const { execution } = await new DesktopSettingsStore().read();
    return probeDesktopAgentCapabilities(input, { executionHost: execution.agentHost });
  },
  openBlockInspectorWindow: (_event, input) => openBlockInspectorWindow(input),
  openTaskInspectorWindow: (_event, input) => openTaskInspectorWindow(input)
} satisfies Partial<RuntimeBridgeHandlerMap>;
