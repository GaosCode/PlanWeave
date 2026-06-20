import type { DesktopAutoRunEvent, DesktopPackageFileChangeEvent, DesktopProjectSummary } from "@planweave-ai/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeInvokeApi } from "../preload/bridgeInvocation";
import { appUpdateChangedChannel, appUpdateInvokeChannels, type AppUpdateState } from "../shared/appUpdate";
import { autoRunChangedChannel, desktopBridgeInvokeChannels, packageFileChangedChannel } from "../shared/ipcChannels";
import { mcpTunnelChangedChannel, mcpTunnelInvokeChannels, type McpTunnelStatus } from "../shared/mcpTunnel";
import { windowAppearanceInvokeChannels } from "../shared/windowAppearance";

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
    delete process.env.PLANWEAVE_DESKTOP_SMOKE;
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
        explanation: {
          phase: "running",
          currentRef: "T-001#B-001",
          currentExecutor: null,
          latestRecordId: null,
          latestRecordPath: null,
          latestOutputSummary: null,
          error: null,
          nextAction: {
            kind: "wait",
            message: "Wait for the current Auto Run step to finish.",
            command: null,
            targetPath: null,
            ref: "T-001#B-001"
          }
        },
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

  it("exposes the window appearance API through a separate preload surface", async () => {
    electronMock.ipcRenderer.invoke.mockImplementation(async (channel: string) => {
      if (channel === windowAppearanceInvokeChannels.getWindowMaterialCapabilities) {
        return {
          platform: "darwin",
          reason: "supported",
          supported: true
        };
      }
      return undefined;
    });

    await import("../preload/preload");
    const api = electronMock.exposed.get("planweaveWindow") as {
      getWindowMaterialCapabilities(): Promise<{ platform: string; reason: "supported"; supported: boolean }>;
      setWindowMaterial(settings: { enabled: boolean; appearance: "system" | "light" | "dark" }): Promise<void>;
    };

    await expect(api.getWindowMaterialCapabilities()).resolves.toEqual({
      platform: "darwin",
      reason: "supported",
      supported: true
    });
    await api.setWindowMaterial({ appearance: "dark", enabled: true });

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(windowAppearanceInvokeChannels.getWindowMaterialCapabilities);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(windowAppearanceInvokeChannels.setWindowMaterial, {
      appearance: "dark",
      enabled: true
    });
  });

  it("exposes the app update API through a separate preload surface", async () => {
    const state: AppUpdateState = {
      status: "available",
      checkedAt: "2026-06-19T00:00:00.000Z",
      currentVersion: "0.1.1",
      error: null,
      progress: null,
      update: { version: "0.1.2", releaseDate: null, releaseName: null },
      updatedAt: "2026-06-19T00:00:01.000Z"
    };
    electronMock.ipcRenderer.invoke.mockResolvedValue(state);

    await import("../preload/preload");
    const api = electronMock.exposed.get("planweaveAppUpdate") as {
      checkForAppUpdate(): Promise<AppUpdateState>;
      downloadAppUpdate(): Promise<AppUpdateState>;
      getAppUpdateState(): Promise<AppUpdateState>;
      installAppUpdate(): Promise<AppUpdateState>;
      onAppUpdateChanged(callback: (state: AppUpdateState) => void): () => void;
    };
    const callback = vi.fn();

    await expect(api.getAppUpdateState()).resolves.toBe(state);
    await api.checkForAppUpdate();
    await api.downloadAppUpdate();
    await api.installAppUpdate();
    const unsubscribe = api.onAppUpdateChanged(callback);

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(appUpdateInvokeChannels.getAppUpdateState);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(appUpdateInvokeChannels.checkForAppUpdate);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(appUpdateInvokeChannels.downloadAppUpdate);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(appUpdateInvokeChannels.installAppUpdate);

    const [channel, listener] = electronMock.ipcRenderer.on.mock.calls[0] as [string, IpcRendererListener];
    expect(channel).toBe(appUpdateChangedChannel);
    listener({}, state);
    expect(callback).toHaveBeenCalledWith(state);
    unsubscribe();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(appUpdateChangedChannel, listener);
  });

  it("exposes the MCP tunnel API through a separate preload surface", async () => {
    const status: McpTunnelStatus = {
      binary: {
        path: "/usr/local/bin/tunnel-client",
        available: true,
        source: "managed",
        assetName: "tunnel-client-test-darwin-arm64.zip",
        assetSha256: "1".repeat(64),
        sha256: "0".repeat(64),
        version: "tunnel-client test",
        verified: true,
        error: null
      },
      download: {
        phase: "ready",
        assetName: "tunnel-client-test-darwin-arm64.zip",
        error: null
      },
      localMcp: {
        phase: "running",
        endpoint: "http://127.0.0.1:8787/mcp",
        host: "127.0.0.1",
        port: 8787,
        pid: 123,
        planweaveHome: "/Users/example/.planweave",
        planweaveHomeFromEnv: false,
        healthy: true,
        error: null
      },
      tunnel: {
        phase: "stopped",
        profile: "planweave-local-http",
        tunnelId: null,
        pid: null,
        healthUrl: null,
        ready: false,
        error: null
      },
      config: {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        hasRuntimeApiKey: true,
        runtimeApiKeyStorage: "available"
      },
      downloadUrl: "https://github.com/openai/tunnel-client/releases/latest",
      updatedAt: "2026-06-19T00:00:00.000Z"
    };
    electronMock.ipcRenderer.invoke.mockResolvedValue(status);

    await import("../preload/preload");
    const api = electronMock.exposed.get("planweaveMcpTunnel") as {
      getMcpTunnelStatus(): Promise<McpTunnelStatus>;
      downloadTunnelClient(): Promise<McpTunnelStatus>;
      setTunnelClientPath(path: string | null): Promise<McpTunnelStatus>;
      startLocalMcp(input?: { port?: number | null }): Promise<McpTunnelStatus>;
      stopLocalMcp(): Promise<McpTunnelStatus>;
      startTunnel(input: { tunnelId: string; runtimeApiKey: string }): Promise<McpTunnelStatus>;
      stopTunnel(): Promise<McpTunnelStatus>;
      onMcpTunnelChanged(callback: (status: McpTunnelStatus) => void): () => void;
    };
    const callback = vi.fn();

    await api.getMcpTunnelStatus();
    await api.downloadTunnelClient();
    await api.setTunnelClientPath("/usr/local/bin/tunnel-client");
    await api.startLocalMcp({ port: 8788 });
    await api.stopLocalMcp();
    await api.startTunnel({ tunnelId: "tunnel_0123456789abcdef0123456789abcdef", runtimeApiKey: "secret-key" });
    await api.stopTunnel();
    const unsubscribe = api.onMcpTunnelChanged(callback);

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(mcpTunnelInvokeChannels.getMcpTunnelStatus);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(mcpTunnelInvokeChannels.downloadTunnelClient);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(mcpTunnelInvokeChannels.setTunnelClientPath, "/usr/local/bin/tunnel-client");
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(mcpTunnelInvokeChannels.startLocalMcp, { port: 8788 });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(mcpTunnelInvokeChannels.stopLocalMcp);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(mcpTunnelInvokeChannels.startTunnel, {
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "secret-key"
    });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(mcpTunnelInvokeChannels.stopTunnel);

    const [channel, listener] = electronMock.ipcRenderer.on.mock.calls[0] as [string, IpcRendererListener];
    expect(channel).toBe(mcpTunnelChangedChannel);
    listener({}, status);
    expect(callback).toHaveBeenCalledWith(status);
    unsubscribe();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(mcpTunnelChangedChannel, listener);
  });

  it("records smoke reveal requests without invoking the system file manager", async () => {
    process.env.PLANWEAVE_DESKTOP_SMOKE = "1";
    electronMock.ipcRenderer.invoke.mockResolvedValue(undefined);

    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as { revealPathInFinder(path: string): Promise<void> };
    const smokeApi = electronMock.exposed.get("planweaveSmoke") as {
      clearLastRevealPath(): void;
      getLastRevealPath(): string | null;
    };

    expect(smokeApi.getLastRevealPath()).toBeNull();
    await api.revealPathInFinder("/tmp/record/metadata.json");

    expect(electronMock.ipcRenderer.invoke).not.toHaveBeenCalledWith(desktopBridgeInvokeChannels.revealPathInFinder, "/tmp/record/metadata.json");
    expect(smokeApi.getLastRevealPath()).toBe("/tmp/record/metadata.json");

    smokeApi.clearLastRevealPath();
    expect(smokeApi.getLastRevealPath()).toBeNull();
  });

  it("invokes reveal path IPC outside smoke mode", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValue(undefined);

    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as { revealPathInFinder(path: string): Promise<void> };

    await api.revealPathInFinder("/tmp/record/metadata.json");

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(desktopBridgeInvokeChannels.revealPathInFinder, "/tmp/record/metadata.json");
  });

  it("does not expose the smoke reveal path signal outside smoke mode", async () => {
    await import("../preload/preload");

    expect(electronMock.exposed.has("planweaveSmoke")).toBe(false);
  });
});
