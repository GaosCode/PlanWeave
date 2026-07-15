import type { Node } from "@xyflow/react";
import type {
  DesktopAgentDetection,
  DesktopAutoRunScope,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopCanvasHealthCanvasSummary,
  DesktopCanvasNodeViewModel,
  DesktopFeedbackRecord,
  DesktopReviewAttemptSummary,
  DesktopTaskNodeViewModel,
  RunnerTransport
} from "@planweave-ai/runtime";
import type {
  DesktopSettingsPatch,
  DesktopUiSettings,
  FloatingControlPosition
} from "../shared/desktopSettings";
import type { TaskWorkspaceNavigationTarget } from "./taskWorkspaceNavigation";
export type {
  AppearanceMode,
  DesktopSettingsPatch,
  DesktopSettingsLanguage,
  DesktopUiSettings,
  FloatingControlPosition,
  PaletteComponentKey
} from "../shared/desktopSettings";
export { appViewSchema, type AppView } from "./appViewContract";

export type DesktopSettingsUpdate =
  | DesktopSettingsPatch
  | ((current: DesktopUiSettings) => DesktopSettingsPatch);

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
  unavailable: string;
  blockExecutionSummary: string;
  latestRun: string;
  latestReviewAttempt: string;
  feedbackMarker: string;
  deleteTask: string;
  deleteBlock: string;
  copyAgentPrompt: string;
  openTaskInFileManager: string;
  runTask: string;
  runBlock: string;
  inspectTask: string;
  inspectBlock: string;
  deleteTaskConfirm: string;
  deleteBlockConfirm: string;
  sharedResource: string;
  sharedResourceActive: string;
  moreResources: (count: number) => string;
};

export type TaskNodeData = {
  task: DesktopTaskNodeViewModel;
  titleDraft: string;
  promptDraft: string;
  saveState: "idle" | "saving" | "saved" | "error";
  agentDetections: DesktopAgentDetection[];
  agentTransport?: RunnerTransport;
  executorOptions: string[];
  packageExecutorNames?: string[];
  labels: TaskNodeLabels;
  selectedBlock: DesktopBlockDetail | null;
  blockRunRecords: DesktopBlockRunRecordSummary[];
  blockReviewAttempts: DesktopReviewAttemptSummary[];
  blockFeedbackRecords: DesktopFeedbackRecord[];
  sharedResources: string[];
  activeSharedResources: Set<string>;
  highlightedResource: string | null;
  resourceHighlighted: boolean;
  dimmed: boolean;
  transitionEpochByResource: Record<string, number>;
  onTitleChange: (taskId: string, value: string) => void;
  onTitleSave: (taskId: string) => void;
  onExecutorChange: (taskId: string, executorName: string | null) => void;
  onPromptChange: (taskId: string, value: string) => void;
  onPromptSave: (taskId: string) => void;
  onPromptHistoryRedo: () => Promise<void>;
  onPromptHistoryUndo: () => Promise<void>;
  onBlockSelect: (ref: string) => void;
  onBlockWorkspaceOpen: (ref: string) => void;
  onOverflowBlockSelect: (ref: string) => void;
  onTaskDelete: (taskId: string) => void;
  onTaskOpen: (taskId: string) => void;
  onTaskWorkspaceOpen: (taskId: string) => void;
  onAgentPromptCopy: (taskId: string) => void;
  onRevealTaskInFinder: (taskId: string) => void;
  onAutoRunScopeStart: (scope: DesktopAutoRunScope) => Promise<void>;
  onBlockDelete: (ref: string) => void;
  onSelectedBlockChange: (block: DesktopBlockDetail) => void;
  onBlockTitleSave: () => void;
  onBlockExecutorChange: (executorName: string | null) => void;
  onBlockPromptSave: () => void;
  onOpenRunRecord: (recordId: string | null | undefined) => void;
  onResourceHover: (name: string | null) => void;
  onResourcePin: (name: string | null) => void;
  onResourceOverflow: (taskId: string) => void;
};

export type TaskFlowNode = Node<TaskNodeData, "task">;

export type CanvasNodeLabels = {
  copyAgentPrompt: string;
  dependency: string;
  error: string;
  openInFileManager: string;
  open: string;
  rename: string;
  warning: string;
};

export type CanvasNodeData = {
  canvas: DesktopCanvasNodeViewModel;
  health: DesktopCanvasHealthCanvasSummary | null;
  labels: CanvasNodeLabels;
  selected: boolean;
  onOpen: (canvasId: string) => void;
  onAgentPromptCopy: (canvas: DesktopCanvasNodeViewModel) => void;
  onRevealInFinder: (canvasId: string) => void;
  onRename: (canvas: DesktopCanvasNodeViewModel) => void;
  onSelect: (canvasId: string) => void;
};

export type CanvasFlowNode = Node<CanvasNodeData, "canvas">;

export type AppFlowNode = TaskFlowNode;
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

type BaseNotificationItem = {
  id: string;
  title: string;
  detail: string;
  tone: "destructive" | "secondary" | "outline";
  navigationIntent?: NotificationNavigationIntent;
};

export type NotificationNavigationIntent =
  | {
      kind: "task-workspace";
      target: TaskWorkspaceNavigationTarget;
    }
  | {
      kind: "run-record-lookup";
      locator: {
        projectRoot: string;
        canvasId: string;
        recordId: string;
      };
    };

export type NotificationItemDraft =
  | (BaseNotificationItem & {
      kind?: "fileSync" | "promptConflict" | "default";
    })
  | (BaseNotificationItem & {
      kind: "importRecovery";
      transactionId: string;
      recoveryRoot: string;
    });

export type NotificationItem = NotificationItemDraft & {
  read: boolean;
};
