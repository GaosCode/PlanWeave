import type { AutoRunExplanation } from "../../types.js";
import type { ReviewVerdict, ValidationIssue } from "../../types.js";
import type { ResetRuntimeStateResult, RunSessionState } from "../../runSessions/types.js";

export type DesktopAutoRunScope =
  | { kind: "project" }
  | { kind: "task"; taskId: string }
  | { kind: "block"; blockRef: string };

export type DesktopAutoRunPhase =
  | "idle"
  | "running"
  | "pausing"
  | "paused"
  | "manual"
  | "completed"
  | "blocked"
  | "failed"
  | "stopped";

export type DesktopAutoRunOptions = {
  tmuxEnabled?: boolean;
};

export type DesktopRuntimeResetOptions = {
  force?: boolean;
  reason?: string;
};

export type DesktopRuntimeResetResult = ResetRuntimeStateResult & {
  session: RunSessionState;
  stoppedAutoRunIds: string[];
};

export type DesktopAutoRunState = {
  runId: string;
  runSessionId?: string | null;
  projectRoot: string;
  canvasId: string | null;
  scope: DesktopAutoRunScope;
  phase: DesktopAutoRunPhase;
  stepCount: number;
  stepLimit: number;
  currentRef: string | null;
  currentExecutor: string | null;
  elapsedMs: number;
  latestOutputSummary: string | null;
  latestRecordId: string | null;
  latestRecordPath: string | null;
  explanation: AutoRunExplanation;
  statePath: string;
  eventLogPath: string;
  options: Required<DesktopAutoRunOptions>;
  error: string | null;
  startedAt: string;
  updatedAt: string;
};

export type DesktopLatestAutoRunSummary = {
  state: DesktopAutoRunState | null;
  diagnostics: ValidationIssue[];
};

export type DesktopRuntimeRefreshSnapshot = {
  latestAutoRun: DesktopAutoRunState | null;
  diagnostics: ValidationIssue[];
  errors: string[];
};

export type DesktopRuntimeStateChangeEvent = {
  projectRoot: string;
  canvasId: string | null;
  stateFile: string;
  changedAt: string;
};

export type DesktopAutoRunEvent = {
  projectRoot: string;
  canvasId: string | null;
  runId: string;
  phase: DesktopAutoRunPhase;
  state: DesktopAutoRunState;
  currentRef: string | null;
  latestRecordId: string | null;
  latestRecordPath: string | null;
  eventType: string;
  triggeredAt: string;
};

export type DesktopAutoRunEventListener = (event: DesktopAutoRunEvent) => void;

export type DesktopAutoRunLogEvent = {
  line: number;
  timestamp: string | null;
  runId: string | null;
  type: string | null;
  phase?: DesktopAutoRunPhase;
  stepCount?: number;
  currentRef?: string | null;
  data: Record<string, unknown>;
};

export type DesktopAutoRunEventLogDiagnostic = {
  code:
    | "auto_run_event_log_bad_line"
    | "auto_run_event_log_read_failed"
    | "auto_run_event_log_missing";
  message: string;
  line?: number;
  path: string;
};

export type DesktopAutoRunEventLog = {
  runId: string;
  events: DesktopAutoRunLogEvent[];
  diagnostics: DesktopAutoRunEventLogDiagnostic[];
};

export type DesktopAutoRunRetrospectiveSummary = {
  runId: string;
  projectRoot: string;
  canvasId: string | null;
  phase: DesktopAutoRunPhase;
  scope: DesktopAutoRunScope;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  stepCount: number;
  completedBlockRefs: string[];
  blockedRef: string | null;
  failedReason: string | null;
  reviewVerdicts: Array<{
    ref: string;
    attemptId: string;
    verdict: ReviewVerdict | null;
    contentPreview: string;
  }>;
  latestRecordId: string | null;
  latestRecordPath: string | null;
  latestReportPath: string | null;
  nextAction: AutoRunExplanation["nextAction"];
  diagnostics: ValidationIssue[];
};
