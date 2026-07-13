import {
  canvasIdSchema,
  claimRefSchema,
  taskIdSchema,
  taskWorkspaceInputSchema
} from "@planweave-ai/runtime";
import { z } from "zod";

const projectRootSchema = taskWorkspaceInputSchema.shape.projectRoot;
const recordIdSchema = taskWorkspaceInputSchema.shape.selectedRecordId.unwrap().unwrap();
const maxSourceViewLength = 64;
const sourceViewSchema = z.string().min(1).max(maxSourceViewLength);
const navigationTargetBaseShape = {
  projectRoot: projectRootSchema,
  canvasId: canvasIdSchema,
  taskId: taskIdSchema
};

function taskIdFromValidatedBlockRef(blockRef: string): string {
  return blockRef.slice(0, blockRef.indexOf("#"));
}

function validateBlockOwnership(
  value: { taskId: string; blockRef?: string | null; recordId?: string },
  context: z.RefinementCtx
) {
  if (value.recordId && !value.blockRef) {
    context.addIssue({
      code: "custom",
      path: ["blockRef"],
      message: "blockRef is required when recordId is present."
    });
    return;
  }
  if (value.blockRef && value.taskId !== taskIdFromValidatedBlockRef(value.blockRef)) {
    context.addIssue({
      code: "custom",
      path: ["blockRef"],
      message: "blockRef must belong to taskId."
    });
  }
}

export const graphViewportSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive()
  })
  .strict();

export const graphNavigationSnapshotSchema = z
  .object({
    projectRoot: projectRootSchema,
    canvasId: canvasIdSchema,
    viewport: graphViewportSchema,
    selectedTaskId: taskIdSchema.nullable(),
    selectedBlockRef: claimRefSchema.nullable()
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (!snapshot.selectedBlockRef) {
      return;
    }
    if (snapshot.selectedTaskId !== taskIdFromValidatedBlockRef(snapshot.selectedBlockRef)) {
      context.addIssue({
        code: "custom",
        path: ["selectedBlockRef"],
        message: "selectedBlockRef must belong to selectedTaskId."
      });
    }
  });

export const taskWorkspaceNavigationTargetSchema = z
  .object({
    ...navigationTargetBaseShape,
    blockRef: claimRefSchema.optional(),
    // recordId selects a read model; executable actions require runtime capability identities.
    recordId: recordIdSchema.optional()
  })
  .strict()
  .superRefine(validateBlockOwnership);

export const taskWorkspaceTaskTargetSchema = z.object(navigationTargetBaseShape).strict();

export const blockWorkspaceTargetSchema = z
  .object({
    ...navigationTargetBaseShape,
    blockRef: claimRefSchema
  })
  .strict()
  .superRefine(validateBlockOwnership);

export const runWorkspaceTargetSchema = z
  .object({
    ...navigationTargetBaseShape,
    blockRef: claimRefSchema.optional(),
    recordId: recordIdSchema
  })
  .strict()
  .superRefine(validateBlockOwnership);

export const recordAuthorityTargetSchema = z
  .object({
    ...navigationTargetBaseShape,
    blockRef: claimRefSchema,
    recordId: recordIdSchema
  })
  .strict()
  .superRefine(validateBlockOwnership);

export const taskWorkspaceNavigationSourceSchema = z
  .object({
    view: sourceViewSchema,
    graphSnapshot: graphNavigationSnapshotSchema.optional()
  })
  .strict();

export const taskWorkspaceNavigationIdentitySchema = taskWorkspaceNavigationTargetSchema
  .safeExtend({
    source: taskWorkspaceNavigationSourceSchema
  })
  .strict();

export type GraphViewport = z.output<typeof graphViewportSchema>;
export type GraphNavigationSnapshot = z.output<typeof graphNavigationSnapshotSchema>;
export type GraphNavigationSnapshotInput = z.input<typeof graphNavigationSnapshotSchema>;
export type TaskWorkspaceNavigationTarget = z.output<typeof taskWorkspaceNavigationTargetSchema>;
export type TaskWorkspaceNavigationTargetInput = z.input<
  typeof taskWorkspaceNavigationTargetSchema
>;
export type TaskWorkspaceTargetInput = z.input<typeof taskWorkspaceTaskTargetSchema>;
export type BlockWorkspaceTargetInput = z.input<typeof blockWorkspaceTargetSchema>;
export type RunWorkspaceTargetInput = z.input<typeof runWorkspaceTargetSchema>;
export type TaskWorkspaceNavigationSource = z.output<typeof taskWorkspaceNavigationSourceSchema>;
export type TaskWorkspaceNavigationSourceInput = z.input<
  typeof taskWorkspaceNavigationSourceSchema
>;
export type TaskWorkspaceNavigationIdentity = z.output<
  typeof taskWorkspaceNavigationIdentitySchema
>;
export type TaskWorkspaceNavigationIdentityInput = z.input<
  typeof taskWorkspaceNavigationIdentitySchema
>;
export type RecordAuthorityTarget = z.output<typeof recordAuthorityTargetSchema>;

export function taskWorkspaceTarget(
  input: TaskWorkspaceTargetInput
): TaskWorkspaceNavigationTarget {
  return taskWorkspaceNavigationTargetSchema.parse(taskWorkspaceTaskTargetSchema.parse(input));
}

export function blockWorkspaceTarget(
  input: BlockWorkspaceTargetInput
): TaskWorkspaceNavigationTarget {
  return taskWorkspaceNavigationTargetSchema.parse(blockWorkspaceTargetSchema.parse(input));
}

export function runWorkspaceTarget(input: RunWorkspaceTargetInput): TaskWorkspaceNavigationTarget {
  return taskWorkspaceNavigationTargetSchema.parse(runWorkspaceTargetSchema.parse(input));
}

export function taskWorkspaceNavigationIdentity(
  target: TaskWorkspaceNavigationTarget,
  source: TaskWorkspaceNavigationSourceInput
): TaskWorkspaceNavigationIdentity {
  return taskWorkspaceNavigationIdentitySchema.parse({ ...target, source });
}

export function sameTaskWorkspaceNavigationIdentity(
  left: TaskWorkspaceNavigationIdentity,
  right: TaskWorkspaceNavigationIdentity
): boolean {
  return (
    left.projectRoot === right.projectRoot &&
    left.canvasId === right.canvasId &&
    left.taskId === right.taskId &&
    left.blockRef === right.blockRef &&
    left.recordId === right.recordId
  );
}

type ProjectAuthorityTarget = Pick<TaskWorkspaceNavigationTarget, "projectRoot">;
type CanvasAuthorityTarget = Pick<TaskWorkspaceNavigationTarget, "projectRoot" | "canvasId">;
type TaskAuthorityTarget = Pick<
  TaskWorkspaceNavigationTarget,
  "projectRoot" | "canvasId" | "taskId"
>;
type BlockAuthorityTarget = Pick<
  TaskWorkspaceNavigationTarget,
  "projectRoot" | "canvasId" | "taskId"
> & { blockRef: string };

export interface TaskWorkspaceNavigationAuthority {
  hasProject: (target: ProjectAuthorityTarget) => boolean;
  hasCanvas: (target: CanvasAuthorityTarget) => boolean;
  hasTask: (target: TaskAuthorityTarget) => boolean;
  hasBlock: (target: BlockAuthorityTarget) => boolean;
  hasRecord: (target: RecordAuthorityTarget) => boolean;
}

export type TaskWorkspaceNavigationInvalidReason =
  | "invalid_navigation"
  | "project_unavailable"
  | "canvas_unavailable"
  | "task_unavailable"
  | "block_unavailable"
  | "record_unavailable";

export type TaskWorkspaceNavigationResolution =
  | { status: "valid"; navigation: TaskWorkspaceNavigationIdentity }
  | {
      status: "invalid";
      reason: TaskWorkspaceNavigationInvalidReason;
      message: string;
    };

export function resolveTaskWorkspaceNavigation(
  input: unknown,
  authority: TaskWorkspaceNavigationAuthority
): TaskWorkspaceNavigationResolution {
  const parsed = taskWorkspaceNavigationIdentitySchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: "invalid_navigation",
      message: z.prettifyError(parsed.error)
    };
  }
  const navigation = parsed.data;
  const { projectRoot, canvasId, taskId, blockRef, recordId } = navigation;
  if (!authority.hasProject({ projectRoot })) {
    return {
      status: "invalid",
      reason: "project_unavailable",
      message: `Project '${projectRoot}' is unavailable.`
    };
  }
  if (!authority.hasCanvas({ projectRoot, canvasId })) {
    return {
      status: "invalid",
      reason: "canvas_unavailable",
      message: `Canvas '${canvasId}' is unavailable in project '${projectRoot}'.`
    };
  }
  if (!authority.hasTask({ projectRoot, canvasId, taskId })) {
    return {
      status: "invalid",
      reason: "task_unavailable",
      message: `Task '${taskId}' is unavailable in canvas '${canvasId}'.`
    };
  }
  if (blockRef && !authority.hasBlock({ projectRoot, canvasId, taskId, blockRef })) {
    return {
      status: "invalid",
      reason: "block_unavailable",
      message: `Block '${blockRef}' is unavailable for task '${taskId}' in canvas '${canvasId}'.`
    };
  }
  if (recordId) {
    if (!blockRef) {
      return {
        status: "invalid",
        reason: "invalid_navigation",
        message: "blockRef is required when recordId is present."
      };
    }
    const recordTarget = recordAuthorityTargetSchema.parse({
      projectRoot,
      canvasId,
      taskId,
      blockRef,
      recordId
    });
    if (!authority.hasRecord(recordTarget)) {
      return {
        status: "invalid",
        reason: "record_unavailable",
        message: `Run record '${recordId}' is unavailable for task '${taskId}' in canvas '${canvasId}'.`
      };
    }
  }
  return { status: "valid", navigation };
}

export type GraphNavigationSnapshotInvalidReason =
  | "invalid_snapshot"
  | "project_unavailable"
  | "canvas_unavailable"
  | "task_unavailable"
  | "block_unavailable";

export type GraphNavigationSnapshotResolution =
  | { status: "valid"; snapshot: GraphNavigationSnapshot }
  | {
      status: "invalid";
      reason: GraphNavigationSnapshotInvalidReason;
      message: string;
    };

export function resolveGraphNavigationSnapshot(
  input: unknown,
  authority: TaskWorkspaceNavigationAuthority
): GraphNavigationSnapshotResolution {
  const parsed = graphNavigationSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: "invalid_snapshot",
      message: z.prettifyError(parsed.error)
    };
  }
  const snapshot = parsed.data;
  const { projectRoot, canvasId, selectedTaskId, selectedBlockRef } = snapshot;
  if (!authority.hasProject({ projectRoot })) {
    return {
      status: "invalid",
      reason: "project_unavailable",
      message: `Project '${projectRoot}' is unavailable.`
    };
  }
  if (!authority.hasCanvas({ projectRoot, canvasId })) {
    return {
      status: "invalid",
      reason: "canvas_unavailable",
      message: `Canvas '${canvasId}' is unavailable in project '${projectRoot}'.`
    };
  }
  if (selectedTaskId && !authority.hasTask({ projectRoot, canvasId, taskId: selectedTaskId })) {
    return {
      status: "invalid",
      reason: "task_unavailable",
      message: `Task '${selectedTaskId}' is unavailable in canvas '${canvasId}'.`
    };
  }
  if (
    selectedTaskId &&
    selectedBlockRef &&
    !authority.hasBlock({
      projectRoot,
      canvasId,
      taskId: selectedTaskId,
      blockRef: selectedBlockRef
    })
  ) {
    return {
      status: "invalid",
      reason: "block_unavailable",
      message: `Block '${selectedBlockRef}' is unavailable for task '${selectedTaskId}' in canvas '${canvasId}'.`
    };
  }
  return { status: "valid", snapshot };
}
