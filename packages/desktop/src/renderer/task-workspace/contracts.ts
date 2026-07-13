import type {
  DesktopRunRecord,
  RunnerRecordReadModel,
  TaskWorkspace,
  TaskWorkspaceBlock
} from "@planweave-ai/runtime";
import type { ReactNode } from "react";
import type { TaskWorkspaceNavigationIdentity } from "../taskWorkspaceNavigation";

export type TaskWorkspaceRunItem = TaskWorkspaceBlock["runs"][number];

export type TaskWorkspaceSelectedRun = {
  block: TaskWorkspaceBlock;
  item: TaskWorkspaceRunItem;
};

export type TaskWorkspaceLoadStatus = "idle" | "loading" | "ready" | "error";

export type TaskWorkspaceLiveStatus = "idle" | "loading" | "live" | "unavailable" | "error";

export type TaskWorkspaceLabels = {
  backToCanvas: string;
  composer: string;
  conversation: string;
  inspector: string;
  loading: string;
  liveUnavailable: string;
  noConversation: string;
  noInspector: string;
  noRuns: string;
  noTask: string;
  timeline: string;
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
  "getRunScrollTop" | "onRunScrollTopChange" | "selectRun" | "selectedRun" | "workspace"
>;

export type TaskWorkspaceConversationSlotProps = Pick<
  TaskWorkspaceController,
  | "liveStatus"
  | "liveUnavailableReason"
  | "recordError"
  | "runnerModel"
  | "selectedRecord"
  | "selectedRun"
  | "subscriptionError"
>;

export type TaskWorkspaceInspectorSlotProps = Pick<
  TaskWorkspaceController,
  "selectedRecord" | "selectedRun" | "workspace"
>;

export type TaskWorkspaceComposerSlotProps = Pick<
  TaskWorkspaceController,
  "liveStatus" | "runnerModel" | "selectedRun"
>;

export type TaskWorkspaceSlotRenderers = {
  composer: (props: TaskWorkspaceComposerSlotProps) => ReactNode;
  conversation: (props: TaskWorkspaceConversationSlotProps) => ReactNode;
  inspector: (props: TaskWorkspaceInspectorSlotProps) => ReactNode;
  timeline: (props: TaskWorkspaceTimelineSlotProps) => ReactNode;
};
