import type {
  TaskWorkspace,
  TaskWorkspaceAnnotation,
  TaskWorkspaceBlock
} from "@planweave-ai/runtime";
import type { TaskWorkspaceTimelineSlotProps } from "../contracts";

export type TimelineRunStatus = "active" | "waiting" | "failed" | "completed";

export interface TimelineWaveMembership {
  index: number;
  total: number;
  waveId: string;
}

export interface TimelineRunProjection {
  active: boolean;
  blockRef: string;
  blockTitle: string;
  executionWave: TimelineWaveMembership | null;
  finishedAt: string | null;
  isRetry: boolean;
  item: TaskWorkspaceBlock["runs"][number];
  recordId: string;
  retryIndex: number;
  runId: string;
  startedAt: string | null;
  status: TimelineRunStatus;
}

export interface TimelineBlockProjection {
  annotations: TaskWorkspaceAnnotation[];
  blockId: string;
  ref: string;
  runs: TimelineRunProjection[];
  title: string;
  type: TaskWorkspaceBlock["type"];
}

export interface TaskWorkspaceTimelineProjection {
  blocks: TimelineBlockProjection[];
  runs: TimelineRunProjection[];
}

export interface TimelineSelection {
  blockRef: string;
  recordId: string;
}

export interface TimelineDefaultSelectionContext {
  entryBlockRef?: string | null;
  historyRecordId?: string | null;
}

export interface TaskWorkspaceTimelineLabels {
  activeRuns: (count: number) => string;
  annotationKinds: Record<TaskWorkspaceAnnotation["kind"], string>;
  completed: string;
  dependencies: string;
  dependencyProgress: (completed: number, total: number, percent: number) => string;
  empty: string;
  failed: string;
  latestArtifact: string;
  noActiveRuns: string;
  noArtifact: string;
  parallelWave: (waveId: string, index: number, total: number) => string;
  resizeTimeline: string;
  retry: (retryIndex: number) => string;
  run: (blockTitle: string, retryIndex: number) => string;
  running: string;
  timeline: string;
  waiting: string;
}

export type TaskWorkspaceTimelineProps = Omit<TaskWorkspaceTimelineSlotProps, "workspace"> & {
  labels: TaskWorkspaceTimelineLabels;
  workspace: TaskWorkspace;
};
