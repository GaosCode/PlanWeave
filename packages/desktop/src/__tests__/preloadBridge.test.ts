import type {
  DesktopAutoRunEvent,
  DesktopBridgeApi,
  DesktopPackageFileChangeEvent,
  DesktopProjectSummary,
  DesktopRuntimeStateChangeEvent
} from "@planweave-ai/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeInvokeApi } from "../preload/bridgeInvocation";
import {
  appUpdateChangedChannel,
  appUpdateInvokeChannels,
  type AppUpdateState
} from "../shared/appUpdate";
import {
  defaultDesktopSettings,
  desktopSettingsInvokeChannels,
  type DesktopUiSettings
} from "../shared/desktopSettings";
import {
  autoRunChangedChannel,
  desktopBridgeInvokeChannels,
  packageFileChangedChannel,
  runnerRecordEventChannel,
  runnerRecordSubscribeChannel,
  runnerRecordUnsubscribeChannel,
  runtimeStateChangedChannel,
  type DesktopBridgeInvokeMethod
} from "../shared/ipcChannels";
import {
  mcpTunnelChangedChannel,
  mcpTunnelInvokeChannels,
  type McpTunnelStatus
} from "../shared/mcpTunnel";
import { windowAppearanceInvokeChannels } from "../shared/windowAppearance";

type IpcRendererListener = (event: unknown, payload: unknown) => void;
type InvokeForwarder = (...args: unknown[]) => Promise<unknown>;

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
    const invoke = vi.fn<Parameters<typeof createDesktopBridgeInvokeApi>[0]>(
      async (channel: string, ...args: unknown[]) => ({
        channel,
        args
      })
    );
    const api = createDesktopBridgeInvokeApi(invoke);
    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    const apiMethods = Object.keys(api).sort();
    const channelMethods = Object.keys(desktopBridgeInvokeChannels).sort();

    expect(apiMethods).toEqual(channelMethods);

    for (const [method, channel] of Object.entries(desktopBridgeInvokeChannels)) {
      invoke.mockClear();
      const bridgeMethod = api[method as DesktopBridgeInvokeMethod] as InvokeForwarder;

      await bridgeMethod(ref, "arg-1", { nested: true });

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

  it("exposes ACP prompt continuation through the invoke bridge", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValue(undefined);
    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as DesktopBridgeApi;
    const identity = {
      ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      recordId: "T-001#B-001::RUN-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1"
    };

    await api.sendAgentPrompt(identity, "continue");

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.sendAgentPrompt,
      identity,
      "continue"
    );
  });

  it("forwards refreshPackageFileChanges options through the invoke bridge", async () => {
    const invoke = vi.fn<Parameters<typeof createDesktopBridgeInvokeApi>[0]>(async () => ({
      ok: true
    }));
    const api = createDesktopBridgeInvokeApi(invoke);
    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };
    const options = { changedPaths: ["package/nodes/T-001/prompt.md"] };

    await api.refreshPackageFileChanges(ref, options);

    expect(invoke).toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.refreshPackageFileChanges,
      ref,
      options
    );
  });

  it("forwards executor preflight requests through the invoke bridge", async () => {
    const invoke = vi.fn<Parameters<typeof createDesktopBridgeInvokeApi>[0]>(async () => ({
      name: "codex",
      adapter: "codex-exec",
      profileAdapter: "agent",
      executionIntegration: "codex-exec",
      ok: true,
      message: "executor preflight passed",
      checks: []
    }));
    const api = createDesktopBridgeInvokeApi(invoke);
    const ref = { projectRoot: "/tmp/project", canvasId: "canvas-a" };

    await api.testExecutorProfile(ref, "codex");

    expect(invoke).toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.testExecutorProfile,
      ref,
      "codex"
    );
  });

  it("forwards dedicated agent capability probes through the invoke bridge", async () => {
    const invoke = vi.fn<Parameters<typeof createDesktopBridgeInvokeApi>[0]>(async () => ({
      agentKind: "codex",
      ok: true,
      message: "ACP capability probe passed.",
      failureCode: null,
      agentInfo: null,
      capabilities: ["session"],
      sessionConfig: null
    }));
    const api = createDesktopBridgeInvokeApi(invoke);
    const input = { agentKind: "codex" as const, projectRoot: null };

    await api.probeDesktopAgentCapabilities(input);

    expect(invoke).toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.probeDesktopAgentCapabilities,
      input
    );
  });

  it("exposes package file change subscription with unsubscribe", async () => {
    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as {
      onPackageFileChanged(callback: (event: DesktopPackageFileChangeEvent) => void): () => void;
    };
    const callback = vi.fn();

    const unsubscribe = api.onPackageFileChanged(callback);

    expect(electronMock.ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [channel, listener] = electronMock.ipcRenderer.on.mock.calls[0] as [
      string,
      IpcRendererListener
    ];
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
    const api = electronMock.exposed.get("planweave") as {
      onAutoRunChanged(callback: (event: DesktopAutoRunEvent) => void): () => void;
    };
    const callback = vi.fn();

    const unsubscribe = api.onAutoRunChanged(callback);

    expect(electronMock.ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [channel, listener] = electronMock.ipcRenderer.on.mock.calls[0] as [
      string,
      IpcRendererListener
    ];
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

  it("exposes runtime state change subscription with unsubscribe", async () => {
    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as {
      onRuntimeStateChanged(callback: (event: DesktopRuntimeStateChangeEvent) => void): () => void;
    };
    const callback = vi.fn();

    const unsubscribe = api.onRuntimeStateChanged(callback);

    expect(electronMock.ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [channel, listener] = electronMock.ipcRenderer.on.mock.calls[0] as [
      string,
      IpcRendererListener
    ];
    expect(channel).toBe(runtimeStateChangedChannel);
    const event: DesktopRuntimeStateChangeEvent = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      stateFile: "/tmp/project/.planweave/canvases/canvas-a/state.json",
      changedAt: "2026-06-16T00:00:01.000Z"
    };
    listener({}, event);

    expect(callback).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(runtimeStateChangedChannel, listener);
  });

  it("subscribes before replay invoke and tears down runner listeners deterministically", async () => {
    electronMock.ipcRenderer.invoke.mockImplementation(
      async (channel: string, payload?: unknown) => {
        if (channel === runnerRecordSubscribeChannel) {
          const subscriptionId = (payload as { subscriptionId: string }).subscriptionId;
          return {
            subscriptionId,
            updateSequence: 0,
            snapshot: { terminal: false, events: [] }
          };
        }
        return undefined;
      }
    );
    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as DesktopBridgeApi;
    const callback = vi.fn();

    const startPromise = api.subscribeRunnerRecord(
      {
        ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
        recordId: "T-001#B-001::RUN-001"
      },
      callback
    );

    expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith(
      runnerRecordEventChannel,
      expect.any(Function)
    );
    const request = electronMock.ipcRenderer.invoke.mock.calls[0]?.[1] as {
      subscriptionId: string;
    };
    const start = await startPromise;
    const listener = electronMock.ipcRenderer.on.mock.calls[0]?.[1] as IpcRendererListener;
    const update = {
      updateSequence: 1,
      snapshot: { terminal: false, events: [{ sequence: 2 }] }
    };
    listener({}, { subscriptionId: request.subscriptionId, ...update });
    listener({}, { subscriptionId: "foreign", ...update });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(update);
    await start.unsubscribe();
    await start.unsubscribe();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledTimes(1);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      runnerRecordUnsubscribeChannel,
      request.subscriptionId
    );
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
      getWindowMaterialCapabilities(): Promise<{
        platform: string;
        reason: "supported";
        supported: boolean;
      }>;
      setWindowMaterial(settings: {
        enabled: boolean;
        appearance: "system" | "light" | "dark";
      }): Promise<void>;
    };

    await expect(api.getWindowMaterialCapabilities()).resolves.toEqual({
      platform: "darwin",
      reason: "supported",
      supported: true
    });
    await api.setWindowMaterial({ appearance: "dark", enabled: true });

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      windowAppearanceInvokeChannels.getWindowMaterialCapabilities
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      windowAppearanceInvokeChannels.setWindowMaterial,
      {
        appearance: "dark",
        enabled: true
      }
    );
  });

  it("exposes the app update API through a separate preload surface", async () => {
    const state: AppUpdateState = {
      status: "available",
      checkedAt: "2026-06-19T00:00:00.000Z",
      currentVersion: "0.1.1",
      delivery: "in-app",
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

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      appUpdateInvokeChannels.getAppUpdateState
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      appUpdateInvokeChannels.checkForAppUpdate
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      appUpdateInvokeChannels.downloadAppUpdate
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      appUpdateInvokeChannels.installAppUpdate
    );

    const [channel, listener] = electronMock.ipcRenderer.on.mock.calls[0] as [
      string,
      IpcRendererListener
    ];
    expect(channel).toBe(appUpdateChangedChannel);
    listener({}, state);
    expect(callback).toHaveBeenCalledWith(state);
    unsubscribe();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(appUpdateChangedChannel, listener);
  });

  it("exposes the desktop settings API through a separate preload surface", async () => {
    const settings: DesktopUiSettings = {
      ...defaultDesktopSettings,
      appearance: "dark"
    };
    electronMock.ipcRenderer.invoke.mockResolvedValue(settings);

    await import("../preload/preload");
    const api = electronMock.exposed.get("planweaveDesktopSettings") as {
      getDesktopSettings(): Promise<DesktopUiSettings>;
      saveDesktopSettings(patch: { appearance: "dark" }): Promise<DesktopUiSettings>;
      migrateLegacyDesktopSettings(payload: unknown): Promise<DesktopUiSettings>;
    };

    await expect(api.getDesktopSettings()).resolves.toBe(settings);
    await api.saveDesktopSettings({ appearance: "dark" });
    await api.migrateLegacyDesktopSettings('{"appearance":"dark"}');

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      desktopSettingsInvokeChannels.getDesktopSettings
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      desktopSettingsInvokeChannels.saveDesktopSettings,
      { appearance: "dark" }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      desktopSettingsInvokeChannels.migrateLegacyDesktopSettings,
      '{"appearance":"dark"}'
    );
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
        runtimeApiKeyPersistence: "persisted",
        runtimeApiKeyStorage: "available",
        autoStart: true
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
      setTunnelAutoStart(enabled: boolean): Promise<McpTunnelStatus>;
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
    await api.setTunnelAutoStart(true);
    await api.startLocalMcp({ port: 8788 });
    await api.stopLocalMcp();
    await api.startTunnel({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey: "secret-key"
    });
    await api.stopTunnel();
    const unsubscribe = api.onMcpTunnelChanged(callback);

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      mcpTunnelInvokeChannels.getMcpTunnelStatus
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      mcpTunnelInvokeChannels.downloadTunnelClient
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      mcpTunnelInvokeChannels.setTunnelClientPath,
      "/usr/local/bin/tunnel-client"
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      mcpTunnelInvokeChannels.setTunnelAutoStart,
      true
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      mcpTunnelInvokeChannels.startLocalMcp,
      { port: 8788 }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      mcpTunnelInvokeChannels.stopLocalMcp
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      mcpTunnelInvokeChannels.startTunnel,
      {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        runtimeApiKey: "secret-key"
      }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      mcpTunnelInvokeChannels.stopTunnel
    );

    const [channel, listener] = electronMock.ipcRenderer.on.mock.calls[0] as [
      string,
      IpcRendererListener
    ];
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
    const api = electronMock.exposed.get("planweave") as {
      revealPathInFinder(path: string): Promise<void>;
    };
    const smokeApi = electronMock.exposed.get("planweaveSmoke") as {
      clearLastRevealPath(): void;
      getLastRevealPath(): string | null;
    };

    expect(smokeApi.getLastRevealPath()).toBeNull();
    await api.revealPathInFinder("/tmp/record/metadata.json");

    expect(electronMock.ipcRenderer.invoke).not.toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.revealPathInFinder,
      "/tmp/record/metadata.json"
    );
    expect(smokeApi.getLastRevealPath()).toBe("/tmp/record/metadata.json");

    smokeApi.clearLastRevealPath();
    expect(smokeApi.getLastRevealPath()).toBeNull();
  });

  it("invokes reveal path IPC outside smoke mode", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValue(undefined);

    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as {
      revealPathInFinder(path: string): Promise<void>;
    };

    await api.revealPathInFinder("/tmp/record/metadata.json");

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.revealPathInFinder,
      "/tmp/record/metadata.json"
    );
  });

  it("does not expose the smoke reveal path signal outside smoke mode", async () => {
    await import("../preload/preload");

    expect(electronMock.exposed.has("planweaveSmoke")).toBe(false);
  });
});
