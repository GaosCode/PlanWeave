import {
  lazy,
  Suspense,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  type SetStateAction
} from "react";
import type {
  Connection,
  Edge,
  Node,
  OnEdgesChange,
  OnNodesChange,
  ReactFlowInstance
} from "@xyflow/react";
import type {
  DesktopAutoRunRetrospectiveSummary,
  DesktopAutoRunState,
  DesktopCanvasReference,
  DesktopGraphViewModel,
  DesktopPackageFileSyncResult,
  DesktopProjectExecutionPlan,
  DesktopProjectSummary,
  DesktopReviewPipeline,
  DesktopReviewPipelineStepInput,
  DesktopSearchResult,
  DesktopSearchResultKind,
  DesktopStatistics,
  DesktopTodoGroups,
  ValidationIssue
} from "@planweave-ai/runtime";
import type { createTranslator } from "../i18n";
import type { DesktopSearchCanvasScope, DesktopSearchStatus } from "../hooks/useDesktopSearch";
import type { AppEdgeTypes, AppNodeTypes } from "../graph/flowModel";
import type { AutoRunNextActionDescriptor } from "../run/autoRunNextActions";
import type { AppFlowNode, AppView, AutoRunScopeMode, NotificationItem } from "../types";
import { useProjectWorkspace } from "../ProjectWorkspaceProvider";

const CanvasMapView = lazy(() =>
  import("./CanvasMapView").then((module) => ({ default: module.CanvasMapView }))
);
const GraphView = lazy(() =>
  import("./GraphView").then((module) => ({ default: module.GraphView }))
);
const NotificationsView = lazy(() =>
  import("./NotificationsView").then((module) => ({ default: module.NotificationsView }))
);
const ReviewPipelineView = lazy(() =>
  import("./ReviewPipelineView").then((module) => ({ default: module.ReviewPipelineView }))
);
const SearchView = lazy(() =>
  import("./SearchView").then((module) => ({ default: module.SearchView }))
);
const StatisticsView = lazy(() =>
  import("./StatisticsView").then((module) => ({ default: module.StatisticsView }))
);
const TodoView = lazy(() => import("./TodoView").then((module) => ({ default: module.TodoView })));
const TaskWorkspaceAppRoute = lazy(() =>
  import("./TaskWorkspaceAppRoute").then((module) => ({ default: module.TaskWorkspaceAppRoute }))
);

export type WorkspaceTabsShellProps = {
  activeView: AppView;
  handleOpenProject: () => Promise<void>;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
  handleRevealTaskCanvas: (project: DesktopProjectSummary, canvasId: string) => Promise<void>;
  handleRenameTaskCanvas: (
    project: DesktopProjectSummary,
    canvasId: string,
    currentName: string
  ) => Promise<void>;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  projectLoading: boolean;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export type WorkspaceTabsGraphWorkspaceProps = {
  edges: Edge[];
  edgeTypes: AppEdgeTypes;
  executionPlan: DesktopProjectExecutionPlan | null;
  graph: DesktopGraphViewModel | null;
  handleConnect: (connection: Connection) => Promise<void>;
  handleEdgesDelete: (deletedEdges: Edge[]) => Promise<void>;
  handleGraphDragOver: (event: DragEvent) => void;
  handleGraphDrop: (event: DragEvent) => void;
  handleOpenBlockInspector: (ref: string, canvasId?: string | null) => Promise<void>;
  handleOpenRunRecord: (
    recordId: string | null | undefined,
    canvasId?: string | null
  ) => Promise<void>;
  handleReconnectEdge: (oldEdge: Edge, connection: Connection) => Promise<void>;
  handleRedoGraph: () => Promise<void>;
  handleUndoGraph: () => Promise<void>;
  nodeTypes: AppNodeTypes;
  nodes: AppFlowNode[];
  onAgentPromptCopied: () => void;
  onEdgesChange: OnEdgesChange<Edge>;
  onNodeDragStop: (event: MouseEvent, node: Node) => Promise<void>;
  onNodesChange: OnNodesChange<AppFlowNode>;
  onTaskPanelSelect: (taskId: string | null) => void;
  selectedBlockPresent: boolean;
  setFlowInstance: Dispatch<SetStateAction<ReactFlowInstance<AppFlowNode, Edge> | null>>;
  visibleTaskIds: Set<string>;
  visibleTasks: DesktopGraphViewModel["tasks"] | undefined;
  /** Active shared-resource pin for the resource inspector. */
  pinnedResource: string | null;
  onResourceHover: (name: string | null) => void;
  onResourcePin: (name: string | null) => void;
  clearPinnedResource: () => void;
};

export type WorkspaceTabsAutoRunProps = {
  autoRunControlRef: Ref<HTMLDivElement>;
  autoRunControlStyle: CSSProperties;
  autoRunNextAction: AutoRunNextActionDescriptor | null;
  autoRunRetrospective: DesktopAutoRunRetrospectiveSummary | null;
  autoRunScopeMode: AutoRunScopeMode;
  autoRunState: DesktopAutoRunState | null;
  handleAutoRunClick: () => Promise<void>;
  handleAutoRunNextAction: (action: AutoRunNextActionDescriptor) => Promise<void>;
  miniRunPanelOpen: boolean;
  moveAutoRunControl: (event: PointerEvent<HTMLButtonElement>) => void;
  resetRuntimeStateClick: () => Promise<void>;
  setAutoRunScopeMode: Dispatch<SetStateAction<AutoRunScopeMode>>;
  setMiniRunPanelOpen: Dispatch<SetStateAction<boolean>>;
  startAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  stopAutoRunClick: () => Promise<void>;
  stopAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
};

export type WorkspaceTabsFileSyncProps = {
  applyCanvasLaneLayout: (ref: DesktopCanvasReference) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  fileSyncResult: DesktopPackageFileSyncResult | null;
  projectDiagnostics: ValidationIssue[];
  refreshPackageFiles: () => Promise<void>;
  refreshProjectDerivedState: () => Promise<void>;
  setError: (message: string | null) => void;
};

export type WorkspaceTabsSearchProps = {
  handleSearchResultOpen: (result: DesktopSearchResult) => Promise<void>;
  searchCanvasScope: DesktopSearchCanvasScope;
  searchQuery: string;
  searchResultKinds: DesktopSearchResultKind[];
  searchResults: DesktopSearchResult[];
  searchStatus: DesktopSearchStatus;
  selectedSearchResultKinds: DesktopSearchResultKind[];
  setSearchCanvasScope: Dispatch<SetStateAction<DesktopSearchCanvasScope>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setSearchResultKindEnabled: (kind: DesktopSearchResultKind, enabled: boolean) => void;
};

export type WorkspaceTabsReviewProps = {
  addReviewStep: () => void;
  moveReviewStep: (index: number, direction: -1 | 1) => void;
  removeReviewStep: (index: number) => void;
  reviewDefaultCyclesDraft: number;
  reviewDraft: DesktopReviewPipelineStepInput[];
  reviewPipeline: DesktopReviewPipeline | null;
  reviewTaskId: string | null;
  saveReviewPipeline: () => Promise<void>;
  setReviewDefaultCyclesDraft: Dispatch<SetStateAction<number>>;
  setReviewTaskId: Dispatch<SetStateAction<string | null>>;
  updateReviewStep: (index: number, patch: Partial<DesktopReviewPipelineStepInput>) => void;
};

export type WorkspaceTabsNotificationsProps = {
  notificationItems: NotificationItem[];
  onApplyLocalPromptConflicts: () => Promise<void>;
  onKeepLocalPromptConflicts: () => void;
  onMarkNotificationRead: (notificationId: string) => void;
  onCopyImportRecoveryTransactionId: (transactionId: string) => Promise<void>;
  onReloadPromptConflicts: () => Promise<void>;
  onRevealImportRecoveryDirectory: (recoveryRoot: string) => Promise<void>;
  onRollbackImportRecovery: (transactionId: string) => Promise<void>;
};

export type WorkspaceTabsPlanningProps = {
  statistics: DesktopStatistics | null;
  todoGroups: DesktopTodoGroups | null;
};

function GraphWorkspaceRoute() {
  const { autoRun, fileSync, graphWorkspace, shell } = useProjectWorkspace();
  return (
    <GraphView
      {...graphWorkspace}
      {...autoRun}
      {...fileSync}
      handleOpenProject={shell.handleOpenProject}
      handleRevealPathInFinder={shell.handleRevealPathInFinder}
      projectLoading={shell.projectLoading}
      selectedCanvasId={shell.selectedCanvasId}
      selectedProject={shell.selectedProject}
      selectedTaskPanelId={shell.selectedTaskPanelId}
      setActiveView={shell.setActiveView}
      t={shell.t}
    />
  );
}

function SearchRoute() {
  const { search, shell } = useProjectWorkspace();
  return (
    <SearchView
      {...search}
      handleOpenProject={shell.handleOpenProject}
      selectedCanvasId={shell.selectedCanvasId}
      selectedProject={shell.selectedProject}
      t={shell.t}
    />
  );
}

function TodoRoute() {
  const { graphWorkspace, planning, shell } = useProjectWorkspace();
  return (
    <TodoView
      executionPlan={graphWorkspace.executionPlan}
      handleBlockSelect={graphWorkspace.handleOpenBlockInspector}
      t={shell.t}
      todoGroups={planning.todoGroups}
    />
  );
}

function StatisticsRoute() {
  const { planning, shell } = useProjectWorkspace();
  return (
    <StatisticsView
      handleOpenProject={shell.handleOpenProject}
      selectedProject={shell.selectedProject}
      statistics={planning.statistics}
      t={shell.t}
    />
  );
}

function ReviewPipelineRoute() {
  const { graphWorkspace, review, shell } = useProjectWorkspace();
  return <ReviewPipelineView {...review} graph={graphWorkspace.graph} t={shell.t} />;
}

function NotificationsRoute() {
  const { fileSync, notifications, shell } = useProjectWorkspace();
  return (
    <NotificationsView
      {...notifications}
      onOpenGraph={() => shell.setActiveView("graph")}
      refreshPackageFiles={fileSync.refreshPackageFiles}
      t={shell.t}
    />
  );
}

function CanvasMapRoute() {
  const { fileSync, graphWorkspace, shell } = useProjectWorkspace();
  return (
    <CanvasMapView
      handleOpenBlockInspector={graphWorkspace.handleOpenBlockInspector}
      handleOpenProject={shell.handleOpenProject}
      handleRevealTaskCanvas={shell.handleRevealTaskCanvas}
      handleRenameTaskCanvas={shell.handleRenameTaskCanvas}
      loadProject={shell.loadProject}
      onAgentPromptCopied={graphWorkspace.onAgentPromptCopied}
      onTaskPanelSelect={graphWorkspace.onTaskPanelSelect}
      refreshProjectDerivedState={fileSync.refreshProjectDerivedState}
      selectedCanvasId={shell.selectedCanvasId}
      selectedProject={shell.selectedProject}
      setActiveView={shell.setActiveView}
      setError={shell.setError}
      t={shell.t}
    />
  );
}

export function WorkspaceTabs() {
  const { shell } = useProjectWorkspace();
  const activeView = shell.activeView;
  const content = (() => {
    switch (activeView) {
      case "review-pipeline":
        return <ReviewPipelineRoute />;
      case "todo":
        return <TodoRoute />;
      case "statistics":
        return <StatisticsRoute />;
      case "search":
        return <SearchRoute />;
      case "notifications":
        return <NotificationsRoute />;
      case "canvas-map":
        return <CanvasMapRoute />;
      case "graph":
        return <GraphWorkspaceRoute />;
      case "task-workspace":
        return <TaskWorkspaceAppRoute />;
      case "settings":
        return null;
    }
  })();
  const taskWorkspaceActive = activeView === "task-workspace";

  return (
    <section
      className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-app-shell text-text ${taskWorkspaceActive ? "" : "rounded-l-xl"}`}
    >
      {taskWorkspaceActive ? null : (
        <div className="app-drag-region h-11 shrink-0 border-b border-border/80 bg-app-topbar" />
      )}
      <div
        className={`min-h-0 flex-1 bg-app-canvas ${activeView === "graph" || activeView === "canvas-map" || taskWorkspaceActive ? "" : "p-4"}`}
      >
        <div className="h-full min-h-0">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-text-muted">
                {shell.t("loadingProject")}
              </div>
            }
          >
            {content}
          </Suspense>
        </div>
      </div>
    </section>
  );
}
