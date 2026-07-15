import type { FeedbackStatus, ReviewVerdict } from "../../types.js";
import type { RunnerRecordReadModel } from "../../autoRun/runnerRecordReadModelContract.js";

export type DesktopBlockRunRecordSummary = {
  recordId: string;
  kind?: "block" | "feedback";
  ref: string;
  feedbackId?: string | null;
  sourceReviewBlockRef?: string | null;
  taskId: string;
  blockId: string;
  runId: string;
  executor: string | null;
  adapter: string | null;
  executionCwd: string | null;
  projectRoot: string | null;
  agentSessionId: string | null;
  codexSessionId: string | null;
  tmuxSessionId?: string | null;
  tmuxAttachCommand?: string | null;
  tmuxReadOnlyAttachCommand?: string | null;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  promptPath: string | null;
  reportPath: string | null;
  metadataPath: string;
  stdoutUpdatedAt?: string | null;
  stderrUpdatedAt?: string | null;
  metadataUpdatedAt?: string | null;
  heartbeatPath?: string | null;
  heartbeatUpdatedAt?: string | null;
  heartbeatStatus?: string | null;
  heartbeatPid?: number | null;
  lastHeartbeatAt?: string | null;
  lastActivityAt?: string | null;
  lastOutputAt?: string | null;
  stdoutSummary: string;
  stderrSummary: string;
};

export type DesktopRunRecord = DesktopBlockRunRecordSummary & {
  promptMarkdown: string;
  reportMarkdown: string;
  displayMarkdown: string;
  displayMarkdownSource: "report" | "live-output" | "none";
  metadata: Record<string, unknown>;
  runnerReadModel: RunnerRecordReadModel | null;
};

export type DesktopReviewAttemptSummary = {
  ref: string;
  taskId: string;
  blockId: string;
  attemptId: string;
  verdict: ReviewVerdict | null;
  resultPath: string;
  metadataPath: string;
  contentPreview: string;
};

export type DesktopFeedbackRecord = {
  feedbackId: string;
  sourceReviewBlockRef: string;
  status: FeedbackStatus;
  latestSubmissionId: string | null;
  content: string;
};
