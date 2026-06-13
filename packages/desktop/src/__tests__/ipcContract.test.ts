import type { GraphEditResult } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { cloneableGraphEditResult } from "../main/runtimeBridgeResult";
import { desktopBridgeInvokeChannels, packageFileChangedChannel, type DesktopBridgeInvokeMethod } from "../shared/ipcChannels";

const expectedBridgeInvokeMethods = [
  "addBlock",
  "addDependencyEdge",
  "addTaskNode",
  "chooseProjectFolder",
  "createPackageFileSnapshot",
  "createTaskCanvas",
  "createTaskDraft",
  "detectAgentTools",
  "detectPackageFileChanges",
  "detectRuntimeTools",
  "getAutoRunState",
  "getBlockDetail",
  "getCanvasGraphViewModel",
  "getCanvasMapLayout",
  "getDesktopLayout",
  "getDirtyPromptRefs",
  "getFeedbackRecords",
  "getGraphViewModel",
  "getLatestAutoRunSummary",
  "getProjectExecutionPlan",
  "getProjectOverview",
  "getReviewAttempts",
  "getReviewPipeline",
  "getRunRecord",
  "getStatistics",
  "getTaskDetail",
  "getTaskExecutionOrder",
  "getTodoGroups",
  "initOrOpenProject",
  "listBlockRunRecords",
  "listProjects",
  "openBlockInspectorWindow",
  "openTaskInspectorWindow",
  "openProject",
  "pauseAutoRun",
  "refreshChangedPackagePrompts",
  "refreshPackageFileChanges",
  "readProjectPrompt",
  "readProjectPromptPolicy",
  "removeBlock",
  "removeDependencyEdge",
  "removeProject",
  "removeTaskCanvas",
  "removeTaskNode",
  "resetDesktopLayout",
  "resetCanvasMapLayout",
  "resumeAutoRun",
  "revealPathInFinder",
  "revealProjectInFinder",
  "saveCanvasMapLayout",
  "saveDesktopLayout",
  "searchProject",
  "startAutoRun",
  "stopAutoRun",
  "unblockBlock",
  "unwatchPackageFiles",
  "updateBlockExecutor",
  "updateBlockPrompt",
  "updateBlockTitle",
  "updateProjectPrompt",
  "updateReviewPipeline",
  "updateProjectPromptPolicy",
  "updateTaskExecutor",
  "updateTaskPrompt",
  "updateTaskTitle",
  "validateGraphEdit",
  "watchPackageFiles"
] satisfies DesktopBridgeInvokeMethod[];

describe("desktop IPC contract", () => {
  it("keeps every bridge invoke method in the shared channel registry", () => {
    const registryMethods = Object.keys(desktopBridgeInvokeChannels).sort();

    expect(registryMethods).toEqual([...expectedBridgeInvokeMethods].sort());
    expect(new Set(Object.values(desktopBridgeInvokeChannels)).size).toBe(Object.values(desktopBridgeInvokeChannels).length);
  });

  it("keeps package file change events outside the invoke channel registry", () => {
    expect(packageFileChangedChannel).toBe("planweave:packageFileChanged");
    expect(Object.values(desktopBridgeInvokeChannels)).not.toContain(packageFileChangedChannel);
  });

  it("uses the desktop canvas reference channel for canvas-scoped bridge calls", () => {
    expect(desktopBridgeInvokeChannels.getGraphViewModel).toBe("planweave:getGraphViewModel");
    expect(desktopBridgeInvokeChannels.getCanvasGraphViewModel).toBe("planweave:getCanvasGraphViewModel");
    expect(desktopBridgeInvokeChannels.getCanvasMapLayout).toBe("planweave:getCanvasMapLayout");
    expect(desktopBridgeInvokeChannels.getDesktopLayout).toBe("planweave:getDesktopLayout");
    expect(desktopBridgeInvokeChannels.watchPackageFiles).toBe("planweave:watchPackageFiles");
    expect(desktopBridgeInvokeChannels.getTodoGroups).toBe("planweave:getTodoGroups");
  });

  it("strips compiled graph internals from graph edit IPC results", () => {
    const result: GraphEditResult = {
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: [],
      graph: { indexes: "not cloneable over IPC" } as never
    };

    expect(cloneableGraphEditResult(result)).toEqual({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: []
    });
  });
});
