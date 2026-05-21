import type { Node } from "@xyflow/react";
import type {
  BlockType,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopContextNodeViewModel,
  DesktopFeedbackRecord,
  DesktopReviewAttemptSummary,
  DesktopTaskNodeViewModel
} from "@planweave/runtime";
import type { Language } from "./i18n";

export type TaskNodeLabels = {
  blockStack: string;
  exception: string;
  exceptionOverlay: string;
  inherit: string;
  more: string;
  noBlockRecords: string;
  openRecord: string;
  savePrompt: string;
  selectedBlock: string;
  sourcePrompt: string;
  taskException: string;
  taskPrompt: string;
  title: string;
  agent: string;
  effectiveExecutor: string;
  blockExecutionSummary: string;
  latestRun: string;
  latestReviewAttempt: string;
  feedbackMarker: string;
  manualExecutor: string;
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
  onSelectedBlockChange: (block: DesktopBlockDetail) => void;
  onBlockTitleSave: () => void;
  onBlockExecutorChange: (executorName: string | null) => void;
  onBlockPromptSave: () => void;
  onOpenRunRecord: (recordId: string | null | undefined) => void;
};

export type TaskFlowNode = Node<TaskNodeData, "task">;

export type ContextNodeData = {
  node: DesktopContextNodeViewModel;
  selected: boolean;
};

export type ContextFlowNode = Node<ContextNodeData, "context">;
export type AppFlowNode = TaskFlowNode | ContextFlowNode;
export type AppView = "new-task" | "graph" | "review-pipeline" | "todo" | "statistics" | "search" | "notifications" | "settings";
export type AutoRunScopeMode = "project" | "selectedTask" | "selectedBlock";
export type AppearanceMode = "system" | "light" | "dark";
export type PaletteComponentKey = "task" | "implementation" | "check" | "review" | "context";
export type PaletteDropComponent = "task" | "context" | BlockType;
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
  notifications: {
    autoRunFailure: boolean;
    graphExceptions: boolean;
    dirtyPrompts: boolean;
    fileSyncConflict: boolean;
  };
  palette: {
    visible: Record<PaletteComponentKey, boolean>;
    defaultBlockSet: BlockType[];
    dragHint: boolean;
  };
};

export type NotificationItem = {
  id: string;
  title: string;
  detail: string;
  tone: "destructive" | "secondary" | "outline";
};
