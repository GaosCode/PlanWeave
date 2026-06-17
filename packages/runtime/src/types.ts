export const supportedManifestVersion = "plan-package/v1" as const;

export const nodeTypes = ["task"] as const;

export const edgeTypes = ["depends_on"] as const;

export const blockTypes = ["implementation", "review"] as const;
export const taskStatuses = ["planned", "ready", "in_progress", "implemented"] as const;
export const blockStatuses = ["planned", "ready", "in_progress", "completed", "needs_changes", "blocked", "diverged"] as const;
export const feedbackStatuses = ["open", "in_progress", "resolved", "dismissed"] as const;
export const reviewVerdicts = ["passed", "needs_changes"] as const;

export type NodeType = (typeof nodeTypes)[number];
export type EdgeType = (typeof edgeTypes)[number];
export type BlockType = (typeof blockTypes)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type BlockStatus = (typeof blockStatuses)[number];
export type FeedbackStatus = (typeof feedbackStatuses)[number];
export type ReviewVerdict = (typeof reviewVerdicts)[number];

export type ReviewHookDefinition = {
  id: string;
  type: "executable";
  command: string;
  args: string[];
  executionPolicy: "trusted-local";
};

export type ReviewTriggerCondition = "after_required_work_completed" | "manual";

export type ManualExecutorProfile = {
  adapter: "manual";
};

export type CodexExecExecutorProfile = {
  adapter: "codex-exec";
  command: string;
  args: string[];
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  role?: string;
  timeoutMs?: number;
};

export type OpencodeExecExecutorProfile = {
  adapter: "opencode-exec";
  command: string;
  args: string[];
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
};

export type ClaudeCodeExecExecutorProfile = {
  adapter: "claude-code-exec";
  command: string;
  args: string[];
  timeoutMs?: number;
};

export type PiExecExecutorProfile = {
  adapter: "pi-exec";
  command: string;
  args: string[];
  timeoutMs?: number;
};

export type LocalReviewExecutorProfile = {
  adapter: "local-review";
  command: string;
  args: string[];
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
};

export type ExecutorProfile =
  | ManualExecutorProfile
  | CodexExecExecutorProfile
  | OpencodeExecExecutorProfile
  | ClaudeCodeExecExecutorProfile
  | PiExecExecutorProfile
  | LocalReviewExecutorProfile;

export type ExecutorProfileSummary = ExecutorProfile & {
  name: string;
  source: "builtin" | "package";
};

export type BlockParallelPolicy = {
  safe: boolean;
  locks: string[];
};

export type ManifestImplementationBlock = {
  id: string;
  type: "implementation";
  title: string;
  prompt: string;
  depends_on: string[];
  executor?: string;
  parallel: BlockParallelPolicy;
};

export type ManifestReviewBlock = {
  id: string;
  type: "review";
  title: string;
  prompt: string;
  depends_on: string[];
  executor?: string;
  review: {
    required: boolean;
    maxFeedbackCycles: number;
    preset?: string;
    triggerCondition?: ReviewTriggerCondition;
    inputContext?: string;
    passCriteria?: string;
    feedbackFormat?: string;
    hook: ReviewHookDefinition | null;
  };
};

export type ManifestBlock = ManifestImplementationBlock | ManifestReviewBlock;

export type ManifestTaskNode = {
  id: string;
  type: "task";
  title: string;
  prompt: string;
  executor?: string;
  acceptance: string[];
  blocks: ManifestBlock[];
};

export type ManifestNode = ManifestTaskNode;

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
    defaultExecutor?: string;
    parallel: {
      enabled: boolean;
      maxConcurrent: number;
    };
  };
  review: {
    maxFeedbackCycles: number;
    completionPolicy: "strict";
  };
  executors?: Record<string, ExecutorProfile>;
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
  planweaveHome: string;
  workspaceRoot: string;
  projectFile: string;
  packageDir: string;
  manifestFile: string;
  stateFile: string;
  resultsDir: string;
  projectPromptFile: string;
};

export type PackageWorkspaceRef = string | ProjectWorkspace;

export type TaskState = {
  status: TaskStatus;
  openFeedbackCount: number;
};

export type BlockState = {
  status: BlockStatus;
  lastRunId?: string | null;
  latestReviewAttemptId?: string | null;
  activeFeedbackId?: string | null;
  pendingFeedbackId?: string | null;
  blockedReason?: string | null;
  divergenceReason?: string | null;
  completionReason?: "passed" | "max_cycles_reached" | null;
  passedWorkRevision?: string | null;
};

export type FeedbackEnvelopeState = {
  status: FeedbackStatus;
  sourceReviewBlockRef: string;
  latestSubmissionId: string | null;
  content: string;
};

export type RuntimeState = {
  currentRefs: string[];
  currentFeedbackId: string | null;
  currentReviewBlockRef: string | null;
  tasks: Record<string, TaskState>;
  blocks: Record<string, BlockState>;
  feedback: Record<string, FeedbackEnvelopeState>;
};

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type CompiledExecutionGraph = {
  nodesById: Map<string, ManifestNode>;
  taskNodesInManifestOrder: string[];
  tasksById: Map<string, ManifestTaskNode>;
  taskDependenciesByTask: Map<string, string[]>;
  taskDependentsByTask: Map<string, string[]>;
  blockRefsInManifestOrder: string[];
  blocksByRef: Map<string, ManifestBlock>;
  blockTaskByRef: Map<string, string>;
  blocksByTask: Map<string, string[]>;
  blockDependenciesByRef: Map<string, string[]>;
  blockDependentsByRef: Map<string, string[]>;
  reviewBlocksByTask: Map<string, string[]>;
  locksByBlockRef: Map<string, string[]>;
  parallelSafeByBlockRef: Map<string, boolean>;
  diagnostics: {
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
  };
  taskReachable(from: string, to: string): boolean;
  blockReachable(fromRef: string, toRef: string): boolean;
};

export type CompiledTaskGraph = CompiledExecutionGraph;

export type ExecutionGraphSession = {
  projectRoot: PackageWorkspaceRef;
  projectId: string;
  packageRoot: string;
  graph: CompiledExecutionGraph;
  fileSnapshot: PackageFileSnapshot;
  readQueue: GraphReadQueue;
  dirtyPromptRefs: Set<string>;
  diagnostics: ValidationIssue[];
};

export type PackageFileChange = {
  path: string;
  type: "added" | "changed" | "removed";
};

export type GraphEditOperation =
  | {
      type: "add_node" | "update_node";
      node: ManifestNode;
    }
  | {
      type: "remove_node";
      nodeId: string;
    }
  | {
      type: "add_edge" | "remove_edge";
      edge: ManifestEdge;
    }
  | {
      type: "update_prompt";
      ref: string;
    };

export type GraphReadQueue = {
  fileChanges: PackageFileChange[];
  graphOps: GraphEditOperation[];
  enqueuedAt: string;
};

export type FileFingerprint = {
  path: string;
  hash: string;
  mtimeMs: number;
};

export type PackageFileSnapshot = {
  manifest: PlanPackageManifest;
  graph: CompiledExecutionGraph;
  manifestFile: FileFingerprint;
  promptFiles: Record<string, FileFingerprint>;
};

export type DrainGraphReadQueueResult = {
  session: ExecutionGraphSession;
  refreshed: boolean;
  dirtyPromptRefs: string[];
  diagnostics: ValidationIssue[];
};

export type ValidationReport = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export type InitWorkspaceResult = {
  workspace: ProjectWorkspace;
  project: ProjectMetadata;
  created: boolean;
  projectGraph?: {
    path: string;
    created: boolean;
    source: "project_graph" | "legacy_registry" | "legacy_default_canvas";
    canvasCount: number;
  };
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
  projectGraphPath: string;
  packageDir: string;
  statePath: string;
  resultsDir: string;
  activeCanvasId: string | null;
  canvases: ProjectCanvasPath[];
};

export type ProjectCanvasPath = {
  canvasId: string;
  name: string;
  packageDir: string;
  statePath: string;
  resultsDir: string;
};

export type PromptSurface = {
  ref: string;
  path: string;
  markdown: string;
};

export type RefreshPromptsResult = {
  prompts: PromptSurface[];
};

export type ClaimResult =
  | {
      kind: "block";
      ref: string;
      taskId: string;
      blockId: string;
      blockType: BlockType;
      reason?: "claimed" | "current" | "feedback_resolved" | "dispatched";
      requestedMode?: "parallel";
      parallelFallbackReason?: "review_requires_sequential_claim";
      nextParallelClaimable?: string[];
    }
  | {
      kind: "feedback";
      feedbackId: string;
      sourceReviewBlockRef: string;
      taskId: string;
      content: string;
    }
  | {
      kind: "batch";
      refs: string[];
    }
  | {
      kind: "none";
      reason?: string;
      nextSequentialClaimable?: string[];
    }
  | {
      kind: "blocked";
      ref?: string;
      reason: string;
    };

export type ClaimScope =
  | { kind: "project" }
  | { kind: "task"; taskId: string }
  | { kind: "block"; blockRef: string };

export type ParallelClaimResult = ClaimResult;

export type ExecutorAdapterResult =
  | {
      kind: "block";
      reportPath: string;
      runId?: string;
      executor?: string;
      adapter?: ExecutorProfile["adapter"];
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
      agentSessionId?: string | null;
      codexSessionId?: string | null;
      opencodeSessionId?: string | null;
    }
  | {
      kind: "review";
      resultPath: string;
      runId?: string;
      executor?: string;
      adapter?: ExecutorProfile["adapter"];
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
      agentSessionId?: string | null;
      codexSessionId?: string | null;
      opencodeSessionId?: string | null;
    }
  | {
      kind: "feedback";
      reportPath: string;
      runId?: string;
      executor?: string;
      adapter?: ExecutorProfile["adapter"];
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
      agentSessionId?: string | null;
      codexSessionId?: string | null;
      opencodeSessionId?: string | null;
    }
  | {
      kind: "manual";
      promptPath: string;
      runDir: string;
      runId: string;
      executor: string;
      adapter: "manual";
      nextCommand: string;
    };

export type ExecutorAdapter = {
  runBlock(input: { claim: Extract<ClaimResult, { kind: "block" }>; prompt: string }): Promise<ExecutorAdapterResult>;
  runFeedback(input: { claim: Extract<ClaimResult, { kind: "feedback" }> }): Promise<ExecutorAdapterResult>;
};

export type AutoRunStepResult =
  | {
      kind: "submitted";
      claim: ClaimResult;
      adapterResult: Extract<ExecutorAdapterResult, { kind: "block" | "review" | "feedback" }>;
      submitResult: SubmitResult | SubmitReviewResult | SubmitFeedbackResult;
    }
  | {
      kind: "manual";
      claim: Extract<ClaimResult, { kind: "block" | "feedback" }>;
      adapterResult: Extract<ExecutorAdapterResult, { kind: "manual" }>;
    }
  | {
      kind: "idle" | "blocked" | "batch";
      claim: ClaimResult;
    }
  | {
      kind: "batch_submitted";
      claim: Extract<ClaimResult, { kind: "batch" }>;
      steps: Array<Extract<AutoRunStepResult, { kind: "submitted" | "manual" }>>;
    };

type AutoRunLatestRunSummaryBase = {
  ref: string;
  runId: string;
  executor: string | null;
  adapter: ExecutorProfile["adapter"] | null;
  startedAt: string | null;
  finishedAt: string | null;
  stdoutSummary: string;
  stderrSummary: string;
  failureReason: string | null;
  promptPath: string;
  reportPath: string | null;
  metadataPath: string;
};

export type AutoRunLatestBlockRunSummary = AutoRunLatestRunSummaryBase & {
  kind: "block";
  taskId: string;
  blockId: string;
  status: BlockStatus;
};

export type AutoRunLatestFeedbackRunSummary = AutoRunLatestRunSummaryBase & {
  kind: "feedback";
  feedbackId: string | null;
  sourceReviewBlockRef: string | null;
  taskId: string | null;
  status: FeedbackStatus;
};

export type AutoRunLatestRunSummary = AutoRunLatestBlockRunSummary | AutoRunLatestFeedbackRunSummary;

export type AutoRunExplanationPhase = "idle" | "running" | "pausing" | "paused" | "manual" | "completed" | "blocked" | "failed" | "stopped";

export type AutoRunNextAction =
  | {
      kind: "start";
      message: string;
      command: string | null;
      targetPath: string | null;
      ref: string | null;
    }
  | {
      kind: "wait";
      message: string;
      command: string | null;
      targetPath: string | null;
      ref: string | null;
    }
  | {
      kind: "resume";
      message: string;
      command: string | null;
      targetPath: string | null;
      ref: string | null;
    }
  | {
      kind: "submit_manual_result";
      message: string;
      command: string | null;
      targetPath: string | null;
      ref: string | null;
    }
  | {
      kind: "inspect_record";
      message: string;
      command: string | null;
      targetPath: string;
      ref: string | null;
    }
  | {
      kind: "resolve_error";
      message: string;
      command: string | null;
      targetPath: string | null;
      ref: string | null;
    }
  | {
      kind: "review_status";
      message: string;
      command: string | null;
      targetPath: string | null;
      ref: string | null;
    };

export type AutoRunExplanation = {
  phase: AutoRunExplanationPhase;
  currentRef: string | null;
  currentExecutor: string | null;
  latestRecordId: string | null;
  latestRecordPath: string | null;
  latestOutputSummary: string | null;
  error: string | null;
  nextAction: AutoRunNextAction;
};

export type AutoRunStatus = {
  current: {
    refs: string[];
    feedbackId: string | null;
    reviewBlockRef: string | null;
  };
  latestRuns: AutoRunLatestRunSummary[];
  explanation: AutoRunExplanation;
  warnings: ValidationIssue[];
};

export type ReviewResult = {
  reviewBlockRef: string;
  taskId: string;
  verdict: ReviewVerdict;
  content: string;
};

export type ReviewHookInput = {
  reviewResult: ReviewResult;
  task: {
    taskId: string;
    title: string;
  };
  reviewBlockRef: string;
  feedbackCycleCount: number;
};

export type ReviewHookOutput = {
  action: "use_feedback";
  feedbackPrompt: string;
};

export type SubmitResult = {
  ref: string;
  runId: string;
  status: "completed";
};

export type SubmitReviewResult = {
  ref: string;
  reviewAttemptId: string;
  verdict: ReviewVerdict;
  feedbackId?: string;
  status: BlockStatus;
  completionReason?: "passed" | "max_cycles_reached" | null;
  feedbackCreated?: boolean;
  message?: string;
};

export type SubmitFeedbackResult = {
  status: "accepted";
  nextCommand: "planweave claim-next";
  message: string;
  feedbackId: string;
  submissionId: string;
};

export type BlockRecoveryResult = {
  ref: string;
  status: BlockStatus;
  reason?: string;
};

export type TaskStatusSummary = {
  taskId: string;
  status: TaskStatus;
  openFeedbackCount: number;
};

export type BlockStatusSummary = {
  ref: string;
  taskId: string;
  blockId: string;
  type: BlockType;
  status: BlockStatus;
  reason?: string | null;
  completionReason?: "passed" | "max_cycles_reached" | null;
  lastRunId?: string | null;
  latestReviewAttemptId?: string | null;
  activeFeedbackId?: string | null;
};

export type ClaimHint = {
  ref: string;
  taskId: string;
  blockId: string;
  blockType: BlockType;
  status: BlockStatus;
  statusReason: string | null;
  ready: boolean;
  readyReason: string | null;
  blockedByBlocks: string[];
  blockedByTasks: string[];
  blockedByProject: string[];
  parallelSafe: boolean;
  sequentialOnly: boolean;
  recommendedCommand: string | null;
  dispatchable: boolean;
  dispatchCommand: string | null;
  reviewGate: ReviewGateHint | null;
};

export type ReviewGateHint = {
  isGate: true;
  required: boolean;
  requiredReason: string;
  executorRole: "reviewer";
  downstreamTasks: string[];
  unlocksTasks: string[];
  needsChangesReturnsTo: string[];
};

export type BlockExplanation = ClaimHint & {
  promptPath: string;
  submitCommand: string;
};

export type CurrentWorkOwner = {
  projectRoot: string;
  canvasId: string | null;
  taskIds: string[];
};

export type CurrentBlockWorkItem = {
  kind: "block";
  ref: string;
  taskId: string;
  blockId: string;
  blockType: BlockType;
  promptPath: string;
  reportPath: string;
  submitCommand: string;
};

export type CurrentFeedbackWorkItem = {
  kind: "feedback";
  ref: string;
  feedbackId: string;
  sourceReviewBlockRef: string;
  taskId: string;
  promptPath: string;
  reportPath: string;
  submitCommand: string;
};

export type CurrentWorkItem = CurrentBlockWorkItem | CurrentFeedbackWorkItem;

export type CurrentWork = {
  currentRefs: string[];
  currentFeedbackId: string | null;
  currentReviewBlockRef: string | null;
  owner: CurrentWorkOwner;
  items: CurrentWorkItem[];
  blockingReason: string | null;
};

export type DoctorIssue = {
  code: "stale_current_ref" | "orphan_result" | "index_state_mismatch";
  message: string;
  repaired?: boolean;
  ref?: string;
  taskId?: string;
  path?: string;
  stateRunId?: string | null;
  indexRunId?: string | null;
};

export type DoctorReport = {
  ok: boolean;
  issues: DoctorIssue[];
};

export type PlanStatus = {
  projectId: string;
  projectRoot: string;
  taskTotal: number;
  blockTotal: number;
  tasks: TaskStatusSummary[];
  blocks: BlockStatusSummary[];
  currentRefs: string[];
  currentFeedbackId: string | null;
  currentReviewBlockRef: string | null;
  openFeedback: Array<{ feedbackId: string; sourceReviewBlockRef: string; status: FeedbackStatus }>;
  nextClaimable: string[];
  nextParallelClaimable: string[];
  nextSequentialClaimable: string[];
  nextParallelDispatchable: string[];
  claimHints: ClaimHint[];
  warnings: ValidationIssue[];
  counts: {
    tasks: Record<TaskStatus, number>;
    blocks: Record<BlockStatus, number>;
    feedback: Record<FeedbackStatus, number>;
  };
  orphanState: OrphanStateSummary[];
  orphanResults: OrphanResultSummary[];
};

export type OrphanStateSummary = {
  taskId?: string;
  ref?: string;
  status: string;
  lastRunId?: string | null;
};

export type OrphanResultSummary = {
  taskId: string;
  path: string;
};

export type GraphEditResult = {
  ok: boolean;
  affectedTasks: string[];
  diagnostics: ValidationIssue[];
  graph?: CompiledExecutionGraph;
};

export type TaskResultIndex = {
  latestRunByBlock?: Record<string, string>;
  latestReviewAttemptByBlock?: Record<string, string>;
  latestReviewVerdictByBlock?: Record<string, ReviewVerdict>;
  latestReviewedWorkRevisionByBlock?: Record<string, string>;
  latestFeedbackByReviewBlock?: Record<string, string>;
  latestFeedbackSubmissionByFeedback?: Record<string, string>;
  feedbackStatusById?: Record<string, FeedbackStatus>;
  reviewCompletionReasonByBlock?: Record<string, "passed" | "max_cycles_reached">;
  counts?: {
    runs?: number;
    reviewAttempts?: number;
    feedbackEnvelopes?: number;
    feedbackSubmissions?: number;
  };
  warnings?: ValidationIssue[];
};

export const runSubmitStatuses = ["completed"] as const;
export const reviewStatuses = reviewVerdicts;
export type RunSubmitStatus = "completed";
export type ReviewStatus = ReviewVerdict;
export type MarkBlockedResult = BlockRecoveryResult;
export type MarkDivergedResult = BlockRecoveryResult;
export type ResolveDivergenceResult = BlockRecoveryResult;
export type UnblockResult = BlockRecoveryResult;
export type RetryReviewResult = BlockRecoveryResult & {
  maxFeedbackCycles: number;
  reset: boolean;
};

export type EditTaskInput = {
  projectRoot: PackageWorkspaceRef;
  taskId: string;
  title?: string;
  promptMarkdown?: string;
  executor?: string | null;
};

export type EditTaskResult = GraphEditResult & {
  taskId: string;
  updatedFields: string[];
};

export type EditBlockInput = {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  title?: string;
  promptMarkdown?: string;
  executor?: string | null;
  parallelSafe?: boolean;
  parallelLocks?: string[];
  reviewRequired?: boolean;
  maxFeedbackCycles?: number;
  reviewHook?: ReviewHookDefinition | null;
};

export type EditBlockResult = GraphEditResult & {
  ref: string;
  taskId: string;
  blockId: string;
  blockType: BlockType;
  updatedFields: string[];
};
