import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import type {
  RemoteBlockExecutionReadModel,
  TaskWorkspace,
  TaskWorkspaceBlock
} from "@planweave-ai/runtime";
import { taskWorkspaceRunItemSchema, taskWorkspaceSchema } from "@planweave-ai/runtime/browser";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc";
import type { WorkspaceTaskWorkspaceNavigationIdentity } from "../taskWorkspaceNavigation";
import {
  agentFamilyFromExecutorName,
  remoteLiveOperationIdFromRecordId,
  remoteLiveRecordId,
  remoteLiveRunId
} from "./remoteLiveRun";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";

const TASK_WALL_CLOCK_UNAVAILABLE_REASON =
  "Task wall-clock duration is unavailable because no remote operation has a start time.";
const AGENT_TIME_UNAVAILABLE_REASON =
  "Agent time is unavailable because no remote operation has a calculable duration.";

function executionReadModel(
  projection: CollaborationCanvasBindingReplicaProjection,
  operation: RemoteOperationObservation
): RemoteBlockExecutionReadModel {
  const terminal = ["completed", "failed", "cancelled"].includes(operation.state);
  const interrupted = operation.state === "interrupted" || operation.state === "action_required";
  return {
    identity: { operationId: operation.operationId },
    controlPlane: "collaboration",
    phase: terminal ? "terminal" : operation.state === "preparing" ? "preparing" : "active",
    status:
      operation.state === "completed"
        ? "completed"
        : operation.state === "failed" || operation.state === "cancelled"
          ? "failed"
          : interrupted
            ? "interrupted"
            : "owned",
    actionRequired: operation.state === "action_required",
    source: {
      revision: String(projection.revision),
      graphFingerprint: projection.content.packageFingerprint
    },
    dispatchAttempt: {
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId
    }
  };
}

function dependencyProgress(
  dependencies: readonly string[],
  statusByRef: ReadonlyMap<string, string>
) {
  const blockers = dependencies.filter((ref) => statusByRef.get(ref) !== "completed");
  const total = dependencies.length;
  const completed = total - blockers.length;
  return {
    total,
    completed,
    percent: total === 0 ? 100 : Math.floor((completed / total) * 100),
    status:
      total === 0
        ? ("not_applicable" as const)
        : completed === total
          ? ("completed" as const)
          : completed === 0
            ? ("pending" as const)
            : ("in_progress" as const),
    blockers
  };
}

function operationRunItem(options: {
  block: Omit<TaskWorkspaceBlock, "runs">;
  now: Date;
  operation: RemoteOperationObservation;
  projectId: string;
  canvasId: string;
  selectedRecordId: string | null;
}) {
  const { block, now, operation, projectId, canvasId, selectedRecordId } = options;
  const active = !["completed", "failed", "cancelled"].includes(operation.state);
  const runId = remoteLiveRunId(operation.operationId);
  const recordId = remoteLiveRecordId(block.ref, operation.operationId);
  const finishedAt = active ? null : (operation.terminalAt ?? operation.updatedAt);
  const startedAt = operation.createdAt;
  const elapsedEnd = finishedAt ?? now.toISOString();
  const wallClockMs = Math.max(0, Date.parse(elapsedEnd) - Date.parse(startedAt));
  const executorName =
    operation.agentEndpoint?.agentId ?? block.executor ?? block.effectiveExecutor;
  const terminalState =
    operation.state === "completed"
      ? ("succeeded" as const)
      : operation.state === "cancelled"
        ? ("cancelled" as const)
        : operation.state === "failed"
          ? ("failed" as const)
          : null;
  return taskWorkspaceRunItemSchema.parse({
    retryIndex: 1,
    active,
    selected: selectedRecordId === recordId,
    waitingInteraction: {
      active: operation.state === "action_required",
      count: operation.state === "action_required" ? 1 : 0,
      kinds: operation.state === "action_required" ? ["elicitation"] : []
    },
    run: {
      version: "planweave.task-workspace-run/v1",
      kind: "block",
      record: {
        recordId,
        ref: block.ref,
        taskId: block.taskId,
        blockId: block.blockId,
        runId
      },
      runIdentity: {
        projectId,
        canvasId,
        taskId: block.taskId,
        blockId: block.blockId,
        claimRef: block.ref,
        runId,
        runOwner: "executor",
        runSessionId: null,
        desktopRunId: null,
        executorRunId: runId
      },
      metadata: {
        executor: executorName,
        adapter: executorName,
        runnerKind: "acp",
        agentId: agentFamilyFromExecutorName(executorName),
        executionCwd: null,
        projectRoot: null,
        agentSessionId: null,
        tmuxSessionId: null,
        exitCode: terminalState === "succeeded" ? 0 : terminalState ? 1 : null,
        terminalState
      },
      executionWaveId: null,
      duration: {
        startedAt,
        finishedAt,
        calculatedAt: now.toISOString(),
        wallClockMs,
        unavailableReason: null
      },
      usage: {
        currentContext: null,
        runTokens: { available: false, totalTokens: null, reason: "Remote operation." },
        taskTokens: { available: false, totalTokens: null, reason: "Remote operation." }
      },
      actualConfiguration: {
        available: false,
        reason: "Remote operation configuration is owned by the Agent Host."
      },
      nextActions: { version: "planweave.runner-next-actions/v1", actions: [] },
      capabilities: {
        prompt: {
          available: false,
          reason: "Remote operation prompt is available from the Server event stream.",
          identity: null,
          inFlight: active
        },
        cancel: { available: false, reason: "Use remote operation controls.", identity: null },
        retry: { available: false, reason: "Use remote operation controls.", identity: null },
        recoverAcpSession: {
          available: false,
          reason: { code: "runner_not_acp", message: "Use remote operation controls." },
          identity: null
        },
        resume: { available: false, reason: "Use remote operation controls.", identity: null }
      }
    }
  });
}

export function projectWorkspaceTaskWorkspace(options: {
  blockRef: string | null;
  now?: Date;
  operation: RemoteOperationObservation | null;
  projection: CollaborationCanvasBindingReplicaProjection;
  selectedRecordId: string | null;
  taskId: string;
}): TaskWorkspace {
  const { blockRef, operation, projection, selectedRecordId, taskId } = options;
  const now = options.now ?? new Date();
  const parsedTaskId = taskWorkspaceSchema.shape.task.shape.taskId.parse(taskId);
  const task = projection.content.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) {
    throw new Error(
      `Task '${taskId}' is unavailable in Workspace Canvas '${projection.canvasId}'.`
    );
  }
  if (blockRef && !task.blocks.some((block) => block.ref === blockRef)) {
    throw new Error(`Block '${blockRef}' is unavailable for Task '${taskId}'.`);
  }
  if (
    operation &&
    (operation.projectId !== projection.projectId ||
      operation.canvasId !== projection.canvasId ||
      operation.blockRef !== blockRef)
  ) {
    throw new Error("The remote operation does not belong to this Workspace Block.");
  }
  const allBlocks = projection.content.tasks.flatMap((candidate) => candidate.blocks);
  const statusByRef = new Map(allBlocks.map((block) => [block.ref, block.status]));
  const blocks = task.blocks.map((block): TaskWorkspaceBlock => {
    const dependencies = dependencyProgress(
      projection.content.blockDependenciesByRef[block.ref] ?? [],
      statusByRef
    );
    const remoteExecution =
      operation && operation.blockRef === block.ref
        ? executionReadModel(projection, operation)
        : null;
    const baseBlock = {
      ref: block.ref,
      taskId: parsedTaskId,
      blockId: block.blockId,
      type: block.type,
      title: block.title,
      status: block.status,
      executor: block.executor,
      effectiveExecutor: block.executor ?? task.executor,
      promptMarkdown: projection.content.blockPromptMarkdownByRef[block.ref] ?? "",
      promptMissing: block.promptMissing,
      promptSurfaceMarkdown: projection.content.blockPromptMarkdownByRef[block.ref] ?? "",
      promptSources: [],
      dependencies,
      annotations: [],
      remoteExecution
    } satisfies Omit<TaskWorkspaceBlock, "runs">;
    return {
      ...baseBlock,
      runs:
        operation && operation.blockRef === block.ref
          ? [
              operationRunItem({
                block: baseBlock,
                now,
                operation,
                projectId: projection.projectId,
                canvasId: projection.canvasId,
                selectedRecordId
              })
            ]
          : []
    };
  });
  const dependencyRefs = blocks.flatMap((block) => block.dependencies.blockers);
  const dependencyTotal = blocks.reduce((total, block) => total + block.dependencies.total, 0);
  const dependencyCompleted = blocks.reduce(
    (total, block) => total + block.dependencies.completed,
    0
  );
  const selectedRun = blocks.flatMap((block) => block.runs).find((item) => item.selected)?.run
    .record.recordId;
  const activeRecordIds = blocks.flatMap((block) =>
    block.runs.filter((item) => item.active).map((item) => item.run.record.recordId)
  );
  const runs = blocks.flatMap((block) => block.runs);
  const startedAt = runs[0]?.run.duration.startedAt ?? null;
  const finishedAt = runs[0]?.run.duration.finishedAt ?? null;
  const duration =
    startedAt === null
      ? {
          wallClock: {
            available: false as const,
            startedAt: null,
            endedAt: null,
            calculatedAt: now.toISOString(),
            totalMs: null,
            unavailableReason: TASK_WALL_CLOCK_UNAVAILABLE_REASON
          },
          agentTime: {
            availability: "unavailable" as const,
            totalMs: null,
            includedRunCount: 0,
            missingRunCount: 0,
            reason: AGENT_TIME_UNAVAILABLE_REASON
          }
        }
      : {
          wallClock: {
            available: true as const,
            startedAt,
            endedAt: finishedAt ?? now.toISOString(),
            calculatedAt: now.toISOString(),
            totalMs: Math.max(
              0,
              Date.parse(finishedAt ?? now.toISOString()) - Date.parse(startedAt)
            ),
            unavailableReason: null
          },
          agentTime: {
            availability: "complete" as const,
            totalMs: runs[0]?.run.duration.wallClockMs ?? 0,
            includedRunCount: 1,
            missingRunCount: 0,
            reason: null
          }
        };
  return taskWorkspaceSchema.parse({
    version: "planweave.task-workspace/v1",
    project: {
      authority: "workspace",
      workspaceId: projection.workspaceId,
      projectId: projection.projectId,
      canvasId: projection.canvasId
    },
    task: {
      taskId: parsedTaskId,
      title: task.title,
      status: task.status,
      executor: task.executor,
      promptMarkdown: task.promptMarkdown,
      promptMissing: task.promptMissing,
      acceptance: []
    },
    dependencyProgress: {
      total: dependencyTotal,
      completed: dependencyCompleted,
      percent:
        dependencyTotal === 0 ? 100 : Math.floor((dependencyCompleted / dependencyTotal) * 100),
      status:
        dependencyTotal === 0
          ? "not_applicable"
          : dependencyCompleted === dependencyTotal
            ? "completed"
            : dependencyCompleted === 0
              ? "pending"
              : "in_progress",
      blockers: [...new Set(dependencyRefs)]
    },
    blocks,
    activeRecordIds,
    selectedRecordId: selectedRun ?? null,
    latestArtifact: null,
    duration,
    usage: {
      taskTokens: {
        available: false,
        totalTokens: null,
        reason: "Workspace Task token accounting is unavailable."
      },
      taskCost: {
        available: false,
        totals: null,
        reason: "Workspace Task cost accounting is unavailable."
      }
    }
  });
}

export async function loadWorkspaceTaskWorkspace(options: {
  lookupOperation: (input: {
    locator: WorkspaceCanvasLocator;
    blockRef: string;
    operationId?: string;
  }) => Promise<RemoteOperationObservation | null>;
  navigation: WorkspaceTaskWorkspaceNavigationIdentity;
  projection: CollaborationCanvasBindingReplicaProjection;
}): Promise<{
  packageExecutorNames: string[];
  requiredCapabilitiesByBlockRef: Record<string, string[]>;
  taskRequiredCapabilities: string[];
  workspace: TaskWorkspace;
}> {
  const { navigation, projection } = options;
  if (
    projection.workspaceId !== navigation.workspaceId ||
    projection.projectId !== navigation.projectId ||
    projection.canvasId !== navigation.canvasId
  ) {
    throw new Error("The loaded Workspace Canvas does not match this Block detail route.");
  }
  const operationId = navigation.recordId
    ? remoteLiveOperationIdFromRecordId(navigation.recordId)
    : null;
  if (navigation.recordId && !operationId) {
    throw new Error("The selected Workspace execution record identity is invalid.");
  }
  const operation = navigation.blockRef
    ? await options.lookupOperation({
        locator: {
          kind: "workspace",
          connectionProfileId: navigation.connectionProfileId,
          workspaceId: navigation.workspaceId,
          projectId: navigation.projectId,
          canvasId: navigation.canvasId
        },
        blockRef: navigation.blockRef,
        ...(operationId ? { operationId } : {})
      })
    : null;
  if (navigation.recordId && operation === null) {
    throw new Error("The selected Workspace execution record is unavailable for this Block.");
  }
  const graphTask = projection.content.tasks.find((task) => task.taskId === navigation.taskId);
  const workspace = projectWorkspaceTaskWorkspace({
    blockRef: navigation.blockRef ?? null,
    operation,
    projection,
    selectedRecordId: navigation.recordId ?? null,
    taskId: navigation.taskId
  });
  return {
    packageExecutorNames: [
      ...new Set(
        projection.content.tasks.flatMap((task) => [
          ...(task.executor ? [task.executor] : []),
          ...task.blocks.flatMap((block) => (block.executor ? [block.executor] : []))
        ])
      )
    ],
    requiredCapabilitiesByBlockRef: Object.fromEntries(
      (graphTask?.blocks ?? []).map((block) => [block.ref, [...block.requiredCapabilities]])
    ),
    taskRequiredCapabilities: [
      ...new Set(
        (graphTask?.blocks ?? [])
          .filter((block) => block.executor === null)
          .flatMap((block) => block.requiredCapabilities)
      )
    ],
    workspace
  };
}
