import { dirname } from "node:path";
import { runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { unblockBlock } from "../taskManager/blockStatusMutations.js";
import { loadRuntimeReadonly } from "../taskManager/runtimeContext.js";
import {
  blockDependenciesCompleted,
  getBlock,
  requireBlockState
} from "../taskManager/selectors.js";
import type { BlockStatus, ProjectWorkspace } from "../types.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { getRunRecord, listBlockMainRunRecords } from "./recordsApi.js";
import {
  hasNonTerminalAutoRunForTarget,
  initializeAutoRunUnderCanvasLock,
  launchInitializedAutoRun
} from "./runApi.js";
import type { DesktopRunRecord } from "./types.js";
import type {
  TaskWorkspaceRetryCapability,
  TaskWorkspaceRetryIdentity
} from "./types/taskWorkspaceTypes.js";
import type { TaskWorkspaceInput } from "./types/taskWorkspaceAggregateTypes.js";

export type TaskWorkspaceRetryEligibilityInput = {
  workspace: ProjectWorkspace;
  canvasId: TaskWorkspaceInput["canvasId"];
  taskId: TaskWorkspaceInput["taskId"];
  block: {
    ref: string;
    blockId: string;
    status: BlockStatus;
  };
  record: DesktopRunRecord;
  selectedRecordId: string | null;
  latestRecordId: string | null;
  hasActiveRun: boolean;
  dependenciesSatisfied: boolean;
};

function unavailable(reason: string): TaskWorkspaceRetryCapability {
  return { available: false, reason, identity: null };
}

export function canonicalTaskWorkspaceRunIdentity(options: {
  workspace: ProjectWorkspace;
  canvasId: string;
  record: DesktopRunRecord;
}): ReturnType<typeof runnerRunIdentitySchema.parse> {
  const { workspace, canvasId, record } = options;
  const canonical = record.runnerReadModel?.cursor.canonicalIdentity?.identity;
  if (canonical !== undefined) {
    if (
      canonical.projectId !== workspace.id ||
      canonical.canvasId !== canvasId ||
      canonical.taskId !== record.taskId ||
      canonical.blockId !== record.blockId ||
      canonical.claimRef !== record.ref ||
      canonical.runId !== record.runId ||
      canonical.executorRunId !== record.runId
    ) {
      throw new Error(
        `Persisted runner identity does not match Task Workspace record '${record.recordId}'.`
      );
    }
    return runnerRunIdentitySchema.parse(canonical);
  }
  if (record.runnerReadModel !== null) {
    throw new Error(`Persisted runner record '${record.recordId}' has no canonical identity.`);
  }
  return runnerRunIdentitySchema.parse({
    projectId: workspace.id,
    canvasId,
    taskId: record.taskId,
    blockId: record.blockId,
    claimRef: record.ref,
    runId: record.runId,
    runOwner: "executor",
    runSessionId: null,
    desktopRunId: null,
    executorRunId: record.runId
  });
}

export function evaluateTaskWorkspaceRetry(
  input: TaskWorkspaceRetryEligibilityInput
): TaskWorkspaceRetryCapability {
  const terminalState = [...(input.record.runnerReadModel?.events ?? [])]
    .reverse()
    .find((event) => event.body.kind === "terminal")?.body;
  if (input.record.recordId !== input.selectedRecordId) {
    return unavailable("Retry is available only for the selected persisted Block run.");
  }
  if (input.record.recordId !== input.latestRecordId) {
    return unavailable("Retry is available only for the latest persisted Block run.");
  }
  if (terminalState?.kind !== "terminal" || terminalState.outcome.state !== "failed") {
    return unavailable("Retry is available only for a run whose terminal state is failed.");
  }
  if (input.block.status !== "blocked") {
    return unavailable("Retry requires the Block to remain blocked.");
  }
  if (input.hasActiveRun) {
    return unavailable("Retry is unavailable while an Auto Run is active or resumable.");
  }
  if (!input.dependenciesSatisfied) {
    return unavailable("Retry requires every Block dependency to be completed.");
  }
  canonicalTaskWorkspaceRunIdentity({
    workspace: input.workspace,
    canvasId: input.canvasId,
    record: input.record
  });
  return {
    available: true,
    reason: null,
    identity: {
      version: "planweave.task-workspace-retry/v1",
      projectId: input.workspace.id,
      projectRoot: input.workspace.rootPath,
      canvasId: input.canvasId,
      taskId: input.taskId,
      blockId: input.block.blockId,
      claimRef: input.block.ref,
      recordId: input.record.recordId,
      runId: input.record.runId,
      executorRunId: input.record.runId
    }
  };
}

export function sameTaskWorkspaceRetryIdentity(
  left: TaskWorkspaceRetryIdentity,
  right: TaskWorkspaceRetryIdentity
): boolean {
  return (
    left.version === right.version &&
    left.projectId === right.projectId &&
    left.projectRoot === right.projectRoot &&
    left.canvasId === right.canvasId &&
    left.taskId === right.taskId &&
    left.blockId === right.blockId &&
    left.claimRef === right.claimRef &&
    left.recordId === right.recordId &&
    left.runId === right.runId &&
    left.executorRunId === right.executorRunId
  );
}

export async function executeTaskWorkspaceRetry(identity: TaskWorkspaceRetryIdentity) {
  const workspace = await resolveTaskCanvasWorkspace(identity.projectRoot, identity.canvasId);
  const state = await withCanvasLock(dirname(workspace.stateFile), async () => {
    const context = await loadRuntimeReadonly({ projectRoot: workspace });
    if (
      context.workspace.id !== identity.projectId ||
      context.workspace.rootPath !== identity.projectRoot
    ) {
      throw new Error("Task Workspace retry identity no longer matches the requested workspace.");
    }
    const block = getBlock(context.graph, identity.claimRef);
    if (
      context.graph.blockTaskByRef.get(identity.claimRef) !== identity.taskId ||
      block.id !== identity.blockId
    ) {
      throw new Error("Task Workspace retry identity no longer matches an existing Block.");
    }

    const summaries = await listBlockMainRunRecords(workspace, identity.claimRef);
    const record = await getRunRecord(workspace, identity.recordId);
    const capability = evaluateTaskWorkspaceRetry({
      workspace: context.workspace,
      canvasId: identity.canvasId,
      taskId: identity.taskId,
      block: {
        ref: identity.claimRef,
        blockId: identity.blockId,
        // claimRef is graph-validated above; missing state is corruption, not planned.
        status: requireBlockState(context.state, identity.claimRef).status
      },
      record,
      selectedRecordId: identity.recordId,
      latestRecordId: summaries[0]?.recordId ?? null,
      hasActiveRun: await hasNonTerminalAutoRunForTarget(identity.projectRoot, identity.canvasId),
      dependenciesSatisfied: blockDependenciesCompleted(
        context.graph,
        context.state,
        identity.claimRef
      )
    });
    if (!capability.available || capability.identity === null) {
      throw new Error(capability.reason ?? "Task Workspace retry is unavailable.");
    }
    if (!sameTaskWorkspaceRetryIdentity(capability.identity, identity)) {
      throw new Error("Task Workspace retry capability identity no longer matches the request.");
    }

    await unblockBlock({
      projectRoot: workspace,
      ref: identity.claimRef,
      reason: `Retry requested for failed Task Workspace run '${identity.recordId}'.`
    });
    try {
      return await initializeAutoRunUnderCanvasLock(
        workspace,
        identity.projectRoot,
        identity.canvasId,
        { kind: "block", blockRef: identity.claimRef }
      );
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() ? error.message : "unknown error";
      throw new Error(
        `Task Workspace retry unblocked '${identity.claimRef}', but starting the new Auto Run failed. The Block remains ready: ${message}`,
        { cause: error }
      );
    }
  });
  launchInitializedAutoRun(state.runId);
  return state;
}
