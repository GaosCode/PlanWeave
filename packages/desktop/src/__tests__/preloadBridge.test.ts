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
  credentialStorageSettingsInvokeChannels,
  type CredentialStorageSettingsStatus
} from "../shared/credentialStorageSettings";
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
  collaborationInvokeChannels,
  collaborationObserverSignalChannel,
  collaborationStatusChangedChannel,
  type CollaborationStatus,
  type PlanWeaveCollaborationApi
} from "../shared/collaboration";
import {
  mcpTunnelChangedChannel,
  mcpTunnelInvokeChannels,
  type McpTunnelStatus
} from "../shared/mcpTunnel";
import { operatorControlInvokeChannels } from "../shared/operatorControl";
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

  it("exposes Task Workspace query, retry, and ACP recovery with exact identity and audit inputs", async () => {
    const result = { version: "planweave.task-workspace/v1" };
    const invoke = vi.fn<Parameters<typeof createDesktopBridgeInvokeApi>[0]>(async () => result);
    const api = createDesktopBridgeInvokeApi(invoke);
    const input = {
      projectRoot: "/tmp/project",
      canvasId: "canvas-a",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    };

    await expect(api.getTaskWorkspace(input)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith(desktopBridgeInvokeChannels.getTaskWorkspace, input);
    const retryIdentity = {
      version: "planweave.task-workspace-retry/v1" as const,
      projectId: "project-1",
      projectRoot: "/tmp/project",
      canvasId: "canvas-a" as const,
      taskId: "T-001" as const,
      blockId: "B-001",
      claimRef: "T-001#B-001",
      recordId: "T-001#B-001::RUN-001",
      runId: "RUN-001",
      executorRunId: "RUN-001"
    };
    await api.retryTaskWorkspaceRun(retryIdentity);
    expect(invoke).toHaveBeenLastCalledWith(
      desktopBridgeInvokeChannels.retryTaskWorkspaceRun,
      retryIdentity
    );
    const recoveryIdentity = {
      version: "planweave.task-workspace-acp-recovery/v1" as const,
      projectId: "project-1",
      projectRoot: "/tmp/project",
      canvasId: "canvas-a" as const,
      taskId: "T-001" as const,
      blockId: "B-001",
      claimRef: "T-001#B-001",
      recordId: "T-001#B-001::RUN-001",
      runId: "RUN-001",
      sessionId: "session-1",
      terminalEventSequence: 9,
      agentId: "codex" as const,
      profileId: "codex-acp",
      profileFingerprint: "a".repeat(64),
      executorProfile: "codex-acp"
    };
    const audit = { source: "desktop", reason: "owner process exited" };
    await api.recoverTaskWorkspaceAcpRun(recoveryIdentity, audit);
    expect(invoke).toHaveBeenLastCalledWith(
      desktopBridgeInvokeChannels.recoverTaskWorkspaceAcpRun,
      recoveryIdentity,
      audit
    );
    expect(Object.keys(api).filter((method) => method.includes("TaskWorkspace"))).toEqual([
      "getTaskWorkspace",
      "listTaskWorkspaceRuns",
      "getTaskWorkspaceRunDetail",
      "retryTaskWorkspaceRun",
      "recoverTaskWorkspaceAcpRun"
    ]);
  });

  it("exposes ACP prompt continuation through the invoke bridge", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValue(undefined);
    await import("../preload/preload");
    const api = electronMock.exposed.get("planweave") as DesktopBridgeApi;
    const identity = {
      version: "planweave.agent-prompt-turn/v1" as const,
      ref: { projectRoot: "/tmp/project", canvasId: "canvas-a" },
      recordId: "T-001#B-001::RUN-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1",
      turnId: "11111111-1111-4111-8111-111111111111"
    };
    const request = {
      version: "planweave.send-agent-prompt/v1" as const,
      identity,
      text: "continue"
    };

    await api.sendAgentPrompt(request);
    await api.getCurrentAgentPromptTurn({
      ref: identity.ref,
      recordId: identity.recordId,
      executorRunId: identity.executorRunId,
      claimRef: identity.claimRef,
      sessionId: identity.sessionId
    });
    await api.getAgentPromptTurn(identity);
    await api.cancelAgentPromptTurn(identity);

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.sendAgentPrompt,
      request
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.getCurrentAgentPromptTurn,
      {
        ref: identity.ref,
        recordId: identity.recordId,
        executorRunId: identity.executorRunId,
        claimRef: identity.claimRef,
        sessionId: identity.sessionId
      }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.getAgentPromptTurn,
      identity
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      desktopBridgeInvokeChannels.cancelAgentPromptTurn,
      identity
    );
  });

  it("forwards only the redacted Host bootstrap handoff action", async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValue({ state: "ready" });
    await import("../preload/preload");
    const operator = electronMock.exposed.get("planweaveOperatorControl") as {
      copyOperatorHostBootstrapHandoff: (input: unknown) => Promise<unknown>;
      copyOperatorMemberSetupCode: (input: unknown) => Promise<unknown>;
      renewOperatorHostCredential: (input: unknown) => Promise<unknown>;
      getOperatorLocalAgentHostStatus: (input: unknown) => Promise<unknown>;
      registerOperatorLocalAgentHost: (input: unknown) => Promise<unknown>;
      repairOperatorLocalAgentHost: (input: unknown) => Promise<unknown>;
      enrollOperatorLocalAgentHost: (input: unknown) => Promise<unknown>;
    };
    const input = {
      profileId: "profile-a",
      request: {
        expiresAt: "2030-01-01T00:15:00.000Z",
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
      }
    };

    await operator.copyOperatorHostBootstrapHandoff(input);

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      operatorControlInvokeChannels.copyHostBootstrapHandoff,
      input
    );

    await operator.copyOperatorMemberSetupCode({ profileId: "profile-a" });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      operatorControlInvokeChannels.copyMemberSetupCode,
      { profileId: "profile-a" }
    );

    await operator.renewOperatorHostCredential({ profileId: "profile-a", hostId: "host-1" });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      operatorControlInvokeChannels.renewHostCredential,
      { profileId: "profile-a", hostId: "host-1" }
    );

    await operator.getOperatorLocalAgentHostStatus({ profileId: "profile-a" });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      operatorControlInvokeChannels.getLocalAgentHostStatus,
      { profileId: "profile-a" }
    );

    const localInput = { ...input, exposedProfileIds: ["codex-acp"] };
    await operator.registerOperatorLocalAgentHost(localInput);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      operatorControlInvokeChannels.registerLocalAgentHost,
      localInput
    );

    await operator.repairOperatorLocalAgentHost({
      profileId: "profile-a",
      exposedProfileIds: ["codex-acp", "pi-acp"]
    });
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      operatorControlInvokeChannels.repairLocalAgentHost,
      { profileId: "profile-a", exposedProfileIds: ["codex-acp", "pi-acp"] }
    );

    const enrollmentInput = {
      handoff: "planweave-agent-host-setup:example",
      exposedProfileIds: ["codex-acp"]
    };
    await operator.enrollOperatorLocalAgentHost(enrollmentInput);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      operatorControlInvokeChannels.enrollLocalAgentHost,
      enrollmentInput
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
      authentication: { status: "not_advertised" },
      capabilities: ["session"],
      sessionConfig: null,
      checks: [{ check: "acp_initialized", status: "passed", message: "ACP initialize completed." }]
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
      kind: "snapshot" as const,
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
      updatedAt: "2026-06-19T00:00:01.000Z",
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "local_only",
        profile: null,
        workspaceId: null,
        workspaceDisplayName: null,
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
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

  it("exposes credential storage settings without sending credential material", async () => {
    const status: CredentialStorageSettingsStatus = {
      activeMode: "application",
      configuredMode: "application",
      restartRequired: false
    };
    electronMock.ipcRenderer.invoke.mockResolvedValue(status);

    await import("../preload/preload");
    const api = electronMock.exposed.get("planweaveCredentialStorageSettings") as {
      getCredentialStorageSettings(): Promise<CredentialStorageSettingsStatus>;
      configureCredentialStorage(input: {
        mode: "system";
      }): Promise<CredentialStorageSettingsStatus>;
    };

    await expect(api.getCredentialStorageSettings()).resolves.toBe(status);
    await expect(api.configureCredentialStorage({ mode: "system" })).resolves.toBe(status);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      credentialStorageSettingsInvokeChannels.getStatus
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      credentialStorageSettingsInvokeChannels.configure,
      { mode: "system" }
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
      updatedAt: "2026-06-19T00:00:00.000Z",
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "local_only",
        profile: null,
        workspaceId: null,
        workspaceDisplayName: null,
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
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

  it("exposes the collaboration API through a separate preload surface", async () => {
    const status: CollaborationStatus = {
      profiles: [],
      activeProfileId: null,
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "idle",
        activeProfileId: null,
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      updatedAt: "2026-07-25T00:00:00.000Z",
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "local_only",
        profile: null,
        workspaceId: null,
        workspaceDisplayName: null,
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
    };
    const invitation = {
      invitationId: "invitation-1",
      projectId: "project-1",
      role: "member" as const,
      createdByHumanPrincipalId: "human-1",
      createdAt: "2026-07-25T00:00:00.000Z",
      expiresAt: "2026-07-26T00:00:00.000Z"
    };
    electronMock.ipcRenderer.invoke.mockImplementation(async (channel: string) => {
      if (channel === collaborationInvokeChannels.listCollaborationContentBootstrapCandidates) {
        return { ok: true, value: [] };
      }
      if (channel === collaborationInvokeChannels.listCollaborationMembers) {
        return { ok: true, value: { items: [], nextCursor: null } };
      }
      if (channel === collaborationInvokeChannels.updateOwnCollaborationDisplayName) {
        return {
          ok: true,
          value: {
            humanPrincipalId: "human-1",
            displayName: "Ada Lovelace",
            createdAt: "2026-07-25T00:00:00.000Z"
          }
        };
      }
      if (channel === collaborationInvokeChannels.listCollaborationDevices) {
        return { ok: true, value: { items: [], nextCursor: null } };
      }
      if (channel === collaborationInvokeChannels.listCollaborationInvitations) {
        return { ok: true, value: { items: [], nextCursor: null } };
      }
      if (channel === collaborationInvokeChannels.createCollaborationInvitation) {
        return {
          ok: true,
          value: {
            invitation,
            invitationToken: `pw_inv_${"A".repeat(43)}`
          }
        };
      }
      if (
        channel === collaborationInvokeChannels.createCollaborationInvitationHandoff ||
        channel === collaborationInvokeChannels.getCollaborationInvitationHandoff
      ) {
        return {
          ok: true,
          value: {
            invitation,
            invitationToken: `pw_inv_${"A".repeat(43)}`,
            handoff: `planweave-collaboration-invitation/v2:${JSON.stringify({
              endpoint: {
                topology: "private_https",
                serverOrigin: "https://planweave.example.ts.net/",
                allowedClientOrigins: ["https://planweave.example.ts.net/"],
                tlsTrust: "system_ca"
              },
              projectId: "project-1",
              invitationToken: `pw_inv_${"A".repeat(43)}`
            })}`
          }
        };
      }
      if (
        channel === collaborationInvokeChannels.getDesktopServerExposure ||
        channel === collaborationInvokeChannels.setDesktopServerExposureMode
      ) {
        return {
          mode: "private_https",
          topology: "private_https",
          provider: { id: "tailscale", displayName: "Tailscale" },
          lifecycle: "ready",
          advertisedOrigin: "https://planweave.example.ts.net/",
          errorCode: null,
          canActivate: true,
          canInvite: true
        };
      }
      if (channel === collaborationInvokeChannels.revokeCollaborationInvitation) {
        return { ok: true, value: { ...invitation, revokedAt: "2026-07-25T00:01:00.000Z" } };
      }
      if (channel === collaborationInvokeChannels.revokeCollaborationInvitations) {
        return { ok: true, value: { items: [] } };
      }
      if (
        channel === collaborationInvokeChannels.removeCollaborationMember ||
        channel === collaborationInvokeChannels.promoteCollaborationOwner ||
        channel === collaborationInvokeChannels.demoteCollaborationOwner ||
        channel === collaborationInvokeChannels.revokeCollaborationDevice
      ) {
        return { ok: true, value: undefined };
      }
      return status;
    });

    await import("../preload/preload");
    const api = electronMock.exposed.get("planweaveCollaboration") as PlanWeaveCollaborationApi;
    const callback = vi.fn();

    await api.getCollaborationStatus();
    await api.upsertCollaborationProfile({
      profileId: "profile-1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false
    });
    await api.removeCollaborationProfile({ profileId: "profile-1" });
    await api.setActiveCollaborationProfile({ profileId: "profile-1" });
    await api.clearActiveCollaborationProfile();
    await api.importDeviceCredential({
      profileId: "profile-1",
      deviceToken: `pw_hdev_${"A".repeat(43)}`
    });
    await api.clearDeviceCredential({ profileId: "profile-1" });
    await api.bootstrapCollaborationOwner({
      profileId: "profile-1",
      request: { displayName: "Owner" }
    });
    await api.consumeCollaborationInvitation({
      profileId: "profile-1",
      request: {
        invitationToken: `pw_inv_${"A".repeat(43)}`,
        displayName: "Member"
      }
    });
    await api.connectCollaborationSession({ profileId: "profile-1" });
    await api.disconnectCollaborationSession();
    await api.redeemCollaborationSetupCode({
      serverBaseUrl: "https://collab.example.com/",
      allowInsecureTransport: false,
      setupCode: `pw_setup_${"A".repeat(43)}`,
      displayName: "Demo"
    });
    await api.getActiveWorkspaceConnection();
    await api.listWorkspacePicker({ cursor: 0, limit: 20 });
    await api.selectWorkspaceConnection({ workspaceId: "workspace-1" });
    await api.connectWorkspaceConnection();
    await api.disconnectWorkspaceConnection();
    await api.retryWorkspaceConnection();
    await api.getCurrentCanvasAccess({ canvasId: "default" });
    await api.listCollaborationContentBootstrapCandidates();
    await api.bootstrapCollaborationContent({
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default"
    });
    await api.mutateCurrentCanvasAccess({
      canvasId: "default",
      request: {
        operation: "visibility",
        scope: {
          scopeKind: "canvas",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default"
        },
        expectedAclRevision: 1,
        visibility: "shared"
      }
    });
    await api.setCollaborationCurrentSelection({ projectId: "project-1", canvasId: "default" });
    await api.clearCollaborationCurrentSelection();
    await api.getLocalCollaborationServerStatus();
    await api.getLocalCollaborationScopeCatalog();
    await api.setLocalCollaborationTrustedScopes({
      scopes: [{ projectId: "project-1", canvasId: "default" }]
    });
    await api.startLocalCollaborationServer();
    await api.stopLocalCollaborationServer();
    await api.setLocalCollaborationLanSharing({ enabled: true });
    await api.getDesktopServerExposure();
    await api.setDesktopServerExposureMode({ mode: "private_https" });
    await api.listLocalCollaborationTrustedScopes();
    await api.registerLocalCollaborationCurrentProject({ ownerDisplayName: "Local owner" });
    await api.startCollaborationPresence({ canvasId: "default" });
    await api.publishCollaborationPresence({ pointer: { x: 1, y: 2 }, selectionIds: [] });
    await api.stopCollaborationPresence();
    await api.startCollaborationCanvasLiveSync({
      localProjectId: "project-1",
      canvasId: "default"
    });
    await api.stopCollaborationCanvasLiveSync();
    await api.flushCollaborationCanvasReplicaMaterialization();
    await api.listCollaborationMembers({ cursor: 0, limit: 20 });
    await api.updateOwnCollaborationDisplayName({ displayName: "Ada Lovelace" });
    await api.createCollaborationInvitation({});
    await api.createCollaborationInvitationHandoff({});
    await api.getCollaborationInvitationHandoff({ invitationId: "invitation-1" });
    await api.revokeCollaborationInvitation({ invitationId: "inv-1" });
    await api.revokeCollaborationInvitations({ invitationIds: ["inv-1", "inv-2"] });
    await api.removeCollaborationMember({ humanPrincipalId: "human-1" });
    await api.promoteCollaborationOwner({ humanPrincipalId: "human-2" });
    await api.demoteCollaborationOwner({ humanPrincipalId: "human-2" });
    await api.revokeCollaborationDevice({ deviceCredentialId: "device-1" });
    await api.listCollaborationAssignments({ cursor: 0, limit: 20 });
    await api.listCollaborationActivity({ limit: 20 });
    await api.readCollaborationCommentAttachment({
      commentId: "comment-1",
      digestSha256: "a".repeat(64)
    });
    const unsubscribe = api.onCollaborationStatusChanged(callback);
    const signalCallback = vi.fn();
    const unsubscribeSignal = api.onCollaborationObserverSignal(signalCallback);
    const presenceSignalCallback = vi.fn();
    const unsubscribePresenceSignal = api.onCollaborationPresenceSignal(presenceSignalCallback);
    const liveSyncSignalCallback = vi.fn();
    const unsubscribeLiveSyncSignal =
      api.onCollaborationCanvasLiveSyncSignal(liveSyncSignalCallback);

    expect(Object.keys(api).sort()).toEqual(
      [
        ...Object.keys(collaborationInvokeChannels),
        "onCollaborationStatusChanged",
        "onCollaborationObserverSignal",
        "onCollaborationPresenceSignal",
        "onCollaborationCanvasLiveSyncSignal",
        "onCollaborationCanvasReplicaSignal"
      ].sort()
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.getCollaborationStatus
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.upsertCollaborationProfile,
      expect.objectContaining({ profileId: "profile-1" })
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.importDeviceCredential,
      expect.objectContaining({ profileId: "profile-1" })
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.disconnectCollaborationSession
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.redeemCollaborationSetupCode,
      expect.objectContaining({ displayName: "Demo" })
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.selectWorkspaceConnection,
      { workspaceId: "workspace-1" }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.retryWorkspaceConnection
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.getCurrentCanvasAccess,
      { canvasId: "default" }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.listCollaborationContentBootstrapCandidates
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.bootstrapCollaborationContent,
      { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.mutateCurrentCanvasAccess,
      expect.objectContaining({
        canvasId: "default",
        request: expect.objectContaining({ operation: "visibility" })
      })
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.setCollaborationCurrentSelection,
      { projectId: "project-1", canvasId: "default" }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.clearCollaborationCurrentSelection
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.getLocalCollaborationServerStatus
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.getLocalCollaborationScopeCatalog
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.setLocalCollaborationTrustedScopes,
      { scopes: [{ projectId: "project-1", canvasId: "default" }] }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.startLocalCollaborationServer
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.stopLocalCollaborationServer
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.setLocalCollaborationLanSharing,
      { enabled: true }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.setDesktopServerExposureMode,
      { mode: "private_https" }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.createCollaborationInvitationHandoff,
      {}
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.listLocalCollaborationTrustedScopes
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.registerLocalCollaborationCurrentProject,
      { ownerDisplayName: "Local owner" }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.listCollaborationMembers,
      { cursor: 0, limit: 20 }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.updateOwnCollaborationDisplayName,
      { displayName: "Ada Lovelace" }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.readCollaborationCommentAttachment,
      { commentId: "comment-1", digestSha256: "a".repeat(64) }
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      collaborationInvokeChannels.flushCollaborationCanvasReplicaMaterialization
    );

    const statusCall = electronMock.ipcRenderer.on.mock.calls.find(
      (call) => call[0] === collaborationStatusChangedChannel
    ) as [string, IpcRendererListener] | undefined;
    expect(statusCall?.[0]).toBe(collaborationStatusChangedChannel);
    statusCall?.[1]({}, status);
    expect(callback).toHaveBeenCalledWith(status);
    unsubscribe();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(
      collaborationStatusChangedChannel,
      statusCall?.[1]
    );

    const signalCall = electronMock.ipcRenderer.on.mock.calls.find(
      (call) => call[0] === collaborationObserverSignalChannel
    ) as [string, IpcRendererListener] | undefined;
    expect(signalCall?.[0]).toBe(collaborationObserverSignalChannel);
    signalCall?.[1](
      {},
      {
        type: "human.observer.cursor",
        profileId: "profile-1",
        projectId: "project-1",
        cursor: 3
      }
    );
    expect(signalCallback).toHaveBeenCalledWith(
      expect.objectContaining({ type: "human.observer.cursor", cursor: 3 })
    );
    unsubscribeSignal();
    unsubscribePresenceSignal();
    unsubscribeLiveSyncSignal();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(
      collaborationObserverSignalChannel,
      signalCall?.[1]
    );
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
