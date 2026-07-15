import type {
  BlockStatus,
  BlockType,
  EdgeType,
  ExecutionReadinessReport,
  GraphEditResult,
  GraphQualityReport,
  ReviewGateHint,
  TaskStatus,
  ValidationIssue
} from "../../types.js";
import type { PromptSourceSummary } from "../../taskManager/promptContracts.js";
import type { ProjectPromptPolicy } from "../../projectPromptPolicy.js";
import type { PendingImportTransaction } from "../../package/importRecovery.js";
import type { RunnerTransport } from "../../types.js";

export type DesktopTaskException = {
  ref: string;
  reason: string;
  source: "blocked" | "diverged" | "needs_changes";
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
  /** True when claim/dispatch can start this block now. */
  dispatchable: boolean;
};

export type DesktopSharedResourceGroup = {
  name: string;
  memberTaskIds: string[];
  memberBlockRefs: string[];
  /** Members currently executing; multiple refs indicate active shared-resource overlap. */
  activeBlockRefs: string[];
};

export type DesktopTaskNodeViewModel = {
  taskId: string;
  title: string;
  status: TaskStatus;
  executor: string | null;
  executorLabel: string;
  promptMarkdown: string;
  promptHash?: string;
  promptMissing: boolean;
  promptPreview: string;
  /** Union of non-blocking shared-resource hints on implementation blocks. */
  sharedResources: string[];
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
  graphVersion: string;
  packageFingerprint: string;
  executorOptions: string[];
  packageExecutorNames?: string[];
  agentTransport?: RunnerTransport;
  autoRunPreflightExecutorHint: string | null;
  tasks: DesktopTaskNodeViewModel[];
  edges: DesktopGraphEdgeViewModel[];
  /** Informational coordination groups; these never gate dispatch. */
  sharedResourceGroups: DesktopSharedResourceGroup[];
  diagnostics: ValidationIssue[];
  dirtyPromptRefs: string[];
};

export type DesktopGraphDiagnosticSource = "graph_quality" | "execution_readiness";

export type DesktopGraphDiagnosticIssue = ValidationIssue & {
  source: DesktopGraphDiagnosticSource;
  severity: "error" | "warning" | "info";
  ruleType?: "structural" | "policy" | "heuristic";
  affectedIds?: string[];
  suggestedTool?: string;
  fixId?: string;
};

export type DesktopGraphDiagnostics = {
  graphQuality: GraphQualityReport;
  executionReadiness: ExecutionReadinessReport;
  diagnostics: DesktopGraphDiagnosticIssue[];
};

export type DesktopCanvasDiagnosticIssue = ValidationIssue & {
  severity: "error" | "warning";
};

export type DesktopCanvasNodeViewModel = {
  canvasId: string;
  title: string;
  status: TaskStatus | null;
  packageDir: string;
  executionPolicy: DesktopCanvasExecutionPolicy | null;
  diagnostics: DesktopCanvasDiagnosticIssue[];
};

export type DesktopCanvasExecutionPolicy = {
  parallelEnabled: boolean;
  maxConcurrent: number;
};

export type DesktopCanvasHealthSeverity = "ok" | "warning" | "error";

export type DesktopCanvasHealthTaskRef = {
  canvasId: string;
  canvasTitle: string;
  taskId: string;
  taskTitle: string;
};

export type DesktopCanvasHealthBlockRef = DesktopCanvasHealthTaskRef & {
  blockRef: string;
  blockId: string;
  blockTitle: string;
  status: BlockStatus;
};

export type DesktopCanvasHealthBlocker =
  | {
      kind: "canvas";
      canvasId: string;
      canvasTitle: string;
    }
  | {
      kind: "task";
      canvasId: string;
      canvasTitle: string;
      taskId: string;
      taskTitle: string;
      status: TaskStatus;
    };

export type DesktopCanvasHealthBlockedBlock = {
  blocked: DesktopCanvasHealthBlockRef;
  blockers: DesktopCanvasHealthBlocker[];
  reason: string;
};

export type DesktopCanvasHealthCanvasSummary = {
  canvasId: string;
  severity: DesktopCanvasHealthSeverity;
  blockerCount: number;
  diagnosticCount: number;
};

export type DesktopCanvasHealthEdgeSummary = {
  from: string;
  to: string;
  type: "depends_on";
  severity: DesktopCanvasHealthSeverity;
  blockerCount: number;
  diagnosticCount: number;
};

export type DesktopCanvasHealth = {
  severity: DesktopCanvasHealthSeverity;
  canvases: DesktopCanvasHealthCanvasSummary[];
  edges: DesktopCanvasHealthEdgeSummary[];
  blockedBlocks: DesktopCanvasHealthBlockedBlock[];
  diagnostics: ValidationIssue[];
};

export type DesktopCanvasGraphEdgeViewModel = {
  from: string;
  to: string;
  type: "depends_on";
};

export type DesktopCrossCanvasTaskEdgeViewModel = {
  from: {
    canvasId: string;
    taskId: string;
  };
  to: {
    canvasId: string;
    taskId: string;
  };
  type: "depends_on";
};

export type DesktopCanvasGraphViewModel = {
  projectId: string;
  projectTitle: string;
  canvases: DesktopCanvasNodeViewModel[];
  edges: DesktopCanvasGraphEdgeViewModel[];
  crossTaskEdges: DesktopCrossCanvasTaskEdgeViewModel[];
  diagnostics: ValidationIssue[];
  health: DesktopCanvasHealth;
};

export type DesktopCanvasMapLayoutNode = {
  canvasId: string;
  x: number;
  y: number;
};

export type DesktopCanvasMapLayout = {
  version: "desktop-canvas-map-layout/v1";
  projectId: string;
  nodes: DesktopCanvasMapLayoutNode[];
  updatedAt: string;
};

export type DesktopTaskDetail = {
  taskId: string;
  graphVersion?: string;
  title: string;
  status: TaskStatus;
  executor: string | null;
  promptMarkdown: string;
  promptHash?: string;
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
  graphVersion?: string;
  taskId: string;
  blockId: string;
  type: BlockType;
  title: string;
  status: BlockStatus;
  executor: string | null;
  effectiveExecutor: string | null;
  promptMarkdown: string;
  promptHash?: string;
  promptMissing: boolean;
  promptSurfaceMarkdown: string;
  promptSources: PromptSourceSummary[];
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
  dispatchable: boolean;
  sharedResources: string[];
  reviewGate: ReviewGateHint | null;
};

export type DesktopTodoGroups = Record<DesktopTodoGroupName, DesktopTodoItem[]>;

export type DesktopProjectExecutionPhase = {
  phaseIndex: number;
  canvasId: string;
  canvasName: string;
  taskCount: number;
  readyQueue: DesktopTodoItem[];
  parallelReadyQueue: DesktopTodoItem[];
  sequentialReadyQueue: DesktopTodoItem[];
  blockedCount: number;
  inProgressCount: number;
  completedCount: number;
};

export type DesktopProjectExecutionPlan = {
  phases: DesktopProjectExecutionPhase[];
  readyQueue: DesktopTodoItem[];
  notes: string[];
};

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

export type DesktopProjectSnapshot = {
  projectPromptMarkdown: string | null;
  projectPromptPolicy: ProjectPromptPolicy | null;
  graph: DesktopGraphViewModel | null;
  layout: DesktopLayout | null;
  todoGroups: DesktopTodoGroups | null;
  executionPlan: DesktopProjectExecutionPlan | null;
  statistics: DesktopStatistics | null;
  pendingImportRecoveries: PendingImportTransaction[];
  diagnostics: ValidationIssue[];
  errors: string[];
};

export type DesktopSearchResultKind =
  | "task"
  | "block"
  | "prompt"
  | "run_record"
  | "review_attempt"
  | "feedback";

export type DesktopSearchFilters = {
  kinds?: DesktopSearchResultKind[];
  canvasId?: string | null;
  includeBodies?: boolean;
  limit?: number;
};

export type DesktopSearchMatchField = "title" | "body";

export type DesktopSearchMatch = {
  field: DesktopSearchMatchField;
  start: number;
  length: number;
  excerpt: string;
  excerptStart: number;
};

export type DesktopSearchResult = {
  kind: DesktopSearchResultKind;
  canvasId?: string;
  canvasName?: string;
  ref: string;
  targetRef?: string;
  title: string;
  excerpt: string;
  match?: DesktopSearchMatch;
  recordId?: string;
  path?: string;
};

export type DesktopSearchProjection = {
  results: DesktopSearchResult[];
  diagnostics: ValidationIssue[];
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
  layoutPosition?: {
    x: number;
    y: number;
  };
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
