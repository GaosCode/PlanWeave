import type { TaskWorkspace } from "@planweave-ai/runtime";
import {
  isWorkspaceTaskWorkspaceNavigation,
  taskWorkspaceNavigationAuthorityKey,
  taskWorkspaceNavigationTargetSchema,
  type TaskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationTarget
} from "../taskWorkspaceNavigation";
import type { TaskWorkspaceSelectedRun } from "./contracts";
import { isRemoteLiveRecordId, remoteLiveRecordId } from "./remoteLiveRun";

export function taskWorkspaceAuthorityKey(navigation: TaskWorkspaceNavigationIdentity): string {
  return taskWorkspaceNavigationAuthorityKey(navigation);
}

export function findTaskWorkspaceRun(
  workspace: TaskWorkspace,
  blockRef: string,
  recordId: string
): TaskWorkspaceSelectedRun | null {
  const block = workspace.blocks.find((candidate) => candidate.ref === blockRef);
  const item = block?.runs.find((candidate) => candidate.run.record.recordId === recordId);
  return block && item ? { block, item } : null;
}

function preferredPersistedRun(
  runs: NonNullable<TaskWorkspace["blocks"][number]["runs"]>
): TaskWorkspace["blocks"][number]["runs"][number] | undefined {
  // Prefer conversation-capable ACP runs over legacy local-review / unknown transports.
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index]?.run.metadata.runnerKind === "acp") return runs[index];
  }
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index]?.run.metadata.runnerKind === "cli") return runs[index];
  }
  return runs.at(-1);
}

export function initialTaskWorkspaceRun(
  workspace: TaskWorkspace,
  navigation: TaskWorkspaceNavigationIdentity
): TaskWorkspaceSelectedRun | null {
  if (navigation.recordId && navigation.blockRef) {
    return findTaskWorkspaceRun(workspace, navigation.blockRef, navigation.recordId);
  }
  if (navigation.blockRef) {
    const block = workspace.blocks.find((candidate) => candidate.ref === navigation.blockRef);
    const item =
      block?.runs.find(
        (candidate) => candidate.active && isRemoteLiveRecordId(candidate.run.record.recordId)
      ) ??
      block?.runs.find((candidate) => candidate.active) ??
      (block ? preferredPersistedRun(block.runs) : undefined);
    return block && item ? { block, item } : null;
  }
  for (const block of workspace.blocks) {
    const live = block.runs.find(
      (candidate) => candidate.active && isRemoteLiveRecordId(candidate.run.record.recordId)
    );
    if (live) return { block, item: live };
  }
  return null;
}

function preferredRemoteLiveSelection(
  workspace: TaskWorkspace,
  preferredBlockRef: string | null | undefined
): { blockRef: string; recordId: string } | null {
  const ordered = preferredBlockRef
    ? [
        ...workspace.blocks.filter((block) => block.ref === preferredBlockRef),
        ...workspace.blocks.filter((block) => block.ref !== preferredBlockRef)
      ]
    : workspace.blocks;
  for (const block of ordered) {
    const remote = block.remoteExecution;
    if (!remote || remote.phase === "terminal") continue;
    return {
      blockRef: block.ref,
      recordId: remoteLiveRecordId(block.ref, remote.identity.operationId)
    };
  }
  return null;
}

export function navigationTargetWithSelection(
  navigation: TaskWorkspaceNavigationIdentity,
  selection: { blockRef?: string; recordId?: string }
): TaskWorkspaceNavigationTarget {
  return taskWorkspaceNavigationTargetSchema.parse(
    isWorkspaceTaskWorkspaceNavigation(navigation)
      ? {
          authority: "workspace",
          connectionProfileId: navigation.connectionProfileId,
          workspaceId: navigation.workspaceId,
          projectId: navigation.projectId,
          canvasId: navigation.canvasId,
          taskId: navigation.taskId,
          ...selection
        }
      : {
          projectRoot: navigation.projectRoot,
          canvasId: navigation.canvasId,
          taskId: navigation.taskId,
          ...selection
        }
  );
}

export function localTaskWorkspaceSelectionAfterLoad(
  workspace: TaskWorkspace,
  navigation: TaskWorkspaceNavigationIdentity,
  overviewSelected: boolean
): { blockRef?: string; recordId?: string } | null {
  if (overviewSelected) return null;
  const liveSelection = preferredRemoteLiveSelection(workspace, navigation.blockRef);
  if (liveSelection && navigation.recordId !== liveSelection.recordId) return liveSelection;
  if (!liveSelection && isRemoteLiveRecordId(navigation.recordId)) {
    const block = workspace.blocks.find((candidate) => candidate.ref === navigation.blockRef);
    const latestReal = block?.runs
      .filter((item) => !isRemoteLiveRecordId(item.run.record.recordId))
      .at(-1);
    return {
      blockRef: latestReal?.run.record.ref ?? navigation.blockRef ?? undefined,
      recordId: latestReal?.run.record.recordId
    };
  }
  const selected = navigation.recordId ? null : initialTaskWorkspaceRun(workspace, navigation);
  return selected
    ? { blockRef: selected.block.ref, recordId: selected.item.run.record.recordId }
    : null;
}
