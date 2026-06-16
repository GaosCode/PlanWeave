export type DesktopAutoRunScope =
  | { kind: "project" }
  | { kind: "task"; taskId: string }
  | { kind: "block"; blockRef: string };

export type DesktopAutoRunPhase = "idle" | "running" | "pausing" | "paused" | "manual" | "completed" | "blocked" | "failed" | "stopped";

export type DesktopAutoRunOptions = {
  tmuxEnabled?: boolean;
};

export type DesktopAutoRunState = {
  runId: string;
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
  statePath: string;
  eventLogPath: string;
  options: Required<DesktopAutoRunOptions>;
  error: string | null;
  startedAt: string;
  updatedAt: string;
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
