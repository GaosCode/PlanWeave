import type {
  DesktopRunRecord,
  RunnerRecordReadModel,
  TaskWorkspace,
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

export type TaskWorkspaceLoadStatus = "idle" | "loading" | "ready" | "error";

export type TaskWorkspaceLiveStatus = "idle" | "loading" | "live" | "unavailable" | "error";

export type TaskWorkspaceLabels = {
  agent: string;
  backToCanvas: string;
  booleanFalse: string;
  booleanTrue: string;
  composer: string;
  conversation: string;
  elapsed: string;
  expandTimeline: string;
  formatDuration: (milliseconds: number) => string;
  inspector: string;
  loading: string;
  liveUnavailable: string;
  mode: string;
  model: string;
  noConversation: string;
  noInspector: string;
  noRuns: string;
  noTask: string;
  permission: string;
  reasoning: string;
  runStatus: Record<"active" | "completed" | "failed" | "waiting", string>;
  status: string;
  taskStatus: Record<TaskWorkspace["task"]["status"], string>;
  timeline: string;
  unavailable: string;
};

export type TaskWorkspaceController = {
  error: string | null;
  getRunScrollTop: (recordId: string) => number;
  liveStatus: TaskWorkspaceLiveStatus;
  liveUnavailableReason: string | null;
  navigation: TaskWorkspaceNavigationIdentity | null;
  onRunScrollTopChange: (recordId: string, scrollTop: number) => void;
  recordError: string | null;
  refresh: () => void;
  returnToCanvas: () => void;
  runnerModel: RunnerRecordReadModel | null;
  selectRun: (selection: { blockRef: string; recordId: string } | null) => void;
  selectedRecord: DesktopRunRecord | null;
  selectedRun: TaskWorkspaceSelectedRun | null;
  status: TaskWorkspaceLoadStatus;
  subscriptionError: string | null;
  workspace: TaskWorkspace | null;
};

export type TaskWorkspaceTimelineSlotProps = Pick<
  TaskWorkspaceController,
  "getRunScrollTop" | "onRunScrollTopChange" | "selectRun" | "selectedRun"
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
  "selectedRecord" | "selectedRun" | "workspace"
> &
  Pick<
    TaskWorkspaceLayout,
    "inspectorCollapsed" | "inspectorWidth" | "setInspectorCollapsed" | "setInspectorWidth"
  >;

export type TaskWorkspaceComposerSlotProps = Pick<
  TaskWorkspaceController,
  "liveStatus" | "runnerModel" | "selectedRun"
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
