import type { CSSProperties, Dispatch, DragEvent, MouseEvent, PointerEvent, Ref, SetStateAction } from "react";
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
  DesktopTaskDraft,
  DesktopTaskDraftMode,
  DesktopTodoGroups,
  ValidationIssue
} from "@planweave-ai/runtime";
import type { createTranslator } from "../i18n";
import type { DesktopSearchCanvasScope, DesktopSearchStatus } from "../hooks/useDesktopSearch";
import type { AppEdgeTypes, AppNodeTypes } from "../graph/flowModel";
import type { AutoRunNextActionDescriptor } from "../run/autoRunNextActions";
import type { AppFlowNode, AppView, AutoRunScopeMode, NotificationItem } from "../types";
import { CanvasMapView } from "./CanvasMapView";
import { GraphView } from "./GraphView";
import { NewTaskView } from "./NewTaskView";
import { NotificationsView } from "./NotificationsView";
import { ReviewPipelineView } from "./ReviewPipelineView";
import { SearchView } from "./SearchView";
import { StatisticsView } from "./StatisticsView";
import { TodoView } from "./TodoView";

export type WorkspaceTabsShellProps = {
  activeView: AppView;
  handleOpenProject: () => Promise<void>;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
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
  handleOpenRunRecord: (recordId: string | null | undefined, canvasId?: string | null) => Promise<void>;
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

export type WorkspaceTabsNewTaskProps = {
  confirmTaskDraft: () => Promise<void>;
  generateTaskDraft: () => Promise<void>;
  newTaskMode: DesktopTaskDraftMode;
  newTaskTargetId: string | null;
  newTaskText: string;
  setNewTaskMode: Dispatch<SetStateAction<DesktopTaskDraftMode>>;
  setNewTaskTargetId: Dispatch<SetStateAction<string | null>>;
  setNewTaskText: Dispatch<SetStateAction<string>>;
  setTaskDraft: Dispatch<SetStateAction<DesktopTaskDraft | null>>;
  taskDraft: DesktopTaskDraft | null;
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

export type WorkspaceTabsProps = {
  shell: WorkspaceTabsShellProps;
  graphWorkspace: WorkspaceTabsGraphWorkspaceProps;
  autoRun: WorkspaceTabsAutoRunProps;
  fileSync: WorkspaceTabsFileSyncProps;
  search: WorkspaceTabsSearchProps;
  review: WorkspaceTabsReviewProps;
  newTask: WorkspaceTabsNewTaskProps;
  notifications: WorkspaceTabsNotificationsProps;
  planning: WorkspaceTabsPlanningProps;
};

function GraphWorkspaceRoute({
  autoRun,
  fileSync,
  graphWorkspace,
  shell
}: Pick<WorkspaceTabsProps, "autoRun" | "fileSync" | "graphWorkspace" | "shell">) {
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

function SearchRoute({ search, shell }: Pick<WorkspaceTabsProps, "search" | "shell">) {
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

function TodoRoute({ graphWorkspace, planning, shell }: Pick<WorkspaceTabsProps, "graphWorkspace" | "planning" | "shell">) {
  return (
    <TodoView
      executionPlan={graphWorkspace.executionPlan}
      handleBlockSelect={graphWorkspace.handleOpenBlockInspector}
      t={shell.t}
      todoGroups={planning.todoGroups}
    />
  );
}

function StatisticsRoute({ planning, shell }: Pick<WorkspaceTabsProps, "planning" | "shell">) {
  return <StatisticsView handleOpenProject={shell.handleOpenProject} selectedProject={shell.selectedProject} statistics={planning.statistics} t={shell.t} />;
}

function NewTaskRoute({ graphWorkspace, newTask, shell }: Pick<WorkspaceTabsProps, "graphWorkspace" | "newTask" | "shell">) {
  return (
    <NewTaskView
      {...newTask}
      graph={graphWorkspace.graph}
      handleOpenProject={shell.handleOpenProject}
      selectedCanvasId={shell.selectedCanvasId}
      selectedProject={shell.selectedProject}
      setActiveView={shell.setActiveView}
      t={shell.t}
    />
  );
}

function ReviewPipelineRoute({ graphWorkspace, review, shell }: Pick<WorkspaceTabsProps, "graphWorkspace" | "review" | "shell">) {
  return <ReviewPipelineView {...review} graph={graphWorkspace.graph} t={shell.t} />;
}

function NotificationsRoute({ fileSync, notifications, shell }: Pick<WorkspaceTabsProps, "fileSync" | "notifications" | "shell">) {
  return (
    <NotificationsView
      {...notifications}
      onOpenGraph={() => shell.setActiveView("graph")}
      refreshPackageFiles={fileSync.refreshPackageFiles}
      t={shell.t}
    />
  );
}

function CanvasMapRoute({ fileSync, graphWorkspace, shell }: Pick<WorkspaceTabsProps, "fileSync" | "graphWorkspace" | "shell">) {
  return (
    <CanvasMapView
      handleOpenBlockInspector={graphWorkspace.handleOpenBlockInspector}
      handleOpenProject={shell.handleOpenProject}
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

export function WorkspaceTabs(props: WorkspaceTabsProps) {
  const activeView = props.shell.activeView;
  const content = (() => {
    switch (activeView) {
      case "new-task":
        return <NewTaskRoute graphWorkspace={props.graphWorkspace} newTask={props.newTask} shell={props.shell} />;
      case "review-pipeline":
        return <ReviewPipelineRoute graphWorkspace={props.graphWorkspace} review={props.review} shell={props.shell} />;
      case "todo":
        return <TodoRoute graphWorkspace={props.graphWorkspace} planning={props.planning} shell={props.shell} />;
      case "statistics":
        return <StatisticsRoute planning={props.planning} shell={props.shell} />;
      case "search":
        return <SearchRoute search={props.search} shell={props.shell} />;
      case "notifications":
        return <NotificationsRoute fileSync={props.fileSync} notifications={props.notifications} shell={props.shell} />;
      case "canvas-map":
        return <CanvasMapRoute fileSync={props.fileSync} graphWorkspace={props.graphWorkspace} shell={props.shell} />;
      case "graph":
      default:
        return (
          <GraphWorkspaceRoute
            autoRun={props.autoRun}
            fileSync={props.fileSync}
            graphWorkspace={props.graphWorkspace}
            shell={props.shell}
          />
        );
    }
  })();

  return (
    <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-l-xl bg-app-shell text-text">
      <div className={`min-h-0 flex-1 bg-app-canvas ${activeView === "graph" || activeView === "canvas-map" ? "" : "px-8 py-8"}`}>
        <div className="view-enter h-full min-h-0" key={activeView}>
          {content}
        </div>
      </div>
    </section>
  );
}
