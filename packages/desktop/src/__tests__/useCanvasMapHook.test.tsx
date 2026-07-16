/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopCanvasGraphViewModel,
  DesktopCanvasMapLayout,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { CanvasFlowNode } from "../renderer/types";

afterEach(cleanupRendererTestEnvironment);

const project: DesktopProjectSummary = {
  activeCanvasId: "default",
  kind: "managed",
  name: "Demo",
  projectId: "demo",
  rootPath: "/tmp/demo",
  sourceRoot: null,
  taskCanvases: [],
  workspaceRoot: "/tmp/demo"
};

const graph: DesktopCanvasGraphViewModel = {
  canvases: [
    {
      canvasId: "default",
      diagnostics: [],
      executionPolicy: { parallelEnabled: false, maxConcurrent: 1 },
      packageDir: "canvases/default/package",
      title: "Default"
    }
  ],
  crossTaskEdges: [],
  diagnostics: [],
  edges: [],
  health: {
    blockedBlocks: [],
    canvases: [{ blockerCount: 0, canvasId: "default", diagnosticCount: 0, severity: "ok" }],
    diagnostics: [],
    edges: [],
    severity: "ok"
  },
  projectId: "demo",
  projectTitle: "Demo"
};

const layout: DesktopCanvasMapLayout = {
  version: "desktop-canvas-map-layout/v1",
  projectId: "demo",
  nodes: [{ canvasId: "default", x: 80, y: 80 }],
  updatedAt: "2026-07-01T00:00:00.000Z"
};

function flowNodes(x: number, y: number): CanvasFlowNode[] {
  return [
    {
      id: "default",
      type: "canvas",
      position: { x, y },
      data: {} as CanvasFlowNode["data"]
    }
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function importHook() {
  vi.resetModules();
  return import("../renderer/hooks/useCanvasMap");
}

describe("useCanvasMap layout error state", () => {
  it("keeps working layout and last-known-good after save failure", async () => {
    const setError = vi.fn();
    const bridge = createDesktopBridgeMock({
      getCanvasGraphViewModel: vi.fn().mockResolvedValue(graph),
      getCanvasMapLayout: vi.fn().mockResolvedValue(layout),
      saveCanvasMapLayout: vi.fn().mockRejectedValue(new Error("disk full")),
      resetCanvasMapLayout: vi.fn()
    });
    vi.stubGlobal("planweave", bridge);
    const { useCanvasMap } = await importHook();

    const { result } = renderHook(() =>
      useCanvasMap({
        activeCanvasId: "default",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() => expect(result.current.canvasMapLayout).toEqual(layout));
    expect(result.current.persistedCanvasMapLayout).toEqual(layout);
    expect(result.current.layoutDirty).toBe(false);

    await act(async () => {
      await result.current.saveCanvasMapLayoutFromNodes(flowNodes(120, 140));
    });

    expect(setError).toHaveBeenCalledWith("disk full");
    expect(result.current.canvasMapLayout).toMatchObject({
      nodes: [{ canvasId: "default", x: 120, y: 140 }]
    });
    expect(result.current.persistedCanvasMapLayout).toEqual(layout);
    expect(result.current.layoutDirty).toBe(true);
  });

  it("does not change working or persisted layout when reset fails", async () => {
    const setError = vi.fn();
    const bridge = createDesktopBridgeMock({
      getCanvasGraphViewModel: vi.fn().mockResolvedValue(graph),
      getCanvasMapLayout: vi.fn().mockResolvedValue(layout),
      resetCanvasMapLayout: vi.fn().mockRejectedValue(new Error("reset denied"))
    });
    vi.stubGlobal("planweave", bridge);
    const { useCanvasMap } = await importHook();

    const { result } = renderHook(() =>
      useCanvasMap({
        activeCanvasId: "default",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() => expect(result.current.canvasMapLayout).toEqual(layout));

    await act(async () => {
      await result.current.resetCanvasMapLayout();
    });

    expect(setError).toHaveBeenCalledWith("reset denied");
    expect(result.current.canvasMapLayout).toEqual(layout);
    expect(result.current.persistedCanvasMapLayout).toEqual(layout);
    expect(result.current.layoutDirty).toBe(false);
  });

  it("keeps last-known-good layout when a later load fails", async () => {
    const setError = vi.fn();
    const getLayout = vi
      .fn()
      .mockResolvedValueOnce(layout)
      .mockRejectedValueOnce(new Error("corrupt layout"));
    const bridge = createDesktopBridgeMock({
      getCanvasGraphViewModel: vi.fn().mockResolvedValue(graph),
      getCanvasMapLayout: getLayout
    });
    vi.stubGlobal("planweave", bridge);
    const { useCanvasMap } = await importHook();

    const { result } = renderHook(() =>
      useCanvasMap({
        activeCanvasId: "default",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() => expect(result.current.canvasMapLayout).toEqual(layout));

    await act(async () => {
      await result.current.loadCanvasMap();
    });

    expect(setError).toHaveBeenCalledWith("corrupt layout");
    expect(result.current.canvasMapLayout).toEqual(layout);
    expect(result.current.persistedCanvasMapLayout).toEqual(layout);
  });

  it("ignores stale save responses so out-of-order completion cannot roll back newer state", async () => {
    const setError = vi.fn();
    const first = deferred<DesktopCanvasMapLayout>();
    const second = deferred<DesktopCanvasMapLayout>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const bridge = createDesktopBridgeMock({
      getCanvasGraphViewModel: vi.fn().mockResolvedValue(graph),
      getCanvasMapLayout: vi.fn().mockResolvedValue(layout),
      saveCanvasMapLayout: save
    });
    vi.stubGlobal("planweave", bridge);
    const { useCanvasMap } = await importHook();

    const { result } = renderHook(() =>
      useCanvasMap({
        activeCanvasId: "default",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() => expect(result.current.canvasMapLayout).toEqual(layout));

    let firstSave!: Promise<void>;
    let secondSave!: Promise<void>;
    act(() => {
      firstSave = result.current.saveCanvasMapLayoutFromNodes(flowNodes(10, 10));
      secondSave = result.current.saveCanvasMapLayoutFromNodes(flowNodes(20, 20));
    });

    const secondSaved: DesktopCanvasMapLayout = {
      ...layout,
      nodes: [{ canvasId: "default", x: 20, y: 20 }],
      updatedAt: "2026-07-04T00:00:00.000Z"
    };
    const firstSaved: DesktopCanvasMapLayout = {
      ...layout,
      nodes: [{ canvasId: "default", x: 10, y: 10 }],
      updatedAt: "2026-07-03T00:00:00.000Z"
    };

    await act(async () => {
      second.resolve(secondSaved);
      await secondSave;
    });
    expect(result.current.canvasMapLayout).toEqual(secondSaved);
    expect(result.current.persistedCanvasMapLayout).toEqual(secondSaved);

    await act(async () => {
      first.resolve(firstSaved);
      await firstSave;
    });

    expect(result.current.canvasMapLayout).toEqual(secondSaved);
    expect(result.current.persistedCanvasMapLayout).toEqual(secondSaved);
    expect(result.current.layoutDirty).toBe(false);
  });

  it("ignores stale reset responses after a newer reset completes", async () => {
    const setError = vi.fn();
    const first = deferred<DesktopCanvasMapLayout>();
    const second = deferred<DesktopCanvasMapLayout>();
    const reset = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const bridge = createDesktopBridgeMock({
      getCanvasGraphViewModel: vi.fn().mockResolvedValue(graph),
      getCanvasMapLayout: vi.fn().mockResolvedValue(layout),
      resetCanvasMapLayout: reset
    });
    vi.stubGlobal("planweave", bridge);
    const { useCanvasMap } = await importHook();

    const { result } = renderHook(() =>
      useCanvasMap({
        activeCanvasId: "default",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() => expect(result.current.canvasMapLayout).toEqual(layout));

    let firstReset!: Promise<void>;
    let secondReset!: Promise<void>;
    act(() => {
      firstReset = result.current.resetCanvasMapLayout();
      secondReset = result.current.resetCanvasMapLayout();
    });

    const secondDefault: DesktopCanvasMapLayout = {
      ...layout,
      nodes: [{ canvasId: "default", x: 80, y: 80 }],
      updatedAt: "1970-01-01T00:00:00.000Z"
    };
    const firstDefault: DesktopCanvasMapLayout = {
      ...layout,
      nodes: [{ canvasId: "default", x: 999, y: 999 }],
      updatedAt: "1970-01-01T00:00:00.001Z"
    };

    await act(async () => {
      second.resolve(secondDefault);
      await secondReset;
    });
    expect(result.current.canvasMapLayout).toEqual(secondDefault);

    await act(async () => {
      first.resolve(firstDefault);
      await firstReset;
    });

    expect(result.current.canvasMapLayout).toEqual(secondDefault);
    expect(result.current.persistedCanvasMapLayout).toEqual(secondDefault);
  });

  it("ignores a stale load that finishes after a newer save", async () => {
    const setError = vi.fn();
    const slowLoad = deferred<DesktopCanvasMapLayout>();
    const getLayout = vi
      .fn()
      .mockResolvedValueOnce(layout)
      .mockImplementationOnce(() => slowLoad.promise);
    const saved: DesktopCanvasMapLayout = {
      ...layout,
      nodes: [{ canvasId: "default", x: 30, y: 40 }],
      updatedAt: "2026-07-06T00:00:00.000Z"
    };
    const bridge = createDesktopBridgeMock({
      getCanvasGraphViewModel: vi.fn().mockResolvedValue(graph),
      getCanvasMapLayout: getLayout,
      saveCanvasMapLayout: vi.fn().mockResolvedValue(saved)
    });
    vi.stubGlobal("planweave", bridge);
    const { useCanvasMap } = await importHook();

    const { result } = renderHook(() =>
      useCanvasMap({
        activeCanvasId: "default",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() => expect(result.current.canvasMapLayout).toEqual(layout));

    let reload!: Promise<void>;
    act(() => {
      reload = result.current.loadCanvasMap();
    });

    await act(async () => {
      await result.current.saveCanvasMapLayoutFromNodes(flowNodes(30, 40));
    });
    expect(result.current.canvasMapLayout).toEqual(saved);
    expect(result.current.layoutDirty).toBe(false);

    const staleLoaded: DesktopCanvasMapLayout = {
      ...layout,
      nodes: [{ canvasId: "default", x: 1, y: 1 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    await act(async () => {
      slowLoad.resolve(staleLoaded);
      await reload;
    });

    expect(result.current.canvasMapLayout).toEqual(saved);
    expect(result.current.persistedCanvasMapLayout).toEqual(saved);
    expect(result.current.layoutDirty).toBe(false);
  });

  it("ignores a stale load that finishes after a newer reset", async () => {
    const setError = vi.fn();
    const slowLoad = deferred<DesktopCanvasMapLayout>();
    const getLayout = vi
      .fn()
      .mockResolvedValueOnce(layout)
      .mockImplementationOnce(() => slowLoad.promise);
    const resetLayout: DesktopCanvasMapLayout = {
      ...layout,
      nodes: [{ canvasId: "default", x: 80, y: 80 }],
      updatedAt: "1970-01-01T00:00:00.000Z"
    };
    const bridge = createDesktopBridgeMock({
      getCanvasGraphViewModel: vi.fn().mockResolvedValue(graph),
      getCanvasMapLayout: getLayout,
      resetCanvasMapLayout: vi.fn().mockResolvedValue(resetLayout)
    });
    vi.stubGlobal("planweave", bridge);
    const { useCanvasMap } = await importHook();

    const { result } = renderHook(() =>
      useCanvasMap({
        activeCanvasId: "default",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() => expect(result.current.canvasMapLayout).toEqual(layout));

    let reload!: Promise<void>;
    act(() => {
      reload = result.current.loadCanvasMap();
    });

    await act(async () => {
      await result.current.resetCanvasMapLayout();
    });
    expect(result.current.canvasMapLayout).toEqual(resetLayout);

    await act(async () => {
      slowLoad.resolve({
        ...layout,
        nodes: [{ canvasId: "default", x: 7, y: 8 }]
      });
      await reload;
    });

    expect(result.current.canvasMapLayout).toEqual(resetLayout);
    expect(result.current.persistedCanvasMapLayout).toEqual(resetLayout);
  });

  it("retrySaveCanvasMapLayout re-sends the current working layout after a failed save", async () => {
    const setError = vi.fn();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({
        ...layout,
        nodes: [{ canvasId: "default", x: 120, y: 140 }],
        updatedAt: "2026-07-07T00:00:00.000Z"
      });
    const bridge = createDesktopBridgeMock({
      getCanvasGraphViewModel: vi.fn().mockResolvedValue(graph),
      getCanvasMapLayout: vi.fn().mockResolvedValue(layout),
      saveCanvasMapLayout: save
    });
    vi.stubGlobal("planweave", bridge);
    const { useCanvasMap } = await importHook();

    const { result } = renderHook(() =>
      useCanvasMap({
        activeCanvasId: "default",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() => expect(result.current.canvasMapLayout).toEqual(layout));

    await act(async () => {
      await result.current.saveCanvasMapLayoutFromNodes(flowNodes(120, 140));
    });
    expect(result.current.layoutDirty).toBe(true);

    await act(async () => {
      await result.current.retrySaveCanvasMapLayout();
    });

    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.layoutDirty).toBe(false);
    expect(result.current.canvasMapLayout).toMatchObject({
      nodes: [{ canvasId: "default", x: 120, y: 140 }]
    });
  });

  it("keeps dirty working layout across a successful reload after save failure", async () => {
    const setError = vi.fn();
    const diskLayout: DesktopCanvasMapLayout = {
      ...layout,
      nodes: [{ canvasId: "default", x: 80, y: 80 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    const getLayout = vi.fn().mockResolvedValue(diskLayout);
    const bridge = createDesktopBridgeMock({
      getCanvasGraphViewModel: vi.fn().mockResolvedValue(graph),
      getCanvasMapLayout: getLayout,
      saveCanvasMapLayout: vi.fn().mockRejectedValue(new Error("disk full"))
    });
    vi.stubGlobal("planweave", bridge);
    const { useCanvasMap } = await importHook();

    const { result } = renderHook(() =>
      useCanvasMap({
        activeCanvasId: "default",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() => expect(result.current.canvasMapLayout).toEqual(diskLayout));

    await act(async () => {
      await result.current.saveCanvasMapLayoutFromNodes(flowNodes(120, 140));
    });
    expect(result.current.layoutDirty).toBe(true);
    expect(result.current.canvasMapLayout).toMatchObject({
      nodes: [{ canvasId: "default", x: 120, y: 140 }]
    });

    await act(async () => {
      await result.current.loadCanvasMap();
    });

    expect(getLayout).toHaveBeenCalledTimes(2);
    expect(result.current.layoutDirty).toBe(true);
    expect(result.current.canvasMapLayout).toMatchObject({
      nodes: [{ canvasId: "default", x: 120, y: 140 }]
    });
    expect(result.current.persistedCanvasMapLayout).toEqual(diskLayout);
  });
});
