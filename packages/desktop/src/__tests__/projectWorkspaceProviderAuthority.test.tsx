// @vitest-environment jsdom

import type { CollaborationStatus } from "../shared/collaboration";
import { activeWorkspaceConnectionViewSchema } from "@planweave-ai/collaboration-protocol/connection";
import { ReactFlowProvider } from "@xyflow/react";
import { TaskNodeCard } from "../renderer/graph/TaskNodeCard";
import type { AppFlowNode } from "../renderer/types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graph } from "./helpers/graphFixtures";
import type { WorkspaceCanvasProjectionSignal } from "../shared/workspaceCanvasProjection";
import { project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import {
  ProjectWorkspaceProvider,
  useProjectWorkspace,
  type ProjectWorkspaceValue
} from "../renderer/ProjectWorkspaceProvider";
import { createTranslator } from "../renderer/i18n";
import { mergeDesktopSettings } from "../renderer/settings";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import type { ProjectWorkspaceShellInput } from "../renderer/projectWorkspaceShell";
import type { AppView, DesktopSettingsUpdate, DesktopUiSettings } from "../renderer/types";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator";
import { collaborationRemoteCanvasReplicaProjectionSchema } from "../shared/canvasReplicaIpc";

const stableSurface = vi.hoisted(() => ({
  snapshot: { commentsByWorkItem: {}, commentInvalidationVersionByWorkItem: {}, mutationsById: {} },
  index: { byWorkItemKey: {}, syncPhase: "idle", surfaceActive: false },
  emptyMap: {},
  selectedEndpointId: () => "__custom",
  endpoints: []
}));
const bridges = vi.hoisted(() => {
  function bridgeProxy() {
    const target: Record<PropertyKey, unknown> = {};
    const proxy = new Proxy(target, {
      get(current, property) {
        if (!(property in current)) {
          current[property] =
            typeof property === "string" && property.startsWith("on")
              ? vi.fn(() => () => undefined)
              : vi.fn().mockResolvedValue(null);
        }
        return current[property];
      }
    });
    return { proxy, target };
  }
  const status: { current: CollaborationStatus | null } = { current: null };
  return {
    collaboration: bridgeProxy(),
    desktop: bridgeProxy(),
    status
  };
});

vi.mock("../renderer/bridge", async () => {
  const actual = await vi.importActual<typeof import("../renderer/bridge")>("../renderer/bridge");
  return {
    ...actual,
    bridge: bridges.desktop.proxy,
    collaborationBridge: bridges.collaboration.proxy,
    operatorControlBridge: null
  };
});

vi.mock("../renderer/hooks/useCollaborationStatus", () => ({
  useCollaborationStatus: () => ({
    status: bridges.status.current,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined)
  })
}));

vi.mock("../renderer/hooks/useCollaborationSurface", () => ({
  useCollaborationSurface: () => ({
    status: bridges.status.current,
    snapshot: stableSurface.snapshot,
    viewModel: null,
    controller: null,
    assigneeIndex: stableSurface.index,
    activeProfileId: bridges.status.current?.activeProfileId ?? null,
    activeProjectId: bridges.status.current?.profiles[0]?.projectId ?? null,
    sessionConnected: bridges.status.current?.session.phase === "connected",
    localOwnerDirectWriteAvailable: false,
    collaborationNotificationDrafts: []
  })
}));

vi.mock("../renderer/hooks/useOwnerControlPlaneAvailability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../renderer/hooks/useOwnerControlPlaneAvailability")>()),
  useOwnerControlPlaneAvailability: () => ({
    fleetCatalogEnabled: true,
    operatorProfileId: "profile-remote-owner",
    fleetCatalogBlockedCode: null,
    status: null,
    refresh: vi.fn().mockResolvedValue(undefined)
  })
}));

const stubs = vi.hoisted(() => {
  const sync = vi.fn();
  const asyncCall = vi.fn().mockResolvedValue(undefined);
  return { asyncCall, sync };
});
const endpointCatalogProbe = vi.hoisted(() => ({ input: null as unknown }));

vi.mock("../renderer/hooks/useLerpedNodeDrag", () => ({
  useLerpedNodeDrag: () => ({ commitDragTargets: () => [], onNodesChange: stubs.sync })
}));
vi.mock("../renderer/hooks/useWorkspaceAgentEndpointCatalog", () => ({
  useWorkspaceAgentEndpointCatalog: (input: unknown) => {
    endpointCatalogProbe.input = input;
    return {
      endpoints: stableSurface.endpoints,
      errorCode: null,
      savePreference: stubs.asyncCall
    };
  }
}));
vi.mock("../renderer/hooks/useSelectedBlock", () => ({
  useSelectedBlock: () => ({
    clearSelectedBlockRecords: stubs.sync,
    handleBlockSelect: stubs.sync,
    handleOpenRunRecord: stubs.sync,
    restoreBlockSelection: stubs.asyncCall,
    saveSelectedBlockPrompt: stubs.asyncCall,
    saveSelectedBlockTitle: stubs.asyncCall,
    selectedBlock: null,
    setSelectedBlock: stubs.sync,
    setSelectedRunRecord: stubs.sync
  })
}));
vi.mock("../renderer/hooks/useDesktopProjectSession", () => ({
  useDesktopProjectSession: ({ projectState }: { projectState: { loadProject: unknown } }) => ({
    autoRunDiagnostics: [],
    autoRunState: null,
    clearTaskPanelSelection: stubs.sync,
    createProjectFromTaskCanvas: stubs.asyncCall,
    createTaskCanvas: stubs.asyncCall,
    deleteTaskCanvas: stubs.asyncCall,
    duplicateTaskCanvas: stubs.asyncCall,
    openBlockInspector: stubs.sync,
    openProject: projectState.loadProject,
    openTaskInspector: stubs.sync,
    renameTaskCanvas: stubs.asyncCall,
    reloadCurrentCanvas: stubs.asyncCall,
    restoreTaskPanelSelection: stubs.sync,
    selectedTaskPanelId: null,
    selectTaskPanel: stubs.sync,
    setAutoRunState: stubs.sync,
    taskFocusRequest: null
  })
}));
vi.mock("../renderer/task-workspace/useTaskWorkspaceGraphNavigation", () => ({
  useTaskWorkspaceGraphNavigation: () => ({
    openBlockWorkspace: stubs.sync,
    openRunWorkspace: stubs.sync,
    openTaskInspector: stubs.sync,
    openTaskWorkspace: stubs.sync
  })
}));
vi.mock("../renderer/task-workspace/useTaskWorkspaceController", () => ({
  useTaskWorkspaceController: () => ({})
}));
vi.mock("../renderer/hooks/useWorkspaceAgentEndpointRun", () => ({
  useWorkspaceAgentEndpointRun: () => stubs.asyncCall
}));
vi.mock("../renderer/controllers/AutoRunController", () => ({
  useAutoRunController: () => ({ startAutoRunWithScope: stubs.asyncCall }),
  useFileSyncController: () => ({
    fileSyncDiagnostics: [],
    lastFileChange: null
  })
}));
vi.mock("../renderer/hooks/useTaskNodeFocus", () => ({ useTaskNodeFocus: stubs.sync }));
vi.mock("../renderer/controllers/SearchController", () => ({
  useSearchController: () => ({
    diagnostics: [],
    searchQuery: "",
    searchCanvasScope: null,
    selectedSearchResultKinds: [],
    searchResults: []
  })
}));
vi.mock("../renderer/hooks/useCollaborationCanvasPresence", () => ({
  useCollaborationCanvasPresence: () => ({})
}));
vi.mock("../renderer/task-workspace/useRecordWorkspaceNavigation", () => ({
  useRecordWorkspaceNavigation: () => stubs.asyncCall
}));
vi.mock("../renderer/hooks/useReviewPipeline", () => ({
  useReviewPipeline: () => ({
    addReviewStep: stubs.sync,
    clearReviewTaskSelection: stubs.sync,
    moveReviewStep: stubs.sync,
    removeReviewStep: stubs.sync,
    reviewDefaultCyclesDraft: 1,
    reviewDraft: null,
    reviewPipeline: null,
    reviewTaskId: null,
    saveReviewPipeline: stubs.asyncCall,
    setReviewDefaultCyclesDraft: stubs.sync,
    setReviewTaskId: stubs.sync,
    updateReviewStep: stubs.sync
  })
}));
vi.mock("../renderer/hooks/useGraphDeleteActions", () => ({
  useGraphDeleteActions: () => ({
    handleDeleteBlock: stubs.asyncCall,
    handleDeleteTaskNode: stubs.asyncCall
  })
}));
vi.mock("../renderer/hooks/usePromptDrafts", () => ({
  usePromptDrafts: () => ({
    applyLocalPromptConflicts: stubs.asyncCall,
    handlePromptChange: stubs.sync,
    handlePromptSave: stubs.asyncCall,
    handleTitleChange: stubs.sync,
    handleTitleSave: stubs.asyncCall,
    keepLocalPromptConflicts: stubs.sync,
    promptDrafts: stableSurface.emptyMap,
    promptConflicts: [],
    reloadPromptConflicts: stubs.asyncCall,
    saveStates: stableSurface.emptyMap,
    titleDrafts: stableSurface.emptyMap
  })
}));
vi.mock("../renderer/hooks/useSharedResourceHighlight", () => ({
  useSharedResourceHighlight: () => ({
    activeResource: null,
    pinnedResource: null,
    transitionEpochByResource: stableSurface.emptyMap,
    onResourceHover: stubs.sync,
    onResourcePin: stubs.sync,
    clearPin: stubs.sync,
    setPinnedResource: stubs.sync
  })
}));
vi.mock("../renderer/hooks/useTaskExecutorActions", () => ({
  useTaskExecutorActions: () => ({ handleTaskExecutorChange: stubs.asyncCall })
}));
vi.mock("../renderer/hooks/useTaskAgentEndpointSelection", () => ({
  useTaskAgentEndpointSelection: () => ({
    selectedEndpointId: stableSurface.selectedEndpointId,
    changeEndpoint: stubs.asyncCall
  })
}));
vi.mock("../renderer/hooks/useDesktopProjectActions", () => ({
  useDesktopProjectActions: () => ({
    handleBindSourceRoot: stubs.asyncCall,
    handleCopyCanvasToNewProject: stubs.asyncCall,
    handleDeleteProject: stubs.asyncCall,
    handleDeleteTaskCanvas: stubs.asyncCall,
    handleDuplicateTaskCanvas: stubs.asyncCall,
    handleDropSourceRoot: stubs.asyncCall,
    handleProjectNewGraph: stubs.asyncCall,
    handleRenameProject: stubs.asyncCall,
    handleRevealPathInFinder: stubs.asyncCall,
    handleRevealPlanWorkspace: stubs.asyncCall,
    handleRevealProject: stubs.asyncCall,
    handleRevealSourceRoot: stubs.asyncCall,
    handleRevealTaskCanvas: stubs.asyncCall,
    handleRenameTaskCanvas: stubs.asyncCall,
    handleUnlinkSourceRoot: stubs.asyncCall
  })
}));
vi.mock("../renderer/hooks/useGraphHistoryActions", () => ({
  useGraphHistoryActions: () => ({
    handleRedoGraph: stubs.asyncCall,
    handleUndoGraph: stubs.asyncCall
  })
}));

vi.mock("../renderer/hooks/useGraphPaletteActions", () => ({
  useGraphPaletteActions: () => ({
    addPaletteComponent: stubs.asyncCall,
    handleConnect: stubs.asyncCall,
    handleEdgesDelete: stubs.asyncCall,
    handleReconnectEdge: stubs.asyncCall,
    handleGraphDragOver: stubs.sync,
    handleGraphDrop: stubs.asyncCall,
    handleNodeDragStop: stubs.asyncCall,
    handlePaletteDragStart: stubs.sync,
    resetLayout: stubs.asyncCall
  })
}));
vi.mock("../renderer/AppSettingsRouteProps", () => ({ buildAppSettingsRouteProps: () => ({}) }));
vi.mock("../renderer/controllers/GraphWorkspaceController", () => ({
  useGraphWorkspaceController: (input: {
    graph: unknown;
    nodes: AppFlowNode[];
    runtimeAvailability: unknown;
    workspaceCanvasOffline: boolean;
    workspaceCanvasRevision: number | null;
  }) => ({
    graph: input.graph,
    nodes: input.nodes,
    runtimeAvailability: input.runtimeAvailability,
    workspaceCanvasOffline: input.workspaceCanvasOffline,
    workspaceCanvasRevision: input.workspaceCanvasRevision
  })
}));

const locator: WorkspaceCanvasLocator = {
  kind: "workspace",
  connectionProfileId: "profile-offline",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};

function connectedWorkspaceStatus(): CollaborationStatus {
  const serverBaseUrl = "https://workspace.example.test/";
  const credentialRevision = "workspace-credential-1";
  const updatedAt = "2026-08-22T00:00:00.000Z";
  return {
    activeProfileId: locator.connectionProfileId,
    profiles: [
      {
        profileId: locator.connectionProfileId,
        displayName: "Workspace owner",
        serverBaseUrl,
        projectId: locator.projectId,
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        credentialRevision,
        humanPrincipalId: "human-1",
        updatedAt,
        endpoint: {
          topology: "public_https",
          serverOrigin: serverBaseUrl,
          allowedClientOrigins: [serverBaseUrl],
          tlsTrust: "system_ca"
        },
        connectionState: "ready"
      }
    ],
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connected",
      activeProfileId: locator.connectionProfileId,
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    workspaceConnection: activeWorkspaceConnectionViewSchema.parse({
      schemaVersion: "workspace-setup/v1",
      status: "connected",
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: locator.connectionProfileId,
        displayName: "Workspace owner",
        serverBaseUrl,
        workspaceId: locator.workspaceId,
        allowInsecureTransport: false
      },
      workspaceId: locator.workspaceId,
      workspaceDisplayName: "Workspace",
      connectedAt: updatedAt,
      credentialRevision,
      error: null
    }),
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
    identityRepair: null,
    updatedAt
  };
}

function cachedProjection() {
  return collaborationRemoteCanvasReplicaProjectionSchema.parse({
    authorityId: "profile-offline\u0000https://workspace.example.test\u0000project-1",
    bindingKind: "remote",
    workspaceId: locator.workspaceId,
    projectId: locator.projectId,
    canvasId: locator.canvasId,
    revision: 4,
    contentDigest: "a".repeat(64),
    canEdit: false,
    optimisticOperationIds: [],
    rejections: [],
    content: {
      projectTitle: "Cached Workspace",
      graphVersion: "1",
      packageFingerprint: `pkg-${"b".repeat(64)}`,
      tasks: [],
      edges: [],
      sharedResourceGroups: [],
      diagnostics: [],
      layout: {
        version: "desktop-layout/v1",
        projectId: locator.projectId,
        nodes: [],
        updatedAt: "2026-08-22T00:00:00.000Z"
      },
      blockDependenciesByRef: {},
      taskOpenFeedbackCountByTaskId: {},
      blockPromptMarkdownByRef: {}
    }
  });
}

function Probe({
  onValue,
  showGraph
}: {
  onValue: (value: ProjectWorkspaceValue) => void;
  showGraph?: boolean;
}) {
  const value = useProjectWorkspace();
  useEffect(() => onValue(value), [onValue, value]);
  return showGraph ? (
    <ReactFlowProvider>
      {value.graphWorkspace.nodes
        .filter((node) => node.type === "task")
        .map((node) => (
          <TaskNodeCard
            key={node.id}
            id={node.id}
            data={node.data}
            type="task"
            selected={false}
            dragging={false}
            isConnectable={false}
            zIndex={0}
            positionAbsoluteX={0}
            positionAbsoluteY={0}
            draggable={false}
            selectable={false}
            deletable={false}
          />
        ))}
    </ReactFlowProvider>
  ) : null;
}

function ProviderHarness({
  initialSettings,
  onError,
  onSettings,
  onValue,
  showGraph
}: {
  showGraph?: boolean;
  initialSettings: DesktopUiSettings;
  onError?: ProjectWorkspaceShellInput["setError"];
  onSettings: (settings: DesktopUiSettings) => void;
  onValue: (value: ProjectWorkspaceValue) => void;
}) {
  const [activeView, setActiveView] = useState<AppView>("graph");
  const [settings, setSettings] = useState(initialSettings);
  const updateSettings = useCallback((update: DesktopSettingsUpdate) => {
    setSettings((current) =>
      mergeDesktopSettings(current, typeof update === "function" ? update(current) : update)
    );
  }, []);
  useEffect(() => onSettings(settings), [onSettings, settings]);
  const shell = useMemo<ProjectWorkspaceShellInput>(
    () => ({
      activeView,
      appHistory: {
        graphSnapshot: null,
        historyError: null,
        historyIndex: 0,
        openTaskWorkspace: vi.fn(),
        replaceTaskWorkspaceTarget: vi.fn(),
        returnToTaskWorkspaceSource: vi.fn(),
        route: { view: "graph" },
        taskWorkspaceNavigation: null
      },
      agentDetectionRefreshing: false,
      agentDetections: [],
      globalPromptMarkdown: null,
      language: "en",
      refreshAgentDetections: vi.fn().mockResolvedValue(undefined),
      refreshRuntimeTools: vi.fn().mockResolvedValue(undefined),
      runtimeTools: { tmux: { available: false, command: "tmux" } },
      setActiveView,
      setError: onError ?? stubs.sync,
      setSuccessMessage: stubs.sync,
      settings,
      settingsHydrated: true,
      t: createTranslator("en"),
      updateLayoutSettings: vi.fn(),
      updateGlobalPrompt: vi.fn().mockResolvedValue(true),
      updateSettings,
      updateSettingsAndWait: async (update) => updateSettings(update)
    }),
    [activeView, onError, settings, updateSettings]
  );
  return (
    <ProjectWorkspaceProvider shell={shell}>
      <Probe onValue={onValue} showGraph={showGraph} />
    </ProjectWorkspaceProvider>
  );
}

function workspaceSettings(): DesktopUiSettings {
  return {
    ...defaultDesktopSettings,
    language: "en",
    runtimePath: project.workspaceRoot,
    lastOpenedWorkspaceLocator: locator
  };
}

beforeEach(() => {
  bridges.status.current = null;
  endpointCatalogProbe.input = null;
  for (const target of [bridges.desktop.target, bridges.collaboration.target]) {
    for (const key of Reflect.ownKeys(target)) Reflect.deleteProperty(target, key);
  }
  bridges.desktop.target.listProjects = vi.fn().mockResolvedValue([project]);
  bridges.desktop.target.getDesktopProjectSnapshot = vi.fn().mockResolvedValue(projectSnapshot());
  bridges.desktop.target.getDesktopGraphDiagnostics = vi.fn().mockResolvedValue({
    graphQuality: { ok: true, diagnostics: [] },
    executionReadiness: { ok: true, diagnostics: [] },
    diagnostics: []
  });
  bridges.desktop.target.refreshPackageFileChanges = vi
    .fn()
    .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] });
  bridges.desktop.target.watchPackageFiles = vi.fn().mockResolvedValue(undefined);
  bridges.collaboration.target.onWorkspaceCanvasProjectionSignal = vi.fn(() => () => undefined);
  bridges.collaboration.target.closeWorkspaceCanvasSession = vi.fn().mockResolvedValue(undefined);
  bridges.collaboration.target.onCollaborationObserverSignal = vi.fn(() => () => undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectWorkspaceProvider startup authority", () => {
  it.each([
    null,
    "unrelated_operation_failure"
  ])("retires only its own Canvas error and preserves %s", async (unrelatedError) => {
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn(async (requested) => {
      if (requested.canvasId === locator.canvasId) throw new Error("current_canvas_failure");
      return {
        locator: requested,
        status: "accepted",
        authorityMode: "offline_cache_readonly",
        readOnly: true,
        cachedAt: "2026-08-22T00:00:00.000Z",
        conflict: null,
        rejectCode: null,
        replica: { ...cachedProjection(), canvasId: requested.canvasId }
      };
    });
    let error: string | null = null;
    const onError: ProjectWorkspaceShellInput["setError"] = (update) => {
      error = typeof update === "function" ? update(error) : update;
    };
    let current: ProjectWorkspaceValue | null = null;
    render(
      <ProviderHarness
        initialSettings={workspaceSettings()}
        onError={onError}
        onSettings={vi.fn()}
        onValue={(value) => {
          current = value;
        }}
      />
    );
    await waitFor(() => expect(error).toBe("current_canvas_failure"));
    if (unrelatedError) error = unrelatedError;
    act(() => current!.shell.openWorkspaceCanvasLocator({ ...locator, canvasId: "canvas-next" }));
    await waitFor(() =>
      expect(current?.graphWorkspace.graph?.projectTitle).toBe("Cached Workspace")
    );
    expect(error).toBe(unrelatedError);
  });

  it.each([
    false,
    true
  ])("shows Task and Block comment entry points on a Workspace canvas without a Local selection (connected=%s)", async (connected) => {
    const replica = cachedProjection();
    const task = graph.tasks[0]!;
    const block = {
      ref: `${task.taskId}#B-001`,
      blockId: "B-001",
      type: "implementation" as const,
      title: "Implementation",
      status: "ready" as const,
      executor: null,
      requiredCapabilities: [],
      promptMissing: false,
      exceptionReason: null,
      dispatchable: false,
      remoteExecution: null
    };
    replica.content.tasks = [{ ...task, blocks: [block], blockPreview: [block] }];
    if (connected) {
      bridges.status.current = connectedWorkspaceStatus();
      bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
        .fn()
        .mockResolvedValue({ items: [], nextCursor: null });
      bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi.fn().mockResolvedValue({
        items: [
          {
            registry: {
              workspaceId: locator.workspaceId,
              projectId: locator.projectId,
              canvasId: locator.canvasId
            }
          }
        ],
        nextCursor: null
      });
    }
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue({
      locator,
      status: "accepted",
      authorityMode: connected ? "server_authoritative" : "offline_cache_readonly",
      readOnly: !connected,
      cachedAt: "2026-08-22T00:00:00.000Z",
      conflict: null,
      rejectCode: null,
      replica
    });
    render(
      <ProviderHarness
        initialSettings={workspaceSettings()}
        onSettings={vi.fn()}
        onValue={vi.fn()}
        showGraph
      />
    );
    await screen.findByDisplayValue(task.title);
    const commentTriggers = screen.getAllByTestId("work-item-comments-trigger");
    expect(commentTriggers).toHaveLength(2);
    fireEvent.click(commentTriggers[0]!);
    await screen.findByTestId("work-item-comments-popover");
    expect(
      screen.getByTestId("work-item-collaboration-panel").getAttribute("data-work-item-kind")
    ).toBe("task");
    expect(bridges.desktop.target.getDesktopProjectSnapshot).not.toHaveBeenCalled();
  });

  it("keeps a persisted Workspace cache authoritative after the Local project list resolves", async () => {
    const replica = cachedProjection();
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue({
      locator,
      status: "accepted",
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      cachedAt: "2026-08-22T00:00:00.000Z",
      conflict: null,
      rejectCode: null,
      replica
    });
    let current: ProjectWorkspaceValue | null = null;
    render(
      <ProviderHarness
        initialSettings={workspaceSettings()}
        onSettings={vi.fn()}
        onValue={(value) => {
          current = value;
        }}
      />
    );

    await waitFor(() =>
      expect(current?.graphWorkspace.graph?.projectTitle).toBe("Cached Workspace")
    );
    expect(current?.graphWorkspace.workspaceCanvasOffline).toBe(true);
    expect(current?.graphWorkspace.runtimeAvailability).toEqual({
      kind: "checking"
    });
    expect(bridges.desktop.target.listProjects).toHaveBeenCalled();
    expect(bridges.desktop.target.getDesktopProjectSnapshot).not.toHaveBeenCalled();
    expect(bridges.collaboration.target.openWorkspaceCanvasSession).toHaveBeenCalledWith(locator);
    expect(Reflect.has(bridges.collaboration.target, "submitWorkspaceCanvasCommand")).toBe(false);
  });

  it("keeps the remote identity and surfaces a missing-cache error without Local fallback", async () => {
    bridges.collaboration.target.openWorkspaceCanvasSession = vi
      .fn()
      .mockRejectedValue(new Error("workspace_canvas_offline_cache_unavailable"));
    const onError = vi.fn();
    let current: ProjectWorkspaceValue | null = null;
    let settings = workspaceSettings();
    render(
      <ProviderHarness
        initialSettings={settings}
        onError={onError}
        onSettings={(next) => {
          settings = next;
        }}
        onValue={(value) => {
          current = value;
        }}
      />
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("workspace_canvas_offline_cache_unavailable")
    );
    expect(settings.lastOpenedWorkspaceLocator).toEqual(locator);
    expect(current?.graphWorkspace.graph).toBeNull();
    expect(bridges.desktop.target.getDesktopProjectSnapshot).not.toHaveBeenCalled();
  });

  it("replaces the persisted Workspace authority when the user explicitly opens Local", async () => {
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue({
      locator,
      status: "accepted",
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      cachedAt: "2026-08-22T00:00:00.000Z",
      conflict: null,
      rejectCode: null,
      replica: cachedProjection()
    });
    let current: ProjectWorkspaceValue | null = null;
    let settings = workspaceSettings();
    const onSettings = (next: DesktopUiSettings) => {
      settings = next;
    };
    const mounted = render(
      <ProviderHarness
        initialSettings={settings}
        onSettings={onSettings}
        onValue={(value) => {
          current = value;
        }}
      />
    );
    await waitFor(() => expect(current?.graphWorkspace.workspaceCanvasOffline).toBe(true));

    await act(async () => {
      await current?.shell.loadProject(project, "canvas-main");
    });
    await waitFor(() => expect(settings.lastOpenedWorkspaceLocator).toBeNull());
    expect(bridges.desktop.target.getDesktopProjectSnapshot).toHaveBeenCalled();

    mounted.unmount();
    vi.mocked(bridges.desktop.target.getDesktopProjectSnapshot).mockClear();
    vi.mocked(bridges.collaboration.target.openWorkspaceCanvasSession).mockClear();
    render(
      <ProviderHarness
        initialSettings={settings}
        onSettings={onSettings}
        onValue={(value) => {
          current = value;
        }}
      />
    );
    await waitFor(() =>
      expect(bridges.desktop.target.getDesktopProjectSnapshot).toHaveBeenCalled()
    );
    expect(bridges.collaboration.target.openWorkspaceCanvasSession).not.toHaveBeenCalled();
  });

  it("drops a revoked cached locator after reconnect authorization completes", async () => {
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue({
      locator,
      status: "accepted",
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      cachedAt: "2026-08-22T00:00:00.000Z",
      conflict: null,
      rejectCode: null,
      replica: cachedProjection()
    });
    bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    let current: ProjectWorkspaceValue | null = null;
    let settings = workspaceSettings();
    const props = {
      initialSettings: settings,
      onSettings: (next: DesktopUiSettings) => {
        settings = next;
      },
      onValue: (value: ProjectWorkspaceValue) => {
        current = value;
      }
    };
    const mounted = render(<ProviderHarness {...props} />);
    await waitFor(() => expect(current?.graphWorkspace.workspaceCanvasOffline).toBe(true));

    bridges.status.current = connectedWorkspaceStatus();
    mounted.rerender(<ProviderHarness {...props} />);

    await waitFor(() => expect(settings.lastOpenedWorkspaceLocator).toBeNull());
    await waitFor(() => expect(current?.graphWorkspace.graph).toBeNull());
    expect(bridges.desktop.target.getDesktopProjectSnapshot).not.toHaveBeenCalled();
  });

  it("keeps normal Local startup when no Workspace authority is persisted", async () => {
    let current: ProjectWorkspaceValue | null = null;
    render(
      <ProviderHarness
        initialSettings={{
          ...workspaceSettings(),
          lastOpenedWorkspaceLocator: null
        }}
        onSettings={vi.fn()}
        onValue={(value) => {
          current = value;
        }}
      />
    );

    await waitFor(() =>
      expect(bridges.desktop.target.getDesktopProjectSnapshot).toHaveBeenCalled()
    );
    await waitFor(() => expect(current?.shell.selectedProject?.projectId).toBe(project.projectId));
    expect(Reflect.has(bridges.collaboration.target, "openWorkspaceCanvasSession")).toBe(false);
  });

  it("loads the Local canvas endpoint catalog with the graph authority project id", async () => {
    bridges.desktop.target.getDesktopProjectSnapshot = vi.fn().mockResolvedValue(
      projectSnapshot({
        graph: { ...projectSnapshot().graph, projectId: "authority-project-1" }
      })
    );

    render(
      <ProviderHarness
        initialSettings={{ ...workspaceSettings(), lastOpenedWorkspaceLocator: null }}
        onSettings={vi.fn()}
        onValue={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(endpointCatalogProbe.input).toMatchObject({
        locator: { projectId: "authority-project-1", canvasId: "canvas-main" },
        enabled: true,
        operatorProfileId: "profile-remote-owner",
        fleetCatalogBlockedCode: null
      })
    );
  });

  it("refreshes the Server-authorized canvas catalog with the Local project catalog", async () => {
    bridges.status.current = connectedWorkspaceStatus();
    bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    let current: ProjectWorkspaceValue | null = null;
    render(
      <ProviderHarness
        initialSettings={{ ...workspaceSettings(), lastOpenedWorkspaceLocator: null }}
        onSettings={vi.fn()}
        onValue={(value) => {
          current = value;
        }}
      />
    );

    await waitFor(() =>
      expect(
        bridges.collaboration.target.listCollaborationAuthorizedCanvases
      ).toHaveBeenCalledOnce()
    );
    vi.mocked(bridges.desktop.target.listProjects).mockClear();
    vi.mocked(bridges.collaboration.target.listCollaborationAuthorizedProjects).mockClear();
    vi.mocked(bridges.collaboration.target.listCollaborationAuthorizedCanvases).mockClear();

    await act(async () => {
      await current?.projectSidebar.handleRefreshProjects();
    });

    expect(bridges.desktop.target.listProjects).toHaveBeenCalledOnce();
    expect(bridges.collaboration.target.listCollaborationAuthorizedProjects).toHaveBeenCalledOnce();
    expect(bridges.collaboration.target.listCollaborationAuthorizedCanvases).toHaveBeenCalledOnce();
  });
});

describe("Workspace runtime exception notifications", () => {
  it.each([
    "blocked",
    "diverged"
  ] as const)("shows %s from the real Workspace authority and isolates remote switching while retiring late projections after Local opens", async (exceptionStatus) => {
    const replica = cachedProjection();
    const task = graph.tasks[0];
    const block = {
      ref: `${task.taskId}#B-001`,
      blockId: "B-001",
      type: "implementation" as const,
      title: "Implementation",
      status: "ready" as const,
      executor: null,
      requiredCapabilities: [],
      promptMissing: false,
      exceptionReason: null,
      dispatchable: false,
      remoteExecution: null
    };
    replica.content.tasks = [{ ...task, blocks: [block], blockPreview: [block] }];
    const runtimeStatus = {
      schemaVersion: "canvas-runtime-status/v2" as const,
      scope: {
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        canvasId: locator.canvasId
      },
      packageFingerprint: replica.content.packageFingerprint,
      capturedAt: "2026-08-22T00:00:00.000Z",
      tasks: [{ taskId: task.taskId, status: "ready" as const, openFeedbackCount: 0 }],
      blocks: [
        {
          ref: block.ref,
          status: exceptionStatus,
          completionReason: null,
          blockedReason: exceptionStatus === "blocked" ? "remote blocked" : null,
          divergenceReason: exceptionStatus === "diverged" ? "remote diverged" : null,
          dispatchable: false
        }
      ]
    };
    const projection = {
      locator,
      status: "accepted" as const,
      authorityMode: "server_authoritative" as const,
      readOnly: false,
      cachedAt: null,
      conflict: null,
      rejectCode: null,
      replica,
      initialRuntimeAvailability: {
        schemaVersion: "canvas-runtime-view/v2" as const,
        authority: {
          revision: 1,
          sourceRevision: "source-1",
          graphFingerprint: replica.content.packageFingerprint
        },
        state: { kind: "initialized" as const, runtimeRevision: 1, status: runtimeStatus },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1" as const,
          kind: "available" as const,
          status: runtimeStatus,
          sourceRevision: "source-1",
          graphFingerprint: replica.content.packageFingerprint
        }
      }
    };
    bridges.status.current = connectedWorkspaceStatus();
    bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi
      .fn()
      .mockResolvedValue({ items: [{ registry: runtimeStatus.scope }], nextCursor: null });
    bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn().mockResolvedValue(projection);
    let lateSignal: ((signal: WorkspaceCanvasProjectionSignal) => void) | null = null;
    bridges.collaboration.target.onWorkspaceCanvasProjectionSignal = vi.fn((listener) => {
      lateSignal = listener;
      return () => undefined;
    });
    let current: ProjectWorkspaceValue | null = null;
    let settings = workspaceSettings();
    const onValue = (value: ProjectWorkspaceValue) => {
      current = value;
    };
    const onSettings = (value: DesktopUiSettings) => {
      settings = value;
    };
    const mount = () =>
      render(
        <ProviderHarness initialSettings={settings} onSettings={onSettings} onValue={onValue} />
      );
    const mounted = mount();
    await waitFor(() => expect(current?.graphWorkspace.graph?.tasks[0].exceptions).toHaveLength(1));
    expect(current?.notifications.notificationItems).toHaveLength(1);
    const notification = current!.notifications.notificationItems[0];
    expect(notification.read).toBe(false);
    expect(notification.navigationIntent).toEqual({
      kind: "task-workspace",
      target: {
        authority: "workspace",
        connectionProfileId: locator.connectionProfileId,
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        canvasId: locator.canvasId,
        taskId: task.taskId,
        blockRef: block.ref
      }
    });
    act(() => current!.notifications.onMarkNotificationRead(notification.id));
    expect(current!.notifications.notificationItems.filter((item) => !item.read)).toHaveLength(0);
    const otherLocator = { ...locator, canvasId: "canvas-other" };
    const otherStatus = {
      ...runtimeStatus,
      scope: { ...runtimeStatus.scope, canvasId: otherLocator.canvasId }
    };
    const otherProjection = {
      ...projection,
      locator: otherLocator,
      replica: { ...replica, canvasId: otherLocator.canvasId },
      initialRuntimeAvailability: {
        ...projection.initialRuntimeAvailability,
        state: { ...projection.initialRuntimeAvailability.state, status: otherStatus },
        execution: { ...projection.initialRuntimeAvailability.execution, status: otherStatus }
      }
    };
    bridges.collaboration.target.openWorkspaceCanvasSession = vi
      .fn()
      .mockImplementation((opened) =>
        Promise.resolve(opened.canvasId === otherLocator.canvasId ? otherProjection : projection)
      );
    const retiredSignal = lateSignal;
    act(() => current!.shell.openWorkspaceCanvasLocator(otherLocator));
    await waitFor(() => expect(current?.notifications.notificationItems[0]?.read).toBe(false));
    const otherId = current!.notifications.notificationItems[0].id;
    expect(otherId).not.toBe(notification.id);
    act(() => retiredSignal?.({ type: "workspace.canvas.projection", projection }));
    expect(current!.notifications.notificationItems[0].id).toBe(otherId);
    expect(current!.notifications.notificationItems[0].navigationIntent).toMatchObject({
      target: { canvasId: otherLocator.canvasId }
    });
    act(() => current!.shell.openWorkspaceCanvasLocator(locator));
    await waitFor(() => expect(current?.notifications.notificationItems[0]?.read).toBe(true));
    mounted.unmount();
    const restored = mount();
    await waitFor(() => expect(current?.notifications.notificationItems[0]?.read).toBe(true));
    await act(async () => {
      await current!.shell.loadProject(project, "canvas-main");
    });
    await waitFor(() => expect(settings.lastOpenedWorkspaceLocator).toBeNull());
    act(() => lateSignal?.({ type: "workspace.canvas.projection", projection }));
    expect(current!.notifications.notificationItems).toHaveLength(0);
    expect(current!.graphWorkspace.graph?.projectId).toBe(projectSnapshot().graph.projectId);
    restored.unmount();
  });
});
