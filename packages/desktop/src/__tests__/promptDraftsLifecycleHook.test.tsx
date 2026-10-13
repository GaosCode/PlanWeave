/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type {
  DesktopBridgeApi,
  DesktopGraphEditResult,
  DesktopGraphViewModel,
  DesktopTaskDetail
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

import type { WorkspaceCanvasCommandsResult } from "../renderer/hooks/useWorkspaceCanvasCommands";

afterEach(cleanupRendererTestEnvironment);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function promptGraph(markdown: string, version: string): DesktopGraphViewModel {
  return {
    ...graph,
    graphVersion: version,
    tasks: graph.tasks.map((task) =>
      task.taskId === "T-ALPHA"
        ? { ...task, promptMarkdown: markdown, promptHash: `hash-${version}` }
        : task
    )
  };
}

function promptDetail(markdown: string, version: string): DesktopTaskDetail {
  return {
    taskId: "T-ALPHA",
    title: "Alpha task",
    status: "ready",
    executor: null,
    promptMarkdown: markdown,
    promptHash: `hash-${version}`,
    graphVersion: version,
    promptMissing: false,
    acceptance: [],
    blockOrder: []
  };
}

async function promptHarness(
  overrides: Partial<DesktopBridgeApi>,
  workspaceCanvas: WorkspaceCanvasCommandsResult | null = null
) {
  vi.useFakeTimers();
  const bridge = createDesktopBridgeMock(overrides);
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
  const refreshGraph = vi.fn().mockResolvedValue(undefined);
  const setError = vi.fn();
  const initialProps = {
    currentGraph: promptGraph("# Alpha", "before"),
    canvasId: "canvas-main",
    selectedProject: project
  };
  const hook = renderHook(
    ({ currentGraph, canvasId, selectedProject }) =>
      usePromptDrafts({
        graph: currentGraph,
        refreshGraph,
        selectedCanvasId: canvasId,
        selectedProject,
        setError,
        workspaceCanvas
      }),
    { initialProps }
  );
  return { ...hook, bridge, refreshGraph, setError, initialProps };
}

const savedResult: DesktopGraphEditResult = {
  ok: true,
  affectedTasks: ["T-ALPHA"],
  diagnostics: []
};

describe("desktop renderer hook interfaces", () => {
  it.each([
    "receipt",
    "debounce",
    "blur"
  ])("serializes %s writes and saves the latest revision after an older receipt", async (trigger) => {
    vi.useFakeTimers();
    const first = deferred<DesktopGraphEditResult>();
    const latest = deferred<DesktopGraphEditResult>();
    const bridge = createDesktopBridgeMock({
      updateTaskPrompt: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(latest.promise),
      getTaskDetail: vi
        .fn()
        .mockResolvedValueOnce(promptDetail("first", "first"))
        .mockResolvedValueOnce(promptDetail("third", "third"))
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
    const refreshGraph = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ currentGraph }) =>
        usePromptDrafts({
          graph: currentGraph,
          refreshGraph,
          selectedCanvasId: "canvas-main",
          selectedProject: project,
          setError: vi.fn()
        }),
      { initialProps: { currentGraph: promptGraph("# Alpha", "before") } }
    );

    act(() => result.current.handlePromptChange("T-ALPHA", "first"));
    let firstSave!: Promise<void>;
    act(() => {
      firstSave = result.current.handlePromptSave("T-ALPHA");
    });
    act(() => result.current.handlePromptChange("T-ALPHA", "second"));
    act(() => result.current.handlePromptChange("T-ALPHA", "third"));
    if (trigger === "blur")
      act(() => {
        void result.current.handlePromptSave("T-ALPHA");
      });
    if (trigger !== "receipt")
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
    expect(bridge.updateTaskPrompt).toHaveBeenCalledTimes(1);
    expect(result.current.promptDrafts["T-ALPHA"]).toBe("third");

    await act(async () => {
      first.resolve({ ok: true, affectedTasks: ["T-ALPHA"], diagnostics: [] });
      await firstSave;
    });
    expect(result.current.saveStates["T-ALPHA"]).not.toBe("saved");
    expect(result.current.promptDrafts["T-ALPHA"]).toBe("third");
    act(() => rerender({ currentGraph: promptGraph("first", "first") }));
    expect(result.current.promptConflicts).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(bridge.updateTaskPrompt).toHaveBeenCalledTimes(2);
    expect(bridge.updateTaskPrompt).toHaveBeenLastCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "third",
      { baseGraphVersion: "first", basePromptHash: "hash-first" }
    );
    await act(async () => {
      latest.resolve({ ok: true, affectedTasks: ["T-ALPHA"], diagnostics: [] });
    });
    act(() => rerender({ currentGraph: promptGraph("third", "third") }));
    expect(result.current.saveStates["T-ALPHA"]).toBe("saved");
    expect(result.current.promptConflicts).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(bridge.updateTaskPrompt).toHaveBeenCalledTimes(2);
  });

  it("holds the write slot through own watcher readback and the refresh promise", async () => {
    const first = deferred<DesktopGraphEditResult>();
    const refreshed = deferred<void>();
    const hook = await promptHarness({
      updateTaskPrompt: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(savedResult),
      getTaskDetail: vi.fn().mockResolvedValue(promptDetail("first", "first"))
    });
    hook.refreshGraph.mockReturnValueOnce(refreshed.promise);
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "first"));
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.handlePromptSave("T-ALPHA");
    });
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "second"));
    act(() => hook.rerender({ ...hook.initialProps, currentGraph: promptGraph("first", "first") }));
    expect(hook.result.current.promptConflicts).toEqual([]);
    await act(async () => {
      first.resolve(savedResult);
    });
    await act(async () => {
      void hook.result.current.handlePromptSave("T-ALPHA");
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(hook.bridge.updateTaskPrompt).toHaveBeenCalledTimes(1);
    expect(hook.result.current.saveStates["T-ALPHA"]).toBe("saving");
    await act(async () => {
      refreshed.resolve();
      await saving;
    });
    expect(hook.result.current.saveStates["T-ALPHA"]).toBe("idle");
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("second");
  });

  it.each([
    false,
    true
  ])("preserves drafts after write failure and permits retry (new revision: %s)", async (newRevision) => {
    const first = deferred<DesktopGraphEditResult>();
    const hook = await promptHarness({
      updateTaskPrompt: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(savedResult),
      getTaskDetail: vi
        .fn()
        .mockResolvedValue(promptDetail(newRevision ? "second" : "first", "retry"))
    });
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "first"));
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.handlePromptSave("T-ALPHA");
    });
    if (newRevision) act(() => hook.result.current.handlePromptChange("T-ALPHA", "second"));
    await act(async () => {
      first.reject(new Error("write failed"));
      await saving;
    });
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe(newRevision ? "second" : "first");
    expect(hook.result.current.saveStates["T-ALPHA"]).toBe(newRevision ? "idle" : "error");
    expect(hook.setError).toHaveBeenCalledWith("write failed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    if (!newRevision) {
      expect(hook.bridge.updateTaskPrompt).toHaveBeenCalledTimes(1);
      await act(async () => {
        await hook.result.current.handlePromptSave("T-ALPHA");
      });
    }
    expect(hook.bridge.updateTaskPrompt).toHaveBeenCalledTimes(2);
    expect(hook.result.current.saveStates["T-ALPHA"]).toBe("saved");
    expect(hook.result.current.promptConflicts).toEqual([]);
  });

  it.each([
    "canvas",
    "project",
    "deleted",
    "unmounted"
  ] as const)("isolates old resolve/reject and timers after %s invalidation", async (change) => {
    for (const outcome of ["resolve", "reject"] as const) {
      const first = deferred<DesktopGraphEditResult>();
      const hook = await promptHarness({
        updateTaskPrompt: vi.fn().mockReturnValue(first.promise)
      });
      act(() => hook.result.current.handlePromptChange("T-ALPHA", "first"));
      let saving!: Promise<void>;
      act(() => {
        saving = hook.result.current.handlePromptSave("T-ALPHA");
      });
      act(() => hook.result.current.handlePromptChange("T-ALPHA", "old queued draft"));
      const replacement = {
        ...hook.initialProps,
        currentGraph: promptGraph("replacement", "replacement")
      };
      if (change === "canvas") replacement.canvasId = "other-canvas";
      if (change === "project")
        replacement.selectedProject = {
          ...project,
          projectId: "other-project",
          rootPath: "/tmp/other-project"
        };
      if (change === "deleted") {
        act(() =>
          hook.rerender({
            ...hook.initialProps,
            currentGraph: {
              ...graph,
              tasks: graph.tasks.filter((task) => task.taskId !== "T-ALPHA")
            }
          })
        );
        expect(hook.result.current.promptDrafts["T-ALPHA"]).toBeUndefined();
      }
      if (change === "unmounted") hook.unmount();
      else act(() => hook.rerender(replacement));
      await act(async () => {
        if (outcome === "resolve") first.resolve(savedResult);
        else first.reject(new Error("old write failed"));
        await saving;
        await vi.advanceTimersByTimeAsync(1600);
      });
      if (change !== "unmounted") {
        expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("replacement");
        expect(hook.result.current.saveStates["T-ALPHA"]).toBe("idle");
        expect(hook.result.current.promptConflicts).toEqual([]);
      }
      expect(hook.bridge.updateTaskPrompt).toHaveBeenCalledTimes(1);
      expect(hook.bridge.getTaskDetail).not.toHaveBeenCalled();
      expect(hook.setError).not.toHaveBeenCalled();
      expect(hook.refreshGraph).not.toHaveBeenCalled();
      hook.unmount();
    }
  });

  it("cancels an unissued debounce on canvas change", async () => {
    const hook = await promptHarness({ updateTaskPrompt: vi.fn().mockResolvedValue(savedResult) });
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "unsent"));
    act(() =>
      hook.rerender({
        ...hook.initialProps,
        canvasId: "other-canvas",
        currentGraph: promptGraph("other", "other")
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(hook.bridge.updateTaskPrompt).not.toHaveBeenCalled();
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("other");
  });

  it("keeps per-task drafts independent while another task is saving", async () => {
    const first = deferred<DesktopGraphEditResult>();
    const hook = await promptHarness({
      updateTaskPrompt: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(savedResult),
      getTaskDetail: vi
        .fn()
        .mockResolvedValueOnce({ ...promptDetail("beta", "beta"), taskId: "T-BETA" })
        .mockResolvedValueOnce(promptDetail("alpha", "alpha"))
    });
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "alpha"));
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.handlePromptSave("T-ALPHA");
    });
    act(() => hook.result.current.handlePromptChange("T-BETA", "beta"));
    await act(async () => {
      await hook.result.current.handlePromptSave("T-BETA");
    });
    expect(hook.result.current.saveStates).toMatchObject({
      "T-ALPHA": "saving",
      "T-BETA": "saved"
    });
    await act(async () => {
      first.resolve(savedResult);
      await saving;
    });
    expect(hook.result.current.promptDrafts).toMatchObject({
      "T-ALPHA": "alpha",
      "T-BETA": "beta"
    });
    expect(hook.result.current.saveStates).toMatchObject({ "T-ALPHA": "saved", "T-BETA": "saved" });
  });

  it("retains external conflict through edits and through a newer observation during force save", async () => {
    const write = deferred<DesktopGraphEditResult>();
    const hook = await promptHarness({
      updateTaskPrompt: vi.fn().mockReturnValue(write.promise),
      getTaskDetail: vi.fn().mockResolvedValue(promptDetail("new local", "local"))
    });
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "local"));
    act(() =>
      hook.rerender({ ...hook.initialProps, currentGraph: promptGraph("external", "external") })
    );
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "new local"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
      await hook.result.current.handlePromptSave("T-ALPHA");
    });
    expect(hook.bridge.updateTaskPrompt).not.toHaveBeenCalled();
    expect(hook.result.current.promptConflicts[0]?.draft).toBe("new local");
    let applying!: Promise<void>;
    act(() => {
      applying = hook.result.current.applyLocalPromptConflicts();
    });
    act(() =>
      hook.rerender({
        ...hook.initialProps,
        currentGraph: promptGraph("new external", "new-external")
      })
    );
    await act(async () => {
      write.resolve(savedResult);
      await applying;
    });
    expect(hook.result.current.promptConflicts[0]?.remote).toBe("new external");
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("new local");
    expect(hook.result.current.saveStates["T-ALPHA"]).toBe("error");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(hook.bridge.updateTaskPrompt).toHaveBeenCalledTimes(1);
    vi.mocked(hook.bridge.getTaskDetail).mockResolvedValue(
      promptDetail("new external", "new-external")
    );
    await act(async () => {
      await hook.result.current.reloadPromptConflicts();
    });
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("new external");
    expect(hook.result.current.promptConflicts).toEqual([]);
  });

  it.each([
    "read failure",
    "external readback"
  ])("does not report saved for %s", async (failure) => {
    const readback = vi.fn();
    if (failure === "read failure") readback.mockRejectedValue(new Error("read failed"));
    else readback.mockResolvedValue(promptDetail("external", "external"));
    const hook = await promptHarness({
      updateTaskPrompt: vi.fn().mockResolvedValue(savedResult),
      getTaskDetail: readback
    });
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "local"));
    await act(async () => {
      await hook.result.current.handlePromptSave("T-ALPHA");
    });
    expect(hook.result.current.promptDrafts["T-ALPHA"]).toBe("local");
    expect(hook.result.current.saveStates["T-ALPHA"]).toBe("error");
    expect(hook.setError).toHaveBeenCalledTimes(1);
    expect(hook.result.current.promptConflicts.length).toBe(failure === "read failure" ? 0 : 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(hook.bridge.updateTaskPrompt).toHaveBeenCalledTimes(1);
  });

  it.each([
    "draft",
    "force"
  ])("waits for shared %s authority readback and coalesces without local package I/O", async (mode) => {
    const submitted = deferred<{
      status: "completed";
      ok: boolean;
      error: string | null;
      staleConflict: null;
    }>();
    const submit = vi
      .fn()
      .mockReturnValueOnce(submitted.promise)
      .mockResolvedValue({ status: "completed", ok: true, error: null, staleConflict: null });
    const workspaceCanvas: WorkspaceCanvasCommandsResult = {
      enabled: true,
      snapshot: {
        session: null,
        connectionPhase: "connected",
        lastError: null,
        lastStaleConflict: null,
        busy: false
      },
      projection: null,
      projectionStatus: null,
      initialRuntimeAvailability: null,
      offline: false,
      submit,
      reconnect: vi.fn().mockResolvedValue(true)
    };
    const hook = await promptHarness({}, workspaceCanvas);
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "first"));
    if (mode === "force") {
      act(() =>
        hook.rerender({ ...hook.initialProps, currentGraph: promptGraph("external", "external") })
      );
    }
    let saving!: Promise<void>;
    act(() => {
      saving =
        mode === "force"
          ? hook.result.current.applyLocalPromptConflicts()
          : hook.result.current.handlePromptSave("T-ALPHA");
    });
    act(() => hook.result.current.handlePromptChange("T-ALPHA", "second"));
    await act(async () => {
      submitted.resolve({ status: "completed", ok: true, error: null, staleConflict: null });
      await saving;
    });
    expect(hook.result.current.saveStates["T-ALPHA"]).toBe("saving");
    expect(hook.result.current.promptConflicts.length).toBe(mode === "force" ? 1 : 0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    act(() => hook.rerender({ ...hook.initialProps, currentGraph: promptGraph("first", "first") }));
    expect(hook.result.current.promptConflicts).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith({
      intent: { kind: "update_task_prompt", taskId: "T-ALPHA", promptMarkdown: "second" }
    });
    act(() =>
      hook.rerender({ ...hook.initialProps, currentGraph: promptGraph("second", "second") })
    );
    expect(hook.result.current.saveStates["T-ALPHA"]).toBe("saved");
    expect(hook.bridge.updateTaskPrompt).not.toHaveBeenCalled();
    expect(hook.bridge.getTaskDetail).not.toHaveBeenCalled();
  });
});
