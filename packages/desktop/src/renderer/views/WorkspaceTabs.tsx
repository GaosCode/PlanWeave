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
  DesktopTodoGroups
} from "@planweave-ai/runtime";
import type { createTranslator, Language } from "../i18n";
import type { DesktopSearchCanvasScope } from "../hooks/useDesktopSearch";
import type { AppEdgeTypes, AppNodeTypes } from "../graph/flowModel";
import type { AutoRunNextActionDescriptor } from "../run/autoRunNextActions";
import type { AppFlowNode, AppView, AutoRunScopeMode, DesktopUiSettings, NotificationItem } from "../types";
import { CanvasMapView } from "./CanvasMapView";
import { GraphView } from "./GraphView";
import { NewTaskView } from "./NewTaskView";
import { NotificationsView } from "./NotificationsView";
import { ReviewPipelineView } from "./ReviewPipelineView";
import { SearchView } from "./SearchView";
import { StatisticsView } from "./StatisticsView";
import { TodoView } from "./TodoView";

type WorkspaceTabsProps = {
  activeView: AppView;
  autoRunControlRef: Ref<HTMLDivElement>;
  autoRunControlStyle: CSSProperties;
  autoRunNextAction: AutoRunNextActionDescriptor | null;
  autoRunRetrospective: DesktopAutoRunRetrospectiveSummary | null;
  autoRunScopeMode: AutoRunScopeMode;
  autoRunState: DesktopAutoRunState | null;
  confirmTaskDraft: () => Promise<void>;
  edges: Edge[];
  fileSyncResult: DesktopPackageFileSyncResult | null;
  generateTaskDraft: () => Promise<void>;
  graph: DesktopGraphViewModel | null;
  executionPlan: DesktopProjectExecutionPlan | null;
  handleAutoRunClick: () => Promise<void>;
  handleAutoRunNextAction: (action: AutoRunNextActionDescriptor) => Promise<void>;
  handleOpenBlockInspector: (ref: string, canvasId?: string | null) => Promise<void>;
  handleConnect: (connection: Connection) => Promise<void>;
  handleEdgesDelete: (deletedEdges: Edge[]) => Promise<void>;
  handleReconnectEdge: (oldEdge: Edge, connection: Connection) => Promise<void>;
  handleGraphDragOver: (event: DragEvent) => void;
  handleGraphDrop: (event: DragEvent) => void;
  handleOpenProject: () => Promise<void>;
  handleOpenRunRecord: (recordId: string | null | undefined, canvasId?: string | null) => Promise<void>;
  handleRedoGraph: () => Promise<void>;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
  resetRuntimeStateClick: () => Promise<void>;
  handleSearchResultOpen: (result: DesktopSearchResult) => Promise<void>;
  handleUndoGraph: () => Promise<void>;
  language: Language;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  miniRunPanelOpen: boolean;
  moveAutoRunControl: (event: PointerEvent<HTMLButtonElement>) => void;
  moveReviewStep: (index: number, direction: -1 | 1) => void;
  newTaskMode: DesktopTaskDraftMode;
  newTaskTargetId: string | null;
  newTaskText: string;
  edgeTypes: AppEdgeTypes;
  nodeTypes: AppNodeTypes;
  nodes: AppFlowNode[];
  notificationItems: NotificationItem[];
  onApplyLocalPromptConflicts: () => Promise<void>;
  onKeepLocalPromptConflicts: () => void;
  projectLoading: boolean;
  onMarkNotificationRead: (notificationId: string) => void;
  onAgentPromptCopied: () => void;
  onReloadPromptConflicts: () => Promise<void>;
  onEdgesChange: OnEdgesChange<Edge>;
  onNodeDragStop: (event: MouseEvent, node: Node) => Promise<void>;
  onNodesChange: OnNodesChange<AppFlowNode>;
  onTaskPanelSelect: (taskId: string | null) => void;
  refreshPackageFiles: () => Promise<void>;
  removeReviewStep: (index: number) => void;
  reviewDefaultCyclesDraft: number;
  reviewDraft: DesktopReviewPipelineStepInput[];
  reviewPipeline: DesktopReviewPipeline | null;
  reviewTaskId: string | null;
  saveReviewPipeline: () => Promise<void>;
  searchCanvasScope: DesktopSearchCanvasScope;
  searchQuery: string;
  searchResultKinds: DesktopSearchResultKind[];
  searchResults: DesktopSearchResult[];
  selectedBlockPresent: boolean;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  selectedSearchResultKinds: DesktopSearchResultKind[];
  selectedTaskPanelId: string | null;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setError: (message: string | null) => void;
  setAutoRunScopeMode: Dispatch<SetStateAction<AutoRunScopeMode>>;
  setSearchCanvasScope: Dispatch<SetStateAction<DesktopSearchCanvasScope>>;
  setFlowInstance: Dispatch<SetStateAction<ReactFlowInstance<AppFlowNode, Edge> | null>>;
  setMiniRunPanelOpen: Dispatch<SetStateAction<boolean>>;
  setNewTaskMode: Dispatch<SetStateAction<DesktopTaskDraftMode>>;
  setNewTaskTargetId: Dispatch<SetStateAction<string | null>>;
  setNewTaskText: Dispatch<SetStateAction<string>>;
  setTaskDraft: Dispatch<SetStateAction<DesktopTaskDraft | null>>;
  setReviewDefaultCyclesDraft: Dispatch<SetStateAction<number>>;
  setReviewTaskId: Dispatch<SetStateAction<string | null>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setSearchResultKindEnabled: (kind: DesktopSearchResultKind, enabled: boolean) => void;
  settings: DesktopUiSettings;
  startAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  statistics: DesktopStatistics | null;
  stopAutoRunClick: () => Promise<void>;
  stopAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  t: ReturnType<typeof createTranslator>;
  taskDraft: DesktopTaskDraft | null;
  todoGroups: DesktopTodoGroups | null;
  updateReviewStep: (index: number, patch: Partial<DesktopReviewPipelineStepInput>) => void;
  updateSettings: (patch: Partial<DesktopUiSettings>) => void;
  visibleTaskIds: Set<string>;
  visibleTasks: DesktopGraphViewModel["tasks"] | undefined;
  addReviewStep: () => void;
};

export function WorkspaceTabs(props: WorkspaceTabsProps) {
  const {
    activeView
  } = props;
  const content = (() => {
    switch (activeView) {
      case "new-task":
        return <NewTaskView {...props} />;
      case "review-pipeline":
        return <ReviewPipelineView {...props} />;
      case "todo":
        return <TodoView {...props} handleBlockSelect={props.handleOpenBlockInspector} />;
      case "statistics":
        return <StatisticsView {...props} />;
      case "search":
        return <SearchView {...props} />;
      case "notifications":
        return <NotificationsView {...props} onOpenGraph={() => props.setActiveView("graph")} />;
      case "canvas-map":
        return <CanvasMapView {...props} />;
      case "graph":
      default:
        return <GraphView {...props} />;
    }
  })();

  return (
    <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-l-xl bg-app-shell text-text">
      <div className="app-drag-region h-11 shrink-0 border-b border-border/80 bg-app-topbar" />
      <div className={`min-h-0 flex-1 bg-app-canvas ${activeView === "graph" || activeView === "canvas-map" ? "" : "p-4"}`}>
        <div className="h-full min-h-0">
          {content}
        </div>
      </div>
    </section>
  );
}
