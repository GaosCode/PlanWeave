export const supportedManifestVersion = "plan-package/v0" as const;

export const nodeTypes = [
  "goal",
  "requirement",
  "constraint",
  "decision",
  "component",
  "task",
  "risk"
] as const;

export const edgeTypes = [
  "implements",
  "depends_on",
  "constrained_by",
  "touches",
  "conflicts_with",
  "supersedes"
] as const;

export const taskStatuses = [
  "planned",
  "ready",
  "in_progress",
  "implemented",
  "needs_changes",
  "verified",
  "blocked",
  "diverged"
] as const;

export const runSubmitStatuses = ["implemented", "blocked", "diverged"] as const;
export const reviewStatuses = ["passed", "needs_changes"] as const;

export type NodeType = (typeof nodeTypes)[number];
export type EdgeType = (typeof edgeTypes)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type RunSubmitStatus = (typeof runSubmitStatuses)[number];
export type ReviewStatus = (typeof reviewStatuses)[number];

export type ParallelPolicy = {
  safe: boolean;
  locks: string[];
};

export type ManifestTaskNode = {
  id: string;
  type: "task";
  title: string;
  prompt: string;
  acceptance: string[];
  parallel: ParallelPolicy;
};

export type ManifestContextNode = {
  id: string;
  type: Exclude<NodeType, "task">;
  title: string;
  summary: string;
};

export type ManifestNode = ManifestTaskNode | ManifestContextNode;

export type ManifestEdge = {
  from: string;
  to: string;
  type: EdgeType;
};

export type PlanPackageManifest = {
  version: typeof supportedManifestVersion;
  project: {
    title: string;
    description: string;
  };
  execution: {
    parallel: {
      enabled: boolean;
      maxConcurrent: number;
    };
  };
  global_prompt: string;
  nodes: ManifestNode[];
  edges: ManifestEdge[];
};

export type ProjectMetadata = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
};

export type ProjectWorkspace = {
  id: string;
  rootPath: string;
  workspaceRoot: string;
  projectFile: string;
  packageDir: string;
  manifestFile: string;
  stateFile: string;
  resultsDir: string;
};

export type TaskState = {
  status: TaskStatus;
  claimedBy: string | null;
  lastRunId: string | null;
  blockedBy: string[];
  blockage?: {
    reason: string;
    recordedAt: string;
  };
  divergence?: {
    reason: string;
    recordedAt: string;
  };
};

export type RuntimeState = {
  currentTaskId: string | null;
  tasks: Record<string, TaskState>;
};

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type GraphContext = {
  goals: ManifestNode[];
  requirements: ManifestNode[];
  constraints: ManifestNode[];
  decisions: ManifestNode[];
  components: ManifestNode[];
  conflicts: ManifestNode[];
  supersedes: ManifestNode[];
  supersededBy: ManifestNode[];
};

export type ClaimBuckets = {
  needsChanges: ManifestTaskNode[];
  ready: ManifestTaskNode[];
};

export type CompiledTaskGraph = {
  nodesById: Map<string, ManifestNode>;
  tasksInManifestOrder: ManifestTaskNode[];
  manifestOrderByTask: Map<string, number>;
  edgesByType: Map<EdgeType, ManifestEdge[]>;
  outgoingEdgesByNode: Map<string, ManifestEdge[]>;
  incomingEdgesByNode: Map<string, ManifestEdge[]>;
  dependenciesByTask: Map<string, string[]>;
  dependentsByTask: Map<string, string[]>;
  contextEdgesByTask: Map<string, ManifestEdge[]>;
  locksByTask: Map<string, Set<string>>;
  dependencyAdjacency: Map<string, string[]>;
  reverseDependencyAdjacency: Map<string, string[]>;
  diagnostics: {
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
  };
  reachable(from: string, to: string): boolean;
  invalidateReachability(): void;
  blockedReasonByTask(state: RuntimeState): Map<string, string[]>;
  claimBuckets(state: RuntimeState): ClaimBuckets;
  explainBlocked(taskId: string, state: RuntimeState): string[];
  relatedContext(taskId: string): GraphContext;
};

export type ValidationReport = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export type GraphEditResult = {
  ok: boolean;
  affectedTasks: string[];
  diagnostics: ValidationIssue[];
  graph?: CompiledTaskGraph;
};

export type InitWorkspaceResult = {
  workspace: ProjectWorkspace;
  project: ProjectMetadata;
  created: boolean;
  backup?: {
    backupDir: string;
    packageDir?: string;
    stateFile?: string;
    resultsDir?: string;
  };
};

export type ProjectPathsResult = {
  workspaceDir: string;
  projectId: string;
  projectDir: string;
  packageDir: string;
  statePath: string;
  resultsDir: string;
};

export type PromptSurface = {
  taskId: string;
  path: string;
  markdown: string;
};

export type RefreshPromptsResult = {
  prompts: PromptSurface[];
};

export type ClaimResult = {
  taskId: string | null;
  status: "claimed" | "current" | "none";
  task?: TaskState;
};

export type ParallelClaimResult = {
  taskIds: string[];
  status: "claimed" | "disabled" | "current" | "none";
};

export type VerificationSource = "review" | "manual";

export type TaskLifecycleEvent =
  | {
      type: "claimed";
      taskId: string;
      at: string;
      source: "agent";
    }
  | {
      type: "run_submitted";
      taskId: string;
      runId: string;
      status: RunSubmitStatus;
      at: string;
    }
  | {
      type: "review_submitted";
      taskId: string;
      reviewId: string;
      status: ReviewStatus;
      taskStatus: "verified" | "needs_changes";
      reviewer: "human";
      at: string;
    }
  | {
      type: "verified";
      taskId: string;
      source: VerificationSource;
      at: string;
    }
  | {
      type: "diverged";
      taskId: string;
      reason: string;
      at: string;
    }
  | {
      type: "blocked";
      taskId: string;
      reason: string;
      at: string;
    }
  | {
      type: "unblocked";
      taskId: string;
      at: string;
    }
  | {
      type: "divergence_resolved";
      taskId: string;
      reason: string;
      at: string;
    };

export type ResultIndex = {
  taskId: string;
  status: TaskStatus;
  latestRunId: string | null;
  runCount: number;
  review?: {
    status: ReviewStatus;
    reviewedAt: string;
    reviewer: "human";
    reviewId?: string;
    path?: string;
  };
  reviewHistory?: Array<{
    reviewId: string;
    status: ReviewStatus;
    reviewedAt: string;
    reviewer: "human";
    path: string;
    runId: string;
  }>;
  divergence?: {
    reason: string;
    recordedAt: string;
  };
  verification?: {
    source: VerificationSource;
    verifiedAt: string;
  };
  blockage?: {
    reason: string;
    recordedAt: string;
  };
  events?: TaskLifecycleEvent[];
};

export type SubmitResult = {
  taskId: string;
  runId: string;
  status: RunSubmitStatus;
  index: ResultIndex;
};

export type SubmitReviewResult = {
  taskId: string;
  status: ReviewStatus;
  taskStatus: "verified" | "needs_changes";
  index: ResultIndex;
};

export type MarkVerifiedResult = {
  taskId: string;
  status: "verified";
};

export type MarkDivergedResult = {
  taskId: string;
  status: "diverged";
  reason: string;
};

export type MarkBlockedResult = {
  taskId: string;
  status: "blocked";
  reason: string;
};

export type UnblockResult = {
  taskId: string;
  status: "planned" | "ready" | "needs_changes";
};

export type ResolveDivergenceResult = {
  taskId: string;
  status: "planned" | "ready" | "needs_changes";
  reason: string;
};

export type TaskReasonSummary = {
  taskId: string;
  reason: string | null;
};

export type OrphanStateSummary = {
  taskId: string;
  status: TaskStatus;
  lastRunId: string | null;
};

export type OrphanResultSummary = {
  taskId: string;
  path: string;
};

export type PlanStatus = {
  projectId: string;
  projectRoot: string;
  taskTotal: number;
  counts: Record<TaskStatus, number>;
  currentTaskId: string | null;
  inProgress: string[];
  nextClaimable: string[];
  blockedTasks: TaskReasonSummary[];
  needsChangesTasks: string[];
  divergedTasks: TaskReasonSummary[];
  orphanState: OrphanStateSummary[];
  orphanResults: OrphanResultSummary[];
  noClaimReason: "has_claimable" | "all_done" | "dependency_blocked" | "blocked" | "diverged" | "no_tasks";
  needsChanges: number;
  diverged: number;
};
