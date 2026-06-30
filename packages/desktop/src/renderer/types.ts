import type { Node } from "@xyflow/react";
import type {
  DesktopAutoRunScope,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopCanvasHealthCanvasSummary,
  DesktopCanvasNodeViewModel,
  DesktopFeedbackRecord,
  DesktopReviewAttemptSummary,
  DesktopTaskNodeViewModel
} from "@planweave-ai/runtime";
import type { DesktopSettingsPatch, DesktopUiSettings, FloatingControlPosition } from "../shared/desktopSettings";
export type {
  AppearanceMode,
  DesktopSettingsPatch,
  DesktopSettingsLanguage,
  DesktopUiSettings,
  FloatingControlPosition,
  PaletteComponentKey
} from "../shared/desktopSettings";

export type DesktopSettingsUpdate = DesktopSettingsPatch | ((current: DesktopUiSettings) => DesktopSettingsPatch);

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
  copyAgentPrompt: string;
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
  onPromptHistoryRedo: () => Promise<void>;
  onPromptHistoryUndo: () => Promise<void>;
  onBlockSelect: (ref: string) => void;
  onOverflowBlockSelect: (ref: string) => void;
  onTaskDelete: (taskId: string) => void;
  onTaskOpen: (taskId: string) => void;
  onAgentPromptCopy: (taskId: string) => void;
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
  blocked: string;
  copyAgentPrompt: string;
  error: string;
  open: string;
  warning: string;
};

export type CanvasNodeData = {
  canvas: DesktopCanvasNodeViewModel;
  health: DesktopCanvasHealthCanvasSummary | null;
  labels: CanvasNodeLabels;
  selected: boolean;
  onOpen: (canvasId: string) => void;
  onAgentPromptCopy: (canvasId: string) => void;
  onSelect: (canvasId: string) => void;
};

export type CanvasFlowNode = Node<CanvasNodeData, "canvas">;

export type AppFlowNode = TaskFlowNode;
export type AppView = "new-task" | "graph" | "canvas-map" | "review-pipeline" | "todo" | "statistics" | "search" | "notifications" | "settings";
export type AutoRunScopeMode = "project" | "selectedTask" | "selectedBlock";
export type PaletteDropComponent = "task" | import("@planweave-ai/runtime").BlockType;
export type PaletteDropPosition = { x: number; y: number };
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

export type NotificationItem = {
  id: string;
  title: string;
  detail: string;
  tone: "destructive" | "secondary" | "outline";
  read: boolean;
  kind?: "fileSync" | "promptConflict" | "default";
};
