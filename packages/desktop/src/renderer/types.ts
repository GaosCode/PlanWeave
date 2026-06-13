import type { Node } from "@xyflow/react";
import type {
  BlockType,
  DesktopAutoRunScope,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopAgentKind,
  DesktopCanvasNodeViewModel,
  DesktopFeedbackRecord,
  DesktopReviewAttemptSummary,
  DesktopTaskNodeViewModel
} from "@planweave-ai/runtime";
import type { Language } from "./i18n";

export type TaskNodeLabels = {
  blockStack: string;
  customExecutor: string;
  exception: string;
  exceptionOverlay: string;
  more: string;
  noBlockRecords: string;
  openRecord: string;
  savePrompt: string;
  selectedBlock: string;
  selectedTask: string;
  sourcePrompt: string;
  taskException: string;
  taskPrompt: string;
  title: string;
  agent: string;
  blockExecutionSummary: string;
  latestRun: string;
  latestReviewAttempt: string;
  feedbackMarker: string;
  deleteTask: string;
  deleteBlock: string;
  runTask: string;
  runBlock: string;
  deleteTaskConfirm: string;
  deleteBlockConfirm: string;
};

export type TaskNodeData = {
  task: DesktopTaskNodeViewModel;
  titleDraft: string;
  promptDraft: string;
  saveState: "idle" | "saving" | "saved" | "error";
  executorOptions: string[];
  labels: TaskNodeLabels;
  selectedBlock: DesktopBlockDetail | null;
  blockRunRecords: DesktopBlockRunRecordSummary[];
  blockReviewAttempts: DesktopReviewAttemptSummary[];
  blockFeedbackRecords: DesktopFeedbackRecord[];
  onTitleChange: (taskId: string, value: string) => void;
  onTitleSave: (taskId: string) => void;
  onExecutorChange: (taskId: string, executorName: string | null) => void;
  onPromptChange: (taskId: string, value: string) => void;
  onPromptSave: (taskId: string) => void;
  onBlockSelect: (ref: string) => void;
  onOverflowBlockSelect: (ref: string) => void;
  onTaskDelete: (taskId: string) => void;
  onTaskOpen: (taskId: string) => void;
  onAutoRunScopeStart: (scope: DesktopAutoRunScope) => Promise<void>;
  onBlockDelete: (ref: string) => void;
  onSelectedBlockChange: (block: DesktopBlockDetail) => void;
  onBlockTitleSave: () => void;
  onBlockExecutorChange: (executorName: string | null) => void;
  onBlockPromptSave: () => void;
  onOpenRunRecord: (recordId: string | null | undefined) => void;
};

export type TaskFlowNode = Node<TaskNodeData, "task">;

export type CanvasNodeLabels = {
  error: string;
  open: string;
};

export type CanvasNodeData = {
  canvas: DesktopCanvasNodeViewModel;
  labels: CanvasNodeLabels;
  selected: boolean;
  onOpen: (canvasId: string) => void;
  onSelect: (canvasId: string) => void;
};

export type CanvasFlowNode = Node<CanvasNodeData, "canvas">;

export type AppFlowNode = TaskFlowNode;
export type AppView = "new-task" | "graph" | "canvas-map" | "review-pipeline" | "todo" | "statistics" | "search" | "notifications" | "settings";
export type AutoRunScopeMode = "project" | "selectedTask" | "selectedBlock";
export type AppearanceMode = "system" | "light" | "dark";
export type PaletteComponentKey = "task" | "implementation" | "review";
export type PaletteDropComponent = "task" | BlockType;
export type PaletteDropPosition = { x: number; y: number };
export type FloatingControlPosition = { left: number; top: number };
export type FloatingControlDrag = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  containerLeft: number;
  containerTop: number;
  minLeft: number;
  minTop: number;
  maxLeft: number;
  maxTop: number;
};

export type DesktopUiSettings = {
  runtimePath: string;
  defaultExecutor: string;
  appearance: AppearanceMode;
  language: Language;
  pinnedProjectIds: string[];
  readNotificationIds: string[];
  notifications: {
    autoRunFailure: boolean;
    graphExceptions: boolean;
    dirtyPrompts: boolean;
    fileSyncConflict: boolean;
  };
  execution: {
    tmuxMonitoring: boolean;
  };
  review: {
    pipelineEnabled: boolean;
    strictReview: boolean;
    feedbackLoop: boolean;
    autoAppendReviewBlock: boolean;
  };
  palette: {
    visible: Record<PaletteComponentKey, boolean>;
    defaultBlockSet: BlockType[];
    dragHint: boolean;
  };
  agents: Record<DesktopAgentKind, {
    enabled: boolean;
    fullAccess: boolean;
  }>;
};

export type NotificationItem = {
  id: string;
  title: string;
  detail: string;
  tone: "destructive" | "secondary" | "outline";
  read: boolean;
};
