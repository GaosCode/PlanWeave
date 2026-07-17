import type {
  DesktopRunRecord,
  RunnerRecordReadModel,
  TaskWorkspace,
  TaskWorkspaceAnnotation,
  TaskWorkspaceBlock
} from "@planweave-ai/runtime";
import type { ReactNode } from "react";
import type { TaskWorkspaceNavigationIdentity } from "../taskWorkspaceNavigation";
import type { TaskWorkspaceLayout } from "./useTaskWorkspaceLayout";

export type TaskWorkspaceRunItem = TaskWorkspaceBlock["runs"][number];

export type TaskWorkspaceSelectedRun = {
  block: TaskWorkspaceBlock;
  item: TaskWorkspaceRunItem;
};

export type TaskWorkspaceSelectedAnnotation = {
  annotation: TaskWorkspaceAnnotation;
  block: TaskWorkspaceBlock;
};

export type TaskWorkspaceLoadStatus = "idle" | "loading" | "ready" | "error";

export type TaskWorkspaceLiveStatus = "idle" | "loading" | "live" | "unavailable" | "error";

export type TaskWorkspacePromptLabels = {
  blockPrompt: string;
  disabled: string;
  effectivePrompt: string;
  empty: string;
  included: string;
  missing: string;
  promptSources: string;
  savePrompt: string;
  saved: string;
  saving: string;
  taskPrompt: string;
};

export type TaskWorkspacePromptSaveInput = {
  baseMarkdown: string;
  markdown: string;
};

export type TaskWorkspaceLabels = {
  acceptanceCriteria: string;
  activeRuns: (count: number) => string;
  agent: string;
  annotationKinds: Record<TaskWorkspaceAnnotation["kind"], string>;
  annotationResult: string;
  backToCanvas: string;
  blockExecutor: string;
  blocks: string;
  booleanFalse: string;
  booleanTrue: string;
  composer: string;
  conversation: string;
  dependencies: string;
  dependencyProgress: (completed: number, total: number, percent: number) => string;
  elapsed: string;
  executorSaved: string;
  executorSaving: string;
  expandTimeline: string;
  feedbackStatus: Record<"dismissed" | "in_progress" | "open" | "resolved", string>;
  formatDateTime: (value: string) => string;
  formatDuration: (milliseconds: number) => string;
  inspector: string;
  inheritTaskExecutor: string;
  latestArtifact: string;
  loading: string;
  liveUnavailable: string;
  mode: string;
  model: string;
  noActiveRuns: string;
  noArtifact: string;
  noConversation: string;
  noInspector: string;
  noRuns: string;
  noTask: string;
  overview: string;
  permission: string;
  promptLabels: TaskWorkspacePromptLabels;
  reasoning: string;
  reviewVerdict: Record<"needs_changes" | "passed", string>;
  runStatus: Record<"active" | "cancelled" | "completed" | "failed" | "waiting", string>;
  status: string;
  taskExecutor: string;
  taskStatus: Record<TaskWorkspace["task"]["status"], string>;
  timeline: string;
  unavailable: string;
};

export type TaskWorkspaceController = {
  error: string | null;
  executorOptions: string[];
  getRunScrollTop: (recordId: string) => number;
  /** True when listTaskWorkspaceRuns returned a nextCursor that has not been exhausted. */
  hasMoreRuns: boolean;
  liveStatus: TaskWorkspaceLiveStatus;
  liveUnavailableReason: string | null;
  loadMoreRuns: () => Promise<void>;
  loadMoreRunsError: string | null;
  loadingMoreRuns: boolean;
  navigation: TaskWorkspaceNavigationIdentity | null;
  onRunScrollTopChange: (recordId: string, scrollTop: number) => void;
  packageExecutorNames: string[];
  recordError: string | null;
  refresh: () => void;
  returnToCanvas: () => void;
  runnerModel: RunnerRecordReadModel | null;
  saveBlockExecutor: (blockRef: string, executorName: string | null) => Promise<void>;
  saveBlockPrompt: (blockRef: string, input: TaskWorkspacePromptSaveInput) => Promise<void>;
  saveTaskExecutor: (executorName: string | null) => Promise<void>;
  saveTaskPrompt: (input: TaskWorkspacePromptSaveInput) => Promise<void>;
  selectRun: (selection: { blockRef: string; recordId: string } | null) => void;
  selectAnnotation: (selection: { blockRef: string; annotationId: string }) => void;
  selectedAnnotation: TaskWorkspaceSelectedAnnotation | null;
  selectedRecord: DesktopRunRecord | null;
  /** The history-backed run target, available before its detail projection finishes loading. */
  selectedRecordId: string | null;
  selectedRun: TaskWorkspaceSelectedRun | null;
  status: TaskWorkspaceLoadStatus;
  subscriptionError: string | null;
  workspace: TaskWorkspace | null;
};

export type TaskWorkspaceTimelineSlotProps = Pick<
  TaskWorkspaceController,
  | "getRunScrollTop"
  | "hasMoreRuns"
  | "loadMoreRuns"
  | "loadMoreRunsError"
  | "loadingMoreRuns"
  | "onRunScrollTopChange"
  | "selectRun"
  | "selectAnnotation"
  | "selectedAnnotation"
  | "selectedRecordId"
> &
  Pick<TaskWorkspaceLayout, "setTimelineWidth" | "timelineWidth"> & {
    workspace: TaskWorkspace;
  };

export type TaskWorkspaceConversationSlotProps = Pick<
  TaskWorkspaceController,
  | "getRunScrollTop"
  | "liveStatus"
  | "liveUnavailableReason"
  | "onRunScrollTopChange"
  | "recordError"
  | "runnerModel"
  | "selectedRecord"
  | "selectedRun"
  | "subscriptionError"
>;

export type TaskWorkspaceInspectorSlotProps = Pick<
  TaskWorkspaceController,
  "runnerModel" | "selectedRecord" | "selectedRun" | "workspace"
> &
  Pick<
    TaskWorkspaceLayout,
    "inspectorCollapsed" | "inspectorWidth" | "setInspectorCollapsed" | "setInspectorWidth"
  > & {
    focusedBlock: TaskWorkspaceBlock | null;
  };

export type TaskWorkspaceComposerSlotProps = Pick<
  TaskWorkspaceController,
  "liveStatus" | "refresh" | "runnerModel" | "selectedRun"
> & {
  workspace: TaskWorkspace;
};

export type TaskWorkspaceHeaderActionSlotProps = Pick<
  TaskWorkspaceController,
  "runnerModel" | "selectedRun"
>;

export type TaskWorkspaceSlotRenderers = {
  composer: (props: TaskWorkspaceComposerSlotProps) => ReactNode;
  conversation: (props: TaskWorkspaceConversationSlotProps) => ReactNode;
  headerAction: (props: TaskWorkspaceHeaderActionSlotProps) => ReactNode;
  inspector: (props: TaskWorkspaceInspectorSlotProps) => ReactNode;
  timeline: (props: TaskWorkspaceTimelineSlotProps) => ReactNode;
};
