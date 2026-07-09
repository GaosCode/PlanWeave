import type {
  AutoRunStatus,
  AutoRunStepResult,
  ClaimScope,
  PackageWorkspaceRef
} from "../types.js";

export type RunSessionKind = "run" | "reset";
export type RunSessionTrigger = "manual" | "cron" | "desktop" | "api";
export type RunSessionPhase =
  | "created"
  | "resetting"
  | "running"
  | "completed"
  | "manual"
  | "blocked"
  | "failed"
  | "stopped";

export type RunSessionScope =
  | { kind: "project" }
  | { kind: "task"; taskId: string }
  | { kind: "block"; blockRef: string };

export type RunSessionResetSummary = {
  performed: boolean;
  statePath: string;
  reason: string | null;
  previousCurrentRefs: string[];
  previousCurrentFeedbackId: string | null;
  previousCurrentReviewBlockRef: string | null;
  previousInProgressRefs: string[];
  forced: boolean;
};

export type RunSessionAutoRunSummary = {
  desktopRunId: string | null;
  stepCount: number;
  parallel: boolean;
  executorOverride: string | null;
  stopReason: "none" | "once" | "step_limit" | "no_steps" | null;
};

export type RunSessionState = {
  sessionId: string;
  kind: RunSessionKind;
  trigger: RunSessionTrigger;
  projectRoot: string;
  canvasId: string;
  scope: RunSessionScope;
  phase: RunSessionPhase;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  reset: RunSessionResetSummary | null;
  autoRun: RunSessionAutoRunSummary | null;
  latestRecordId: string | null;
  latestRecordPath: string | null;
  error: string | null;
};

export type RunSessionEvent = {
  timestamp: string;
  sessionId: string;
  type: string;
  phase: RunSessionPhase;
} & Record<string, unknown>;

export type RunSessionDiagnostic = {
  code:
    | "run_session_read_failed"
    | "run_session_invalid"
    | "run_session_event_read_failed"
    | "run_session_event_invalid";
  sessionId: string;
  path: string;
  message: string;
};

export type CreateRunSessionOptions = {
  projectRoot: PackageWorkspaceRef;
  kind: RunSessionKind;
  trigger?: RunSessionTrigger;
  scope?: RunSessionScope;
  phase?: RunSessionPhase;
  now?: Date;
};

export type UpdateRunSessionPatch = Partial<
  Pick<
    RunSessionState,
    "phase" | "finishedAt" | "reset" | "autoRun" | "latestRecordId" | "latestRecordPath" | "error"
  >
>;

export type ListRunSessionsResult = {
  sessions: RunSessionState[];
  diagnostics: RunSessionDiagnostic[];
};

export type RunSessionDetail = {
  session: RunSessionState;
  events: RunSessionEvent[];
  diagnostics: RunSessionDiagnostic[];
};

export type ResetRuntimeStateOptions = {
  projectRoot: PackageWorkspaceRef;
  force?: boolean;
  reason?: string;
  sessionId?: string;
  session?: RunSessionState;
};

export type ResetRuntimeStateResult = {
  statePath: string;
  reason: string | null;
  forced: boolean;
  previousCurrentRefs: string[];
  previousCurrentFeedbackId: string | null;
  previousCurrentReviewBlockRef: string | null;
  previousInProgressRefs: string[];
  sessionId: string | null;
};

export type RunWithSessionOptions = {
  projectRoot: PackageWorkspaceRef;
  reset?: boolean;
  force?: boolean;
  reason?: string;
  once?: boolean;
  parallel?: boolean;
  executorName?: string;
  tmuxEnabled?: boolean;
  scope?: ClaimScope;
  stepLimit?: number;
};

export type RunWithSessionResult = {
  session: RunSessionState;
  steps: AutoRunStepResult[];
  status: AutoRunStatus;
  ok: boolean;
  terminalReason: "completed" | "step_limit_reached" | "manual" | "blocked" | "failed";
};
