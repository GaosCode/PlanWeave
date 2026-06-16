import type { DesktopAutoRunEvent, DesktopPackageFileChangeEvent, DesktopProjectSummary } from "@planweave-ai/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeInvokeApi } from "../preload/bridgeInvocation";
import { autoRunChangedChannel, desktopBridgeInvokeChannels, packageFileChangedChannel } from "../shared/ipcChannels";

type IpcRendererListener = (event: unknown, payload: unknown) => void;

const electronMock = vi.hoisted(() => {
  const exposed = new Map<string, unknown>();
  return {
    exposed,
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => {
        exposed.set(key, api);
      })
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    }
  };
});

vi.mock("electron", () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer
}));

describe("preload bridge invocation", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.exposed.clear();
    electronMock.contextBridge.exposeInMainWorld.mockClear();
    electronMock.ipcRenderer.invoke.mockClear();
    electronMock.ipcRenderer.on.mockClear();
    electronMock.ipcRenderer.off.mockClear();
  });

  it("maps every invoke bridge method to its channel and forwards raw args", async () => {
    const invoke = vi.fn<Parameters<typeof createDesktopBridgeInvokeApi>[0]>(async (channel: string, ...args: unknown[]) => ({
      channel,
      args
    }));
    const api = createDesktopBridgeInvokeApi(invoke);
    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };

    for (const [method, channel] of Object.entries(desktopBridgeInvokeChannels)) {
      invoke.mockClear();

      await api[method as keyof typeof desktopBridgeInvokeChannels](ref, "arg-1", { nested: true });

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(channel, ref, "arg-1", { nested: true });
    }
  });

  it("passes through typed call results", async () => {
    const projects: DesktopProjectSummary[] = [
      {
        id: "project-a",
        title: "Project A",
        rootPath: "/tmp/project-a",
        taskCount: 1,
        blockCount: 2,
        reviewCount: 0,
        lastOpenedAt: null
      }
    ];
    const invoke = vi.fn<Parameters<typeof createDesktopBridgeInvokeApi>[0]>(async () => projects);
    const api = createDesktopBridgeInvokeApi(invoke);

    await expect(api.listProjects()).resolves.toBe(projects);
    expect(invoke).toHaveBeenCalledWith(desktopBridgeInvokeChannels.listProjects);
  });

  it("exposes package file change subscription with unsubscribe", async () => {
    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as { onPackageFileChanged(callback: (event: DesktopPackageFileChangeEvent) => void): () => void };
    const callback = vi.fn();

    const unsubscribe = api.onPackageFileChanged(callback);

    expect(electronMock.ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [channel, listener] = electronMock.ipcRenderer.on.mock.calls[0] as [string, IpcRendererListener];
    expect(channel).toBe(packageFileChangedChannel);
    const event: DesktopPackageFileChangeEvent = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      paths: ["package/manifest.json"],
      triggeredAt: "2026-06-16T00:00:00.000Z"
    };
    listener({}, event);

    expect(callback).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(packageFileChangedChannel, listener);
  });

  it("exposes auto-run change subscription with unsubscribe", async () => {
    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as { onAutoRunChanged(callback: (event: DesktopAutoRunEvent) => void): () => void };
    const callback = vi.fn();

    const unsubscribe = api.onAutoRunChanged(callback);

    expect(electronMock.ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [channel, listener] = electronMock.ipcRenderer.on.mock.calls[0] as [string, IpcRendererListener];
    expect(channel).toBe(autoRunChangedChannel);
    const event: DesktopAutoRunEvent = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      runId: "RUN-001",
      phase: "running",
      state: {
        runId: "RUN-001",
        projectRoot: "/tmp/project",
        canvasId: "canvas-a",
        scope: { kind: "project" },
        phase: "running",
        stepCount: 1,
        stepLimit: 10,
        currentRef: "T-001#B-001",
        currentExecutor: null,
        elapsedMs: 100,
        latestOutputSummary: null,
        latestRecordId: null,
        latestRecordPath: null,
        statePath: "/tmp/project/.planweave/auto-run/RUN-001/state.json",
        eventLogPath: "/tmp/project/.planweave/auto-run/RUN-001/events.jsonl",
        options: { tmuxEnabled: false },
        error: null,
        startedAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:01.000Z"
      },
      currentRef: "T-001#B-001",
      latestRecordId: null,
      latestRecordPath: null,
      eventType: "step_started",
      triggeredAt: "2026-06-16T00:00:01.000Z"
    };
    listener({}, event);

    expect(callback).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(autoRunChangedChannel, listener);
  });
});
