import type { ExecutorAdapterResult, ExecutorProfile } from "./executor.js";
import type { ClaimResult, SubmitFeedbackResult, SubmitResult, SubmitReviewResult } from "./taskManager.js";
import type { BlockStatus, FeedbackStatus } from "./state.js";
import type { ValidationIssue } from "./validation.js";

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
  stdoutUpdatedAt: string | null;
  stderrUpdatedAt: string | null;
  metadataUpdatedAt: string | null;
  lastOutputAt: string | null;
  tmuxSessionName: string | null;
  tmuxAttachCommand: string | null;
  tmuxReadOnlyAttachCommand: string | null;
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
