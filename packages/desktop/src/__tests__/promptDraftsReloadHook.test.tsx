/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type { DesktopGraphEditResult, DesktopTaskDetail } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { layout, project } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

import type { WorkspaceCanvasCommandsResult } from "../renderer/hooks/useWorkspaceCanvasCommands";
import { collaborationCanvasReplicaProjectionSchema } from "../shared/canvasReplicaIpc";

afterEach(cleanupRendererTestEnvironment);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const remoteTask: DesktopTaskDetail = {
  taskId: "T-ALPHA",
  title: "Alpha task",
  status: "ready",
  executor: null,
  promptMarkdown: "new remote",
  graphVersion: "remote-version",
  promptHash: "remote-hash",
  promptMissing: false,
  acceptance: [],
  blockOrder: []
};
const conflictResult: DesktopGraphEditResult = {
  ok: false,
  affectedTasks: [],
  diagnostics: [{ code: "graph_version_conflict", message: "changed externally" }]
};

function sharedAuthority(): WorkspaceCanvasCommandsResult {
  return {
    enabled: true,
    snapshot: {
      session: null,
      connectionPhase: "connected",
      lastError: null,
      lastStaleConflict: null,
      busy: false
    },
    projection: collaborationCanvasReplicaProjectionSchema.parse({
      authorityId: "shared-authority",
      localProjectId: project.projectId,
      localCanvasId: "canvas-main",
      workspaceId: "workspace-1",
      projectId: "remote-project",
      canvasId: "remote-canvas",
      revision: 2,
      contentDigest: "a".repeat(64),
      canEdit: true,
      optimisticOperationIds: [],
      rejections: [],
      content: {
        projectTitle: graph.projectTitle,
        graphVersion: "remote-version",
        packageFingerprint: `pkg-${"a".repeat(64)}`,
        tasks: graph.tasks.map((task) => ({
          ...task,
          promptMissing: false,
          ...(task.taskId === "T-ALPHA"
            ? { promptMarkdown: "new remote", promptHash: "remote-hash" }
            : {})
        })),
        edges: [],
        sharedResourceGroups: [],
        diagnostics: [],
        layout: { ...layout, projectId: project.projectId },
        blockDependenciesByRef: {},
        taskOpenFeedbackCountByTaskId: {},
        blockPromptMarkdownByRef: {}
      }
    }),
    projectionStatus: null,
    initialRuntimeAvailability: null,
    offline: false,
    submit: vi
      .fn()
      .mockResolvedValue({ status: "completed", ok: true, error: null, staleConflict: null }),
    reconnect: vi.fn().mockResolvedValue(true)
  };
}

async function conflictedHook(workspaceCanvas: WorkspaceCanvasCommandsResult | null = null) {
  const read = vi.fn().mockResolvedValue(remoteTask);
  const write = vi.fn().mockResolvedValue(conflictResult);
  const bridge = createDesktopBridgeMock({ getTaskDetail: read, updateTaskPrompt: write });
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
  const refreshGraph = vi.fn().mockResolvedValue(undefined);
  const setError = vi.fn();
  const initialProps = { currentGraph: graph, canvasId: "canvas-main", selectedProject: project };
  const hook = renderHook(
    ({ currentGraph, canvasId, selectedProject }) =>
      usePromptDrafts({
        graph: currentGraph,
        selectedCanvasId: canvasId,
        selectedProject,
        refreshGraph,
        setError,
        workspaceCanvas
      }),
    { initialProps }
  );
  act(() => hook.result.current.handlePromptChange("T-ALPHA", "local draft"));
  if (workspaceCanvas) {
    act(() =>
      hook.rerender({
        ...initialProps,
        currentGraph: {
          ...graph,
          graphVersion: "remote-version",
          tasks: graph.tasks.map((task) =>
            task.taskId === "T-ALPHA"
              ? { ...task, promptMarkdown: "new remote", promptHash: "remote-hash" }
              : task
          )
        }
      })
    );
  } else {
    await act(async () => {
      await hook.result.current.handlePromptSave("T-ALPHA");
    });
  }
  expect(hook.result.current.promptConflicts[0]?.remote).toBe("new remote");
  setError.mockClear();
  return { ...hook, read, write, refreshGraph, setError, initialProps };
}

describe("Task Prompt conflict reload", () => {
  it("reloads authoritative typed detail while graph props still contain the old prompt", async () => {
    const hook = await conflictedHook();
    await act(async () => {
      await hook.result.current.reloadPromptConflicts();
    });
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("new remote");
    expect(hook.result.current.promptConflicts).toEqual([]);
    hook.write.mockResolvedValue({ ok: true, affectedTasks: ["T-ALPHA"], diagnostics: [] });
    hook.read.mockResolvedValue({ ...remoteTask, promptMarkdown: "next edit" });
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "next edit"));
    await act(async () => {
      await hook.result.current.handlePromptSave("T-ALPHA");
    });
    expect(hook.write).toHaveBeenLastCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "next edit",
      { baseGraphVersion: "remote-version", basePromptHash: "remote-hash" }
    );
  });

  it.each([
    "read",
    "refresh"
  ])("preserves the local draft and conflict when reload %s fails", async (failure) => {
    const hook = await conflictedHook();
    const conflict = hook.result.current.promptConflicts[0];
    if (failure === "read") hook.read.mockRejectedValueOnce(new Error("reload read failed"));
    else hook.refreshGraph.mockRejectedValueOnce(new Error("reload refresh failed"));
    await act(async () => {
      await hook.result.current.reloadPromptConflicts();
    });
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("local draft");
    expect(hook.result.current.promptConflicts).toEqual([conflict]);
    expect(hook.setError).toHaveBeenCalledWith(`reload ${failure} failed`);
    expect(hook.write).toHaveBeenCalledTimes(1);
  });

  it("retains the pending reload draft and does not overwrite input made during its read", async () => {
    const hook = await conflictedHook();
    const readback = deferred<DesktopTaskDetail>();
    hook.read.mockReturnValueOnce(readback.promise);
    let reloading!: Promise<void>;
    await act(async () => {
      reloading = hook.result.current.reloadPromptConflicts();
      await Promise.resolve();
    });
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("local draft");
    expect(hook.result.current.promptConflicts[0]?.remote).toBe("new remote");
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "edited during reload"));
    await act(async () => {
      readback.resolve(remoteTask);
      await reloading;
    });
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("edited during reload");
    expect(hook.result.current.promptConflicts[0]?.draft).toBe("edited during reload");
  });

  it.each([
    "resolve",
    "reject"
  ])("ignores a reload read %s after its canvas scope changes", async (outcome) => {
    const hook = await conflictedHook();
    const readback = deferred<DesktopTaskDetail>();
    hook.read.mockReturnValueOnce(readback.promise);
    let reloading!: Promise<void>;
    await act(async () => {
      reloading = hook.result.current.reloadPromptConflicts();
      await Promise.resolve();
    });
    act(() =>
      hook.rerender({
        ...hook.initialProps,
        canvasId: "replacement-canvas",
        currentGraph: {
          ...graph,
          tasks: graph.tasks.map((task) =>
            task.taskId === "T-ALPHA" ? { ...task, promptMarkdown: "replacement" } : task
          )
        }
      })
    );
    await act(async () => {
      if (outcome === "resolve") readback.resolve(remoteTask);
      else readback.reject(new Error("old reload read failed"));
      await reloading;
    });
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("replacement");
    expect(hook.result.current.promptConflicts).toEqual([]);
    expect(hook.result.current.saveStates["T-ALPHA"]).toBe("idle");
    expect(hook.setError).not.toHaveBeenCalled();
  });

  it.each([
    "success",
    "refresh failure",
    "unavailable",
    "wrong binding"
  ])("uses only shared projection for reload (%s)", async (outcome) => {
    const workspaceCanvas = sharedAuthority();
    const hook = await conflictedHook(workspaceCanvas);
    if (outcome === "refresh failure")
      hook.refreshGraph.mockRejectedValueOnce(new Error("refresh failed"));
    if (outcome === "unavailable") workspaceCanvas.projection = null;
    if (
      outcome === "wrong binding" &&
      workspaceCanvas.projection &&
      !("bindingKind" in workspaceCanvas.projection)
    ) {
      workspaceCanvas.projection = { ...workspaceCanvas.projection, localCanvasId: "other-canvas" };
    }
    await act(async () => {
      await hook.result.current.reloadPromptConflicts();
    });
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe(
      outcome === "success" ? "new remote" : "local draft"
    );
    expect(hook.result.current.promptConflicts.length).toBe(outcome === "success" ? 0 : 1);
    expect(hook.setError.mock.calls.length).toBe(outcome === "success" ? 0 : 1);
    expect(hook.read).not.toHaveBeenCalled();
    expect(hook.write).not.toHaveBeenCalled();
    expect(workspaceCanvas.submit).not.toHaveBeenCalled();
  });
});
