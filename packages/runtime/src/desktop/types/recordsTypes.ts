import type {
  FeedbackStatus,
  ReviewVerdict
} from "../../types.js";

export type DesktopBlockRunRecordSummary = {
  recordId: string;
  ref: string;
  taskId: string;
  blockId: string;
  runId: string;
  executor: string | null;
  adapter: string | null;
  executionCwd: string | null;
  projectRoot: string | null;
  agentSessionId: string | null;
  codexSessionId: string | null;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  promptPath: string | null;
  reportPath: string | null;
  metadataPath: string;
  stdoutSummary: string;
  stderrSummary: string;
};

export type DesktopRunRecord = DesktopBlockRunRecordSummary & {
  promptMarkdown: string;
  reportMarkdown: string;
  metadata: Record<string, unknown>;
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
