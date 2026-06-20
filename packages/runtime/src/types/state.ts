export const taskStatuses = ["planned", "ready", "in_progress", "implemented"] as const;
export const blockStatuses = ["planned", "ready", "in_progress", "completed", "needs_changes", "blocked", "diverged"] as const;
export const feedbackStatuses = ["open", "in_progress", "resolved", "dismissed"] as const;
export const reviewVerdicts = ["passed", "needs_changes"] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type BlockStatus = (typeof blockStatuses)[number];
export type FeedbackStatus = (typeof feedbackStatuses)[number];
export type ReviewVerdict = (typeof reviewVerdicts)[number];

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
