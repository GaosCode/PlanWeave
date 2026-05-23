import type { CSSProperties, Dispatch, DragEvent, MouseEvent, PointerEvent, SetStateAction } from "react";
import type {
  Connection,
  Edge,
  Node,
  OnEdgesChange,
  OnNodesChange,
  ReactFlowInstance
} from "@xyflow/react";
import type {
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopReviewPipeline,
  DesktopReviewPipelineStepInput,
  DesktopSearchResult,
  DesktopStatistics,
  DesktopTaskDraft,
  DesktopTaskDraftMode,
  DesktopTodoGroups
} from "@planweave/runtime";
import type { createTranslator, Language } from "../i18n";
import type { AppNodeTypes } from "../graph/flowModel";
import type { AppFlowNode, AppView, AutoRunScopeMode, DesktopUiSettings, NotificationItem } from "../types";
import { GraphView } from "./GraphView";
import { NewTaskView } from "./NewTaskView";
import { NotificationsView } from "./NotificationsView";
import { ReviewPipelineView } from "./ReviewPipelineView";
import { SearchView } from "./SearchView";
import { StatisticsView } from "./StatisticsView";
import { TodoView } from "./TodoView";

type WorkspaceTabsProps = {
  activeView: AppView;
  autoRunControlStyle: CSSProperties;
  autoRunScopeMode: AutoRunScopeMode;
  autoRunState: DesktopAutoRunState | null;
  confirmTaskDraft: () => Promise<void>;
  dirtyPromptRefs: string[];
  edges: Edge[];
  generateTaskDraft: () => Promise<void>;
  graph: DesktopGraphViewModel | null;
  handleAutoRunClick: () => Promise<void>;
  handleBlockSelect: (ref: string, canvasId?: string | null) => Promise<void>;
  handleOpenBlockInspector: (ref: string, canvasId?: string | null) => Promise<void>;
  handleConnect: (connection: Connection) => Promise<void>;
  handleEdgesDelete: (deletedEdges: Edge[]) => Promise<void>;
  handleGraphDragOver: (event: DragEvent) => void;
  handleGraphDrop: (event: DragEvent) => void;
  handleOpenProject: () => Promise<void>;
  handleOpenRunRecord: (recordId: string | null | undefined, canvasId?: string | null) => Promise<void>;
  handleSearchResultOpen: (result: DesktopSearchResult) => Promise<void>;
  language: Language;
  miniRunPanelOpen: boolean;
  moveAutoRunControl: (event: PointerEvent<HTMLButtonElement>) => void;
  moveReviewStep: (index: number, direction: -1 | 1) => void;
  newTaskMode: DesktopTaskDraftMode;
  newTaskTargetId: string | null;
  newTaskText: string;
  nodeTypes: AppNodeTypes;
  nodes: AppFlowNode[];
  notificationItems: NotificationItem[];
  onMarkNotificationRead: (notificationId: string) => void;
  onEdgesChange: OnEdgesChange<Edge>;
  onNodeDragStop: (event: MouseEvent, node: Node) => Promise<void>;
  onNodesChange: OnNodesChange<AppFlowNode>;
  refreshPackageFiles: () => Promise<void>;
  removeReviewStep: (index: number) => void;
  reviewDefaultCyclesDraft: number;
  reviewDraft: DesktopReviewPipelineStepInput[];
  reviewPipeline: DesktopReviewPipeline | null;
  reviewTaskId: string | null;
  saveReviewPipeline: () => Promise<void>;
  searchQuery: string;
  searchResults: DesktopSearchResult[];
  selectedBlockPresent: boolean;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  setAutoRunScopeMode: Dispatch<SetStateAction<AutoRunScopeMode>>;
  setFlowInstance: Dispatch<SetStateAction<ReactFlowInstance<AppFlowNode, Edge> | null>>;
  setMiniRunPanelOpen: Dispatch<SetStateAction<boolean>>;
  setNewTaskMode: Dispatch<SetStateAction<DesktopTaskDraftMode>>;
  setNewTaskTargetId: Dispatch<SetStateAction<string | null>>;
  setNewTaskText: Dispatch<SetStateAction<string>>;
  setProjectPath: Dispatch<SetStateAction<string>>;
  setReviewDefaultCyclesDraft: Dispatch<SetStateAction<number>>;
  setReviewTaskId: Dispatch<SetStateAction<string | null>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
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
        return <NotificationsView {...props} />;
      case "graph":
      default:
        return <GraphView {...props} />;
    }
  })();

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="app-drag-region h-11 shrink-0 border-b bg-background" />
      <div className={`min-h-0 flex-1 ${activeView === "graph" ? "" : "p-4"}`}>
        <div className="h-full min-h-0">
          {content}
        </div>
      </div>
    </section>
  );
}
