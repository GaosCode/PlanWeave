// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  return {
    collaboration: bridgeProxy(),
    desktop: bridgeProxy(),
    status: {
      current: null as {
        activeProfileId: string | null;
        profiles: Array<{ profileId: string; projectId: string }>;
        session: { phase: string };
      } | null
    }
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
    snapshot: { commentsByWorkItem: {}, mutationsById: {} },
    viewModel: null,
    controller: null,
    assigneeIndex: { byWorkItemKey: {}, syncPhase: "idle", surfaceActive: false },
    activeProfileId: bridges.status.current?.activeProfileId ?? null,
    activeProjectId: bridges.status.current?.profiles[0]?.projectId ?? null,
    sessionConnected: bridges.status.current?.session.phase === "connected",
    localOwnerDirectWriteAvailable: false,
    collaborationNotificationDrafts: []
  })
}));

vi.mock("../renderer/hooks/useWorkspaceRuntime", () => ({
  useWorkspaceRuntime: ({ graph }: { graph: unknown }) => ({
    graph,
    availability: { kind: "unavailable" },
    resetWorkspaceRuntime: undefined
  })
}));

vi.mock("../renderer/hooks/useOwnerControlPlaneAvailability", () => ({
  useOwnerControlPlaneAvailability: () => ({
    fleetCatalogEnabled: false,
    operatorProfileId: null,
    fleetCatalogBlockedCode: "operator_bridge_unavailable",
    localFleetCatalogEnabled: true,
    localOperatorProfileId: "profile-local-owner",
    localFleetCatalogBlockedCode: null,
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
      endpoints: [],
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
    promptDrafts: {},
    promptConflicts: [],
    reloadPromptConflicts: stubs.asyncCall,
    saveStates: {},
    titleDrafts: {}
  })
}));
vi.mock("../renderer/hooks/useSharedResourceHighlight", () => ({
  useSharedResourceHighlight: () => ({
    activeResource: null,
    pinnedResource: null,
    transitionEpochByResource: {},
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
    selectedEndpointId: () => null,
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
vi.mock("../renderer/hooks/useGraphFlowModel", () => ({ useGraphFlowModel: stubs.sync }));
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
vi.mock("../renderer/controllers/NotificationController", () => ({
  useNotificationController: () => ({ notificationItems: [] })
}));
vi.mock("../renderer/AppSettingsRouteProps", () => ({ buildAppSettingsRouteProps: () => ({}) }));
vi.mock("../renderer/controllers/GraphWorkspaceController", () => ({
  useGraphWorkspaceController: (input: {
    graph: unknown;
    runtimeAvailability: unknown;
    workspaceCanvasOffline: boolean;
    workspaceCanvasRevision: number | null;
  }) => ({
    graph: input.graph,
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

function Probe({ onValue }: { onValue: (value: ProjectWorkspaceValue) => void }) {
  const value = useProjectWorkspace();
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}

function ProviderHarness({
  initialSettings,
  onError,
  onSettings,
  onValue
}: {
  initialSettings: DesktopUiSettings;
  onError?: (message: string | null) => void;
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
      updateGlobalPrompt: vi.fn().mockResolvedValue(undefined),
      updateSettings,
      updateSettingsAndWait: async (update) => updateSettings(update)
    }),
    [activeView, onError, settings, updateSettings]
  );
  return (
    <ProjectWorkspaceProvider shell={shell}>
      <Probe onValue={onValue} />
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
    expect(current?.graphWorkspace.runtimeAvailability).toEqual({ kind: "unavailable" });
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

    bridges.status.current = {
      activeProfileId: locator.connectionProfileId,
      profiles: [{ profileId: locator.connectionProfileId, projectId: locator.projectId }],
      session: { phase: "connected" }
    };
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
        operatorProfileId: "profile-local-owner",
        fleetCatalogBlockedCode: null
      })
    );
  });

  it("refreshes the Server-authorized canvas catalog with the Local project catalog", async () => {
    bridges.status.current = {
      activeProfileId: locator.connectionProfileId,
      profiles: [{ profileId: locator.connectionProfileId, projectId: locator.projectId }],
      session: { phase: "connected" }
    };
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
