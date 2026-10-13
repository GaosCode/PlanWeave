// @vitest-environment jsdom

import type { CollaborationStatus } from "../../shared/collaboration";
import { activeWorkspaceConnectionViewSchema } from "@planweave-ai/collaboration-protocol/connection";
import { ReactFlowProvider } from "@xyflow/react";
import { TaskNodeCard } from "../../renderer/graph/TaskNodeCard";
import type { AppFlowNode } from "../../renderer/types";
import { cleanup } from "@testing-library/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { project, projectSnapshot } from "./desktopProjectFixtures";
import {
  ProjectWorkspaceProvider,
  useProjectWorkspace,
  type ProjectWorkspaceValue
} from "../../renderer/ProjectWorkspaceProvider";
import { createTranslator } from "../../renderer/i18n";
import { mergeDesktopSettings } from "../../renderer/settings";
import { defaultDesktopSettings } from "../../shared/desktopSettings";
import type { ProjectWorkspaceShellInput } from "../../renderer/projectWorkspaceShell";
import type { AppView, DesktopSettingsUpdate, DesktopUiSettings } from "../../renderer/types";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";
import { collaborationRemoteCanvasReplicaProjectionSchema } from "../../shared/canvasReplicaIpc";

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

vi.mock("../../renderer/bridge", async () => {
  const actual =
    await vi.importActual<typeof import("../../renderer/bridge")>("../../renderer/bridge");
  return {
    ...actual,
    bridge: bridges.desktop.proxy,
    collaborationBridge: bridges.collaboration.proxy,
    operatorControlBridge: null
  };
});

vi.mock("../../renderer/hooks/useCollaborationStatus", () => ({
  useCollaborationStatus: () => ({
    status: bridges.status.current,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined)
  })
}));

vi.mock("../../renderer/hooks/useCollaborationSurface", () => ({
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

vi.mock("../../renderer/hooks/useOwnerControlPlaneAvailability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../renderer/hooks/useOwnerControlPlaneAvailability")
  >()),
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

vi.mock("../../renderer/hooks/useLerpedNodeDrag", () => ({
  useLerpedNodeDrag: () => ({ commitDragTargets: () => [], onNodesChange: stubs.sync })
}));
vi.mock("../../renderer/hooks/useWorkspaceAgentEndpointCatalog", () => ({
  useWorkspaceAgentEndpointCatalog: (input: unknown) => {
    endpointCatalogProbe.input = input;
    return {
      endpoints: stableSurface.endpoints,
      errorCode: null,
      savePreference: stubs.asyncCall
    };
  }
}));
vi.mock("../../renderer/hooks/useSelectedBlock", () => ({
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
vi.mock("../../renderer/hooks/useDesktopProjectSession", () => ({
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
vi.mock("../../renderer/task-workspace/useTaskWorkspaceGraphNavigation", () => ({
  useTaskWorkspaceGraphNavigation: () => ({
    openBlockWorkspace: stubs.sync,
    openRunWorkspace: stubs.sync,
    openTaskInspector: stubs.sync,
    openTaskWorkspace: stubs.sync
  })
}));
vi.mock("../../renderer/task-workspace/useTaskWorkspaceController", () => ({
  useTaskWorkspaceController: () => ({})
}));
vi.mock("../../renderer/hooks/useWorkspaceAgentEndpointRun", () => ({
  useWorkspaceAgentEndpointRun: () => stubs.asyncCall
}));
vi.mock("../../renderer/controllers/AutoRunController", () => ({
  useAutoRunController: () => ({ startAutoRunWithScope: stubs.asyncCall }),
  useFileSyncController: () => ({
    fileSyncDiagnostics: [],
    lastFileChange: null
  })
}));
vi.mock("../../renderer/hooks/useTaskNodeFocus", () => ({ useTaskNodeFocus: stubs.sync }));
vi.mock("../../renderer/controllers/SearchController", () => ({
  useSearchController: () => ({
    diagnostics: [],
    searchQuery: "",
    searchCanvasScope: null,
    selectedSearchResultKinds: [],
    searchResults: []
  })
}));
vi.mock("../../renderer/hooks/useCollaborationCanvasPresence", () => ({
  useCollaborationCanvasPresence: () => ({})
}));
vi.mock("../../renderer/task-workspace/useRecordWorkspaceNavigation", () => ({
  useRecordWorkspaceNavigation: () => stubs.asyncCall
}));
vi.mock("../../renderer/hooks/useReviewPipeline", () => ({
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
vi.mock("../../renderer/hooks/useGraphDeleteActions", () => ({
  useGraphDeleteActions: () => ({
    handleDeleteBlock: stubs.asyncCall,
    handleDeleteTaskNode: stubs.asyncCall
  })
}));
vi.mock("../../renderer/hooks/usePromptDrafts", () => ({
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
vi.mock("../../renderer/hooks/useSharedResourceHighlight", () => ({
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
vi.mock("../../renderer/hooks/useTaskExecutorActions", () => ({
  useTaskExecutorActions: () => ({ handleTaskExecutorChange: stubs.asyncCall })
}));
vi.mock("../../renderer/hooks/useTaskAgentEndpointSelection", () => ({
  useTaskAgentEndpointSelection: () => ({
    selectedEndpointId: stableSurface.selectedEndpointId,
    changeEndpoint: stubs.asyncCall
  })
}));
vi.mock("../../renderer/hooks/useDesktopProjectActions", () => ({
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
vi.mock("../../renderer/hooks/useGraphHistoryActions", () => ({
  useGraphHistoryActions: () => ({
    handleRedoGraph: stubs.asyncCall,
    handleUndoGraph: stubs.asyncCall
  })
}));

vi.mock("../../renderer/hooks/useGraphPaletteActions", () => ({
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
vi.mock("../../renderer/AppSettingsRouteProps", () => ({ buildAppSettingsRouteProps: () => ({}) }));
vi.mock("../../renderer/controllers/GraphWorkspaceController", () => ({
  useGraphWorkspaceController: (input: {
    graph: unknown;
    nodes: AppFlowNode[];
    runtimeAvailability: unknown;
    workspaceCanvasOffline: boolean;
    workspaceCanvasRevision: number | null;
    onDownloadWorkspaceFork?: () => Promise<void>;
  }) => ({
    graph: input.graph,
    nodes: input.nodes,
    runtimeAvailability: input.runtimeAvailability,
    workspaceCanvasOffline: input.workspaceCanvasOffline,
    workspaceCanvasRevision: input.workspaceCanvasRevision,
    onDownloadWorkspaceFork: input.onDownloadWorkspaceFork
  })
}));

export const locator: WorkspaceCanvasLocator = {
  kind: "workspace",
  connectionProfileId: "profile-offline",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};

export function connectedWorkspaceStatus(): CollaborationStatus {
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

export function cachedProjection() {
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

export function ProviderHarness({
  initialSettings,
  onError,
  onSettings,
  onValue,
  onUpdateSettings,
  onSuccess,
  showGraph
}: {
  showGraph?: boolean;
  initialSettings: DesktopUiSettings;
  onError?: ProjectWorkspaceShellInput["setError"];
  onSettings: (settings: DesktopUiSettings) => void;
  onValue: (value: ProjectWorkspaceValue) => void;
  onUpdateSettings?: (update: ProjectWorkspaceShellInput["updateSettings"]) => void;
  onSuccess?: ProjectWorkspaceShellInput["setSuccessMessage"];
}) {
  const [activeView, setActiveView] = useState<AppView>("graph");
  const [settings, setSettings] = useState(initialSettings);
  const updateSettings = useCallback((update: DesktopSettingsUpdate) => {
    setSettings((current) =>
      mergeDesktopSettings(current, typeof update === "function" ? update(current) : update)
    );
  }, []);
  useEffect(() => onSettings(settings), [onSettings, settings]);
  useEffect(() => onUpdateSettings?.(updateSettings), [onUpdateSettings, updateSettings]);
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
      setSuccessMessage: onSuccess ?? stubs.sync,
      settings,
      settingsHydrated: true,
      t: createTranslator("en"),
      updateLayoutSettings: vi.fn(),
      updateGlobalPrompt: vi.fn().mockResolvedValue(true),
      updateSettings,
      updateSettingsAndWait: async (update) => updateSettings(update)
    }),
    [activeView, onError, onSuccess, settings, updateSettings]
  );
  return (
    <ProjectWorkspaceProvider shell={shell}>
      <Probe onValue={onValue} showGraph={showGraph} />
    </ProjectWorkspaceProvider>
  );
}

export function workspaceSettings(): DesktopUiSettings {
  return {
    ...defaultDesktopSettings,
    language: "en",
    runtimePath: project.workspaceRoot,
    lastOpenedWorkspaceLocator: locator
  };
}

export function installProviderHarness() {
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
}

export { bridges, endpointCatalogProbe };
