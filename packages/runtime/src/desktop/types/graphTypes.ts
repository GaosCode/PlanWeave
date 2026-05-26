import type {
  BlockStatus,
  BlockType,
  EdgeType,
  GraphEditResult,
  ReviewGateHint,
  TaskStatus,
  ValidationIssue
} from "../../types.js";

export type DesktopTaskException = {
  ref: string;
  reason: string;
  source: "blocked" | "diverged" | "feedback" | "needs_changes";
};

export type DesktopBlockPreview = {
  ref: string;
  blockId: string;
  type: BlockType;
  title: string;
  status: BlockStatus;
  executor: string | null;
  promptMissing: boolean;
  exceptionReason: string | null;
};

export type DesktopTaskNodeViewModel = {
  taskId: string;
  title: string;
  status: TaskStatus;
  executor: string | null;
  executorLabel: string;
  promptMarkdown: string;
  promptMissing: boolean;
  promptPreview: string;
  blocks: DesktopBlockPreview[];
  blockPreview: DesktopBlockPreview[];
  hiddenBlockRefs: string[];
  overflowBlockCount: number;
  exceptions: DesktopTaskException[];
};

export type DesktopGraphEdgeViewModel = {
  from: string;
  to: string;
  type: EdgeType;
};

export type DesktopGraphViewModel = {
  projectId: string;
  projectTitle: string;
  executorOptions: string[];
  tasks: DesktopTaskNodeViewModel[];
  edges: DesktopGraphEdgeViewModel[];
  diagnostics: ValidationIssue[];
  dirtyPromptRefs: string[];
};

export type DesktopTaskDetail = {
  taskId: string;
  title: string;
  status: TaskStatus;
  executor: string | null;
  promptMarkdown: string;
  promptMissing: boolean;
  acceptance: string[];
  blockOrder: string[];
};

export type DesktopTaskExecutionOrder = {
  taskId: string;
  blockRefs: string[];
};

export type DesktopBlockDetail = {
  ref: string;
  taskId: string;
  blockId: string;
  type: BlockType;
  title: string;
  status: BlockStatus;
  executor: string | null;
  effectiveExecutor: string | null;
  promptMarkdown: string;
  promptMissing: boolean;
  dependencies: string[];
  latestRunId: string | null;
  latestReviewAttemptId: string | null;
  activeFeedbackId: string | null;
  exceptionReason: string | null;
  reviewGate: ReviewGateHint | null;
};

export type DesktopLayoutNode = {
  nodeId: string;
  x: number;
  y: number;
};

export type DesktopLayout = {
  version: "desktop-layout/v1";
  projectId: string;
  nodes: DesktopLayoutNode[];
  updatedAt: string;
};

export type DesktopTodoGroupName = BlockStatus | "implemented";

export type DesktopTodoItem = {
  canvasId?: string;
  canvasName?: string;
  ref: string;
  taskId: string;
  blockId: string;
  title: string;
  status: BlockStatus;
  dependencyBlockers: string[];
  parallelSafe: boolean;
  locks: string[];
  reviewGate: ReviewGateHint | null;
};

export type DesktopTodoGroups = Record<DesktopTodoGroupName, DesktopTodoItem[]>;

export type DesktopStatistics = {
  taskTotal: number;
  implementedTaskCount: number;
  implementedRatio: number;
  taskThroughput: number;
  blockTotal: number;
  completedBlockCount: number;
  averageImplementationTimeMs: number | null;
  reviewPassedCount: number;
  reviewPassedRatio: number;
  feedbackEnvelopeCount: number;
  reworkCount: number;
  estimatedRemainingBlocks: number;
};

export type DesktopSearchResultKind = "task" | "block" | "prompt" | "run_record" | "review_attempt" | "feedback";

export type DesktopSearchFilters = {
  kinds?: DesktopSearchResultKind[];
};

export type DesktopSearchResult = {
  kind: DesktopSearchResultKind;
  canvasId?: string;
  canvasName?: string;
  ref: string;
  targetRef?: string;
  title: string;
  excerpt: string;
  recordId?: string;
  path?: string;
};

export type DesktopTaskDraftMode = "task" | "blocks" | "document";

export type DesktopTaskDraft = {
  mode: DesktopTaskDraftMode;
  targetTaskId: string | null;
  tasks: Array<{
    title: string;
    promptMarkdown: string;
    acceptance: string[];
    blockTypes: BlockType[];
  }>;
  blocks: Array<{
    taskId: string;
    type: BlockType;
    title: string;
    promptMarkdown: string;
  }>;
};

export type DesktopAddTaskInput = {
  title: string;
  promptMarkdown: string;
  acceptance?: string[];
  blockTypes?: BlockType[];
  executor?: string | null;
};

export type DesktopAddBlockInput = {
  taskId: string;
  type: BlockType;
  title: string;
  promptMarkdown: string;
  executor?: string | null;
  dependsOn?: string[];
};

export type DesktopGraphEditValidationInput =
  | { kind: "addDependencyEdge"; fromTaskId: string; toTaskId: string }
  | { kind: "removeDependencyEdge"; fromTaskId: string; toTaskId: string }
  | { kind: "removeTaskNode"; taskId: string }
  | { kind: "removeBlock"; blockRef: string };

export type DesktopGraphEditResult = Omit<GraphEditResult, "graph">;
