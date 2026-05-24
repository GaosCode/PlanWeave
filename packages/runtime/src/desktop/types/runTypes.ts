export type DesktopAutoRunScope =
  | { kind: "project" }
  | { kind: "task"; taskId: string }
  | { kind: "block"; blockRef: string };

export type DesktopAutoRunPhase = "idle" | "running" | "pausing" | "paused" | "manual" | "completed" | "blocked" | "failed" | "stopped";

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
  error: string | null;
  startedAt: string;
  updatedAt: string;
};
