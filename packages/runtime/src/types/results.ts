import { reviewVerdicts } from "./state.js";
import type { FeedbackStatus, ReviewVerdict } from "./state.js";
import type { ValidationIssue } from "./validation.js";

/** Terminal reasons recorded on the task result index for a review block. */
export const reviewCompletionReasons = ["passed", "max_cycles_reached"] as const;
export type ReviewCompletionReason = (typeof reviewCompletionReasons)[number];

export type TaskResultIndex = {
  latestRunByBlock?: Record<string, string>;
  latestReviewAttemptByBlock?: Record<string, string>;
  latestReviewVerdictByBlock?: Record<string, ReviewVerdict>;
  latestReviewedWorkRevisionByBlock?: Record<string, string>;
  latestFeedbackByReviewBlock?: Record<string, string>;
  latestFeedbackSubmissionByFeedback?: Record<string, string>;
  feedbackStatusById?: Record<string, FeedbackStatus>;
  reviewCompletionReasonByBlock?: Record<string, ReviewCompletionReason>;
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
