// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { DesktopAutoRunState } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { graph as graphFixture } from "./helpers/graphFixtures";
import { project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import {
  autoRunState,
  cleanupAutoRunControlTestEnvironment,
  createTranslator,
  loadAutoRunControl,
  stubAutoRunControlBridge
} from "./helpers/autoRunControlHarness";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { collaborationCanvasBindingInputSchema } from "../shared/collaborationCanvasBinding";
import { collaborationInvokeChannels } from "../shared/collaborationIpc";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels";
import { workspaceCanvasSharingStateSchema } from "../shared/workspaceCanvasSharing";
import { runDurablePackageWrite } from "../renderer/collaboration/packageWriteAdapter";
import {
  useCollaborationRuntimeAvailability,
  type CollaborationRuntimeAvailabilityBridge
} from "../renderer/hooks/useCollaborationRuntimeAvailability";
import {
  type SharedCanvasCommandBridge,
  type SharedCanvasCommandsResult,
  useSharedCanvasCommands
} from "../renderer/hooks/useSharedCanvasCommands";

const translator = createTranslator("en");
const localBinding = {
  kind: "local" as const,
  localProjectId: "never-shared-local",
  canvasId: "default"
};
const remoteBinding = {
  kind: "remote" as const,
  workspaceId: "workspace-default",
  projectId: "remote-project",
  canvasId: "default"
};
const scope = {
  workspaceId: "workspace-default",
  projectId: "remote-project",
  canvasId: "default"
};
const graphWithBlock = {
  ...graphFixture,
  tasks: graphFixture.tasks.map((task) =>
    task.taskId === "T-ALPHA"
      ? {
          ...task,
          blocks: [
            {
              ref: "T-ALPHA#B-001",
              blockId: "B-001",
              type: "implementation" as const,
              title: "Alpha implementation",
              status: "ready" as const,
              executor: null,
              requiredCapabilities: [],
              promptMissing: false,
              exceptionReason: null,
              dispatchable: true,
              remoteExecution: null
            }
          ],
          blockPreview: []
        }
      : task
  )
};
const serverStatus = {
  schemaVersion: "canvas-runtime-status/v2" as const,
  scope,
  packageFingerprint: graphFixture.packageFingerprint,
  capturedAt: "2026-08-20T00:00:00.000Z",
  tasks: [
    { taskId: "T-ALPHA", status: "implemented" as const, openFeedbackCount: 0 },
    { taskId: "T-BETA", status: "ready" as const, openFeedbackCount: 0 }
  ],
  blocks: [
    {
      ref: "T-ALPHA#B-001",
      status: "completed" as const,
      completionReason: "submitted" as const,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: true
    }
  ]
};
const availableRuntime = {
  schemaVersion: "canvas-runtime-view/v1" as const,
  state: { kind: "initialized" as const, runtimeRevision: 1, status: serverStatus },
  execution: {
    schemaVersion: "canvas-runtime-availability/v1" as const,
    kind: "available" as const,
    status: serverStatus,
    sourceRevision: "src-revision-001",
    graphFingerprint: serverStatus.packageFingerprint
  }
};
const layoutIntent = {
  kind: "update_layout" as const,
  nodes: [{ nodeId: "T-ALPHA", x: 40, y: 80 }],
  updatedAt: "2026-08-03T00:00:00.000Z"
};

function commandBridge(
  overrides: Partial<SharedCanvasCommandBridge> = {}
): SharedCanvasCommandBridge {
  return {
    submitCollaborationCanvasCommand: vi.fn(),
    reconnectCollaborationCanvas: vi.fn(),
    bindCollaborationCanvasBindingSession: vi.fn(),
    getCollaborationCanvasCommandSession: vi.fn(),
    resolveCollaborationCanvasBindingScope: vi.fn().mockResolvedValue(null),
    onCollaborationObserverSignal: () => () => undefined,
    flushCollaborationCanvasReplicaMaterialization: vi.fn(),
    ...overrides
  };
}

function writeGate(
  patch: Partial<SharedCanvasCommandsResult> &
    Pick<SharedCanvasCommandsResult, "enabled" | "authorityMode">
): SharedCanvasCommandsResult {
  return {
    snapshot: {
      session: null,
      connectionPhase: "idle",
      lastError: null,
      lastStaleConflict: null,
      busy: false
    },
    projection: null,
    projectionStatus: null,
    offline: false,
    submit: vi.fn().mockResolvedValue({ ok: false, error: "not connected", staleConflict: null }),
    reconnect: vi.fn().mockResolvedValue(false),
    ...patch
  };
}

function runtimeApi(): CollaborationRuntimeAvailabilityBridge {
  return {
    getCollaborationStatus: vi.fn().mockRejectedValue(new Error("observer_status_unavailable")),
    resolveCollaborationCanvasBindingScope: vi.fn().mockResolvedValue(scope),
    readCollaborationCanvasBindingRuntimeAvailability: vi.fn().mockResolvedValue(availableRuntime)
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanupAutoRunControlTestEnvironment();
  cleanupRendererTestEnvironment();
});

describe("current Local vs Workspace canvas authority (characterization)", () => {
  it("keeps canvas identity as local|remote and still names published_outdated", () => {
    expect(
      collaborationCanvasBindingInputSchema.parse({
        kind: "local",
        localProjectId: "local-project",
        canvasId: "default"
      }).kind
    ).toBe("local");
    expect(
      collaborationCanvasBindingInputSchema.parse({
        kind: "remote",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default"
      }).kind
    ).toBe("remote");
    expect(() =>
      collaborationCanvasBindingInputSchema.parse({
        kind: "workspace",
        connectionProfileId: "profile-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default"
      })
    ).toThrow();
    expect(workspaceCanvasSharingStateSchema.parse("published_outdated")).toBe(
      "published_outdated"
    );
  });

  it("keeps local Runtime reset IPC separate from workspace Runtime reset IPC", () => {
    expect(desktopBridgeInvokeChannels.resetRuntimeState).toBe("planweave:resetRuntimeState");
    expect("resetRuntimeState" in collaborationInvokeChannels).toBe(false);
    expect(collaborationInvokeChannels.resetWorkspaceCanvasRuntime).toBe(
      "planweave-collaboration:resetWorkspaceCanvasRuntime"
    );
  });

  it("opens a never-shared Local Canvas through local snapshot IPC without Workspace Runtime queries", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    const collaboration = {
      setCollaborationCurrentSelection: vi.fn().mockResolvedValue(undefined),
      clearCollaborationCurrentSelection: vi.fn().mockResolvedValue(undefined),
      resolveCollaborationCanvasBindingScope: vi.fn(),
      readCollaborationCanvasBindingRuntimeAvailability: vi.fn()
    };
    vi.stubGlobal("planweave", bridge);
    vi.stubGlobal("planweaveCollaboration", collaboration);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const { result } = renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        t: translator,
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.selectedProject?.projectId).toBe(project.projectId));

    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
    expect(bridge.watchPackageFiles).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
    expect(collaboration.setCollaborationCurrentSelection).toHaveBeenCalledWith({
      projectId: project.projectId,
      canvasId: "canvas-main"
    });
    expect(collaboration.resolveCollaborationCanvasBindingScope).not.toHaveBeenCalled();
    expect(collaboration.readCollaborationCanvasBindingRuntimeAvailability).not.toHaveBeenCalled();
  });

  it("does not resolve shared scope or reconnect when a never-shared Local Canvas has no Server session", async () => {
    const api = commandBridge();
    const { result } = renderHook(() =>
      useSharedCanvasCommands({
        api,
        enabled: true,
        sessionConnected: false,
        binding: localBinding,
        profileId: null,
        activeProjectId: null,
        localOwnerDirectWriteAvailable: false,
        t: translator
      })
    );
    await settle();

    expect(api.resolveCollaborationCanvasBindingScope).not.toHaveBeenCalled();
    expect(api.bindCollaborationCanvasBindingSession).not.toHaveBeenCalled();
    expect(api.reconnectCollaborationCanvas).not.toHaveBeenCalled();
    expect(result.current.authorityMode).toBe("local");
    expect(result.current.enabled).toBe(false);
    await expect(result.current.reconnect()).resolves.toBe(false);
    await expect(result.current.submit({ intent: layoutIntent })).resolves.toMatchObject({
      ok: false
    });
    expect(api.submitCollaborationCanvasCommand).not.toHaveBeenCalled();
  });

  it("does not probe Server scope for a never-shared Local Canvas even when a Server session is connected", async () => {
    const api = commandBridge({
      resolveCollaborationCanvasBindingScope: vi.fn().mockResolvedValue(null)
    });
    const { result } = renderHook(() =>
      useSharedCanvasCommands({
        api,
        enabled: true,
        sessionConnected: true,
        binding: localBinding,
        profileId: "profile-1",
        activeProjectId: "tiny-notes",
        localOwnerDirectWriteAvailable: false,
        t: translator
      })
    );
    await settle();

    expect(api.resolveCollaborationCanvasBindingScope).not.toHaveBeenCalled();
    expect(result.current.authorityMode).toBe("local");
    expect(result.current.enabled).toBe(false);
    expect(api.bindCollaborationCanvasBindingSession).not.toHaveBeenCalled();
    expect(api.reconnectCollaborationCanvas).not.toHaveBeenCalled();
  });

  it("routes never-shared Local edits to the local writer and Workspace edits to canvas commands", async () => {
    const localWrite = vi.fn().mockResolvedValue(undefined);
    const sharedSubmit = vi.fn().mockResolvedValue({ ok: true, error: null, staleConflict: null });

    await expect(
      runDurablePackageWrite({
        sharedCanvas: writeGate({ enabled: false, authorityMode: "local", submit: sharedSubmit }),
        intent: layoutIntent,
        localWrite
      })
    ).resolves.toBe("local");
    expect(localWrite).toHaveBeenCalledTimes(1);
    expect(sharedSubmit).not.toHaveBeenCalled();

    localWrite.mockClear();
    await expect(
      runDurablePackageWrite({
        sharedCanvas: writeGate({ enabled: true, authorityMode: "shared", submit: sharedSubmit }),
        intent: layoutIntent,
        localWrite
      })
    ).resolves.toBe("shared");
    expect(localWrite).not.toHaveBeenCalled();
    expect(sharedSubmit).toHaveBeenCalledWith({ intent: layoutIntent });
  });

  it("overlays Server node status and routes Workspace reset without local Runtime IPC", async () => {
    const api = runtimeApi();
    const { result: runtime } = renderHook(() =>
      useCollaborationRuntimeAvailability({
        enabled: true,
        sessionConnected: true,
        profileId: "profile-1",
        activeProjectId: "remote-project",
        binding: remoteBinding,
        graph: graphWithBlock,
        api
      })
    );
    await settle();

    expect(runtime.current.availability).toEqual({ kind: "available" });
    expect(runtime.current.graph?.tasks[0]?.status).toBe("implemented");
    expect(runtime.current.graph?.tasks[0]?.blocks[0]?.status).toBe("completed");
    expect(graphWithBlock.tasks[0]?.status).toBe("ready");

    const resetRuntimeState = vi.fn().mockResolvedValue({
      session: { sessionId: "SESSION-0001" },
      stoppedAutoRunIds: []
    });
    const desktopBridge = createDesktopBridgeMock({ resetRuntimeState });
    const resetWorkspaceRuntime = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    stubAutoRunControlBridge(desktopBridge);
    const { useAutoRunControl } = await loadAutoRunControl();
    const { result: autoRun } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(
        autoRunState({ phase: "manual" })
      );
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        openRunWorkspace: vi.fn(),
        runtimeAvailability: { kind: "available" },
        selectedCanvasId: "default",
        selectedBlock: null,
        selectedProject: null,
        canvasLocator: {
          kind: "workspace",
          connectionProfileId: "profile-1",
          ...scope
        },
        resetWorkspaceRuntime,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: translator,
        tmuxMonitoringEnabled: false
      });
    });

    await act(async () => {
      await autoRun.current.resetRuntimeStateClick();
    });

    expect(confirm).toHaveBeenCalled();
    expect(resetWorkspaceRuntime).toHaveBeenCalledTimes(1);
    expect(resetRuntimeState).not.toHaveBeenCalled();
    expect(autoRun.current.autoRunState).toBeNull();
    expect(runtime.current.graph?.tasks[0]?.status).toBe("implemented");
    expect(api.readCollaborationCanvasBindingRuntimeAvailability).toHaveBeenCalled();
  });

  it("does not treat a missing local project as authority for Workspace reset", async () => {
    const resetRuntimeState = vi.fn();
    const resetWorkspaceRuntime = vi.fn().mockResolvedValue(undefined);
    stubAutoRunControlBridge(createDesktopBridgeMock({ resetRuntimeState }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { useAutoRunControl } = await loadAutoRunControl();
    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: autoRunState({ phase: "manual" }),
        openRunWorkspace: vi.fn(),
        runtimeAvailability: { kind: "available" },
        selectedCanvasId: "default",
        selectedBlock: null,
        selectedProject: null,
        canvasLocator: {
          kind: "workspace",
          connectionProfileId: "profile-1",
          ...scope
        },
        resetWorkspaceRuntime,
        selectedTaskPanelId: null,
        setAutoRunState: vi.fn(),
        setError: vi.fn(),
        t: translator,
        tmuxMonitoringEnabled: false
      })
    );

    await act(async () => {
      await result.current.resetRuntimeStateClick();
    });

    expect(confirm).toHaveBeenCalled();
    expect(resetWorkspaceRuntime).toHaveBeenCalledTimes(1);
    expect(resetRuntimeState).not.toHaveBeenCalled();
  });
});
