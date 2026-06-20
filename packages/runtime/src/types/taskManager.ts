import type { BlockType } from "./manifest.js";
import type { BlockStatus, FeedbackStatus, ReviewVerdict, TaskStatus } from "./state.js";
import type { ValidationIssue } from "./validation.js";

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

export type ProjectDoctorIssueSource = "project_graph" | "canvas_package" | "canvas_doctor";

export type ProjectDoctorIssue = {
  code: string;
  message: string;
  source: ProjectDoctorIssueSource;
  canvasId?: string;
  path?: string;
  repaired?: boolean;
  ref?: string;
  taskId?: string;
  stateRunId?: string | null;
  indexRunId?: string | null;
};

export type ProjectDoctorCanvasReport = {
  canvasId: string;
  ok: boolean;
  repaired: boolean;
  errors: ProjectDoctorIssue[];
  warnings: ProjectDoctorIssue[];
};

export type ProjectDoctorReport = {
  ok: boolean;
  repaired: boolean;
  errors: ProjectDoctorIssue[];
  warnings: ProjectDoctorIssue[];
  canvasReports: ProjectDoctorCanvasReport[];
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

export type MarkBlockedResult = BlockRecoveryResult;
export type MarkDivergedResult = BlockRecoveryResult;
export type ResolveDivergenceResult = BlockRecoveryResult;
export type UnblockResult = BlockRecoveryResult;
export type RetryReviewResult = BlockRecoveryResult & {
  maxFeedbackCycles: number;
  reset: boolean;
};
