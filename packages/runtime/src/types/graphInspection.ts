import type { BlockType } from "./manifest.js";
import type { BlockStatus, TaskStatus } from "./state.js";
import type { PackageWorkspaceRef } from "./workspace.js";

export type GraphInspectionView = "summary" | "tasks" | "slice";

export type InspectGraphInput = {
  projectRoot: PackageWorkspaceRef;
  view: GraphInspectionView;
  limit?: number;
  cursor?: string;
  taskId?: string;
};

export type GraphInspectionPage = {
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  total: number;
  truncated: boolean;
};

export type GraphInspectionBoundedSection<T> = {
  limit: number;
  total: number;
  truncated: boolean;
  items: T[];
};

export type GraphInspectionTask = {
  taskId: string;
  title: string;
  status: TaskStatus;
  acceptanceCount: number;
  blockCount: number;
  reviewBlockCount: number;
  dependsOn: string[];
  dependents: string[];
  promptMissing: boolean;
};

export type GraphInspectionBlock = {
  ref: string;
  blockId: string;
  type: BlockType;
  title: string;
  status: BlockStatus;
  dependsOn: string[];
};

export type GraphInspectionEdge = {
  from: string;
  to: string;
  type: "depends_on";
};

export type GraphInspectionCounts = {
  taskCount: number;
  blockCount: number;
  taskDependencyCount: number;
  reviewBlockCount: number;
  readyBlockCount: number;
  diagnosticCount: number;
};

export type GraphInspectionProjectInfo = {
  id: string;
  title: string;
  description: string;
};

export type GraphInspectionCanvasInfo = {
  id: string | null;
  title: string;
};

export type GraphInspectionSummaryResult = {
  view: "summary";
  project: GraphInspectionProjectInfo;
  canvas: GraphInspectionCanvasInfo;
  counts: GraphInspectionCounts;
  tasksPreview: GraphInspectionTask[];
  page: GraphInspectionPage;
};

export type GraphInspectionTasksResult = {
  view: "tasks";
  tasks: GraphInspectionTask[];
  page: GraphInspectionPage;
};

export type GraphInspectionSliceResult = {
  view: "slice";
  taskId: string;
  center: GraphInspectionTask;
  dependencies: GraphInspectionBoundedSection<GraphInspectionTask>;
  dependents: GraphInspectionBoundedSection<GraphInspectionTask>;
  edges: GraphInspectionBoundedSection<GraphInspectionEdge>;
  blocks: GraphInspectionBoundedSection<GraphInspectionBlock>;
};

export type GraphInspectionResult =
  | GraphInspectionSummaryResult
  | GraphInspectionTasksResult
  | GraphInspectionSliceResult;

export type GraphQualityReviewPolicy = "none" | "risk-based" | "required";

export type GraphQualityGatePolicy = "none" | "required";

export type GraphQualityHeuristics = "on" | "off";

export type ValidateGraphQualityInput = {
  projectRoot: PackageWorkspaceRef;
  reviewPolicy?: GraphQualityReviewPolicy;
  gatePolicy?: GraphQualityGatePolicy;
  heuristics?: GraphQualityHeuristics;
  strict?: boolean;
  minTaskCountForSparseCheck?: number;
};

export type GraphQualityDiagnosticSeverity = "error" | "warning" | "info";

export type GraphQualityRuleType = "structural" | "policy" | "heuristic";

export type GraphQualityDiagnostic = {
  code: string;
  severity: GraphQualityDiagnosticSeverity;
  message: string;
  count: number;
  examples: string[];
  suggestion: string;
  suggestedTool?: string;
  fixId?: string;
  ruleType: GraphQualityRuleType;
  affectedIds?: string[];
};

export type GraphQualitySummary = {
  taskCount: number;
  blockCount: number;
  taskDependencyCount: number;
  reviewBlockCount: number;
  orphanTaskCount: number;
  score: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
};

export type GraphQualityReport = {
  ok: boolean;
  summary: GraphQualitySummary;
  diagnostics: GraphQualityDiagnostic[];
};

export type ExecutionReadinessDiagnostic = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  affectedRefs: string[];
  suggestedTool?: string;
};

export type ExecutionReadinessReport = {
  ok: boolean;
  summary: {
    taskCount: number;
    blockCount: number;
    readyBlockCount: number;
    currentRefCount: number;
    openFeedbackCount: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
  diagnostics: ExecutionReadinessDiagnostic[];
  nextClaimable: string[];
};
