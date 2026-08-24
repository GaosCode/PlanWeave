import {
  canvasIdSchema,
  claimRefSchema,
  taskIdSchema,
  taskWorkspaceInputSchema
} from "@planweave-ai/runtime/browser";
import { z } from "zod";
import { workspaceCanvasLocatorSchema } from "../shared/canvasLocator";
import { graphAppViewSchema, nonGraphRegularAppViewSchema } from "./appViewContract";

const projectRootSchema = taskWorkspaceInputSchema.shape.projectRoot;
const recordIdSchema = taskWorkspaceInputSchema.shape.selectedRecordId.unwrap().unwrap();
const localNavigationTargetBaseShape = {
  projectRoot: projectRootSchema,
  canvasId: canvasIdSchema,
  taskId: taskIdSchema
};
const workspaceNavigationTargetBaseShape = {
  authority: z.literal("workspace"),
  ...workspaceCanvasLocatorSchema.omit({ kind: true }).shape,
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

const localTaskWorkspaceNavigationTargetSchema = z
  .object({
    ...localNavigationTargetBaseShape,
    blockRef: claimRefSchema.optional(),
    // recordId selects a read model; executable actions require runtime capability identities.
    recordId: recordIdSchema.optional()
  })
  .strict()
  .superRefine(validateBlockOwnership);

const workspaceTaskWorkspaceNavigationTargetSchema = z
  .object({
    ...workspaceNavigationTargetBaseShape,
    blockRef: claimRefSchema.optional(),
    recordId: recordIdSchema.optional()
  })
  .strict()
  .superRefine(validateBlockOwnership);

export const taskWorkspaceNavigationTargetSchema = z.union([
  localTaskWorkspaceNavigationTargetSchema,
  workspaceTaskWorkspaceNavigationTargetSchema
]);

export const taskWorkspaceTaskTargetSchema = z.object(localNavigationTargetBaseShape).strict();

export const blockWorkspaceTargetSchema = z
  .object({
    ...localNavigationTargetBaseShape,
    blockRef: claimRefSchema
  })
  .strict()
  .superRefine(validateBlockOwnership);

export const runWorkspaceTargetSchema = z
  .object({
    ...localNavigationTargetBaseShape,
    blockRef: claimRefSchema.optional(),
    recordId: recordIdSchema
  })
  .strict()
  .superRefine(validateBlockOwnership);

export const recordAuthorityTargetSchema = z
  .object({
    ...localNavigationTargetBaseShape,
    blockRef: claimRefSchema,
    recordId: recordIdSchema
  })
  .strict()
  .superRefine(validateBlockOwnership);

export const taskWorkspaceNavigationSourceSchema = z.discriminatedUnion("view", [
  z
    .object({
      view: graphAppViewSchema,
      graphSnapshot: graphNavigationSnapshotSchema.optional()
    })
    .strict(),
  z.object({ view: nonGraphRegularAppViewSchema }).strict()
]);

export const workspaceBlockWorkspaceTargetSchema = z
  .object({
    ...workspaceNavigationTargetBaseShape,
    blockRef: claimRefSchema
  })
  .strict()
  .superRefine(validateBlockOwnership);

export const workspaceTaskWorkspaceTargetSchema = z
  .object(workspaceNavigationTargetBaseShape)
  .strict();

export const taskWorkspaceNavigationIdentitySchema = z.union([
  localTaskWorkspaceNavigationTargetSchema.safeExtend({
    source: taskWorkspaceNavigationSourceSchema
  }),
  workspaceTaskWorkspaceNavigationTargetSchema.safeExtend({
    source: taskWorkspaceNavigationSourceSchema
  })
]);

export type GraphViewport = z.output<typeof graphViewportSchema>;
export type GraphNavigationSnapshot = z.output<typeof graphNavigationSnapshotSchema>;
export type GraphNavigationSnapshotInput = z.input<typeof graphNavigationSnapshotSchema>;
export type TaskWorkspaceNavigationTarget = z.output<typeof taskWorkspaceNavigationTargetSchema>;
export type LocalTaskWorkspaceNavigationTarget = z.output<
  typeof localTaskWorkspaceNavigationTargetSchema
>;
export type WorkspaceTaskWorkspaceNavigationTarget = z.output<
  typeof workspaceTaskWorkspaceNavigationTargetSchema
>;
export type TaskWorkspaceNavigationTargetInput = z.input<
  typeof taskWorkspaceNavigationTargetSchema
>;
export type TaskWorkspaceTargetInput = z.input<typeof taskWorkspaceTaskTargetSchema>;
export type BlockWorkspaceTargetInput = z.input<typeof blockWorkspaceTargetSchema>;
export type RunWorkspaceTargetInput = z.input<typeof runWorkspaceTargetSchema>;
export type WorkspaceBlockWorkspaceTargetInput = z.input<
  typeof workspaceBlockWorkspaceTargetSchema
>;
export type WorkspaceTaskWorkspaceTargetInput = z.input<typeof workspaceTaskWorkspaceTargetSchema>;
export type TaskWorkspaceNavigationSource = z.output<typeof taskWorkspaceNavigationSourceSchema>;
export type TaskWorkspaceNavigationSourceInput = z.input<
  typeof taskWorkspaceNavigationSourceSchema
>;
export type TaskWorkspaceNavigationIdentity = z.output<
  typeof taskWorkspaceNavigationIdentitySchema
>;
export type LocalTaskWorkspaceNavigationIdentity = Exclude<
  TaskWorkspaceNavigationIdentity,
  { authority: "workspace" }
>;
export type WorkspaceTaskWorkspaceNavigationIdentity = Extract<
  TaskWorkspaceNavigationIdentity,
  { authority: "workspace" }
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

export function workspaceBlockWorkspaceTarget(
  input: WorkspaceBlockWorkspaceTargetInput
): TaskWorkspaceNavigationTarget {
  return taskWorkspaceNavigationTargetSchema.parse(
    workspaceBlockWorkspaceTargetSchema.parse(input)
  );
}

export function workspaceTaskWorkspaceTarget(
  input: WorkspaceTaskWorkspaceTargetInput
): TaskWorkspaceNavigationTarget {
  return taskWorkspaceNavigationTargetSchema.parse(workspaceTaskWorkspaceTargetSchema.parse(input));
}

export function isWorkspaceTaskWorkspaceNavigation(
  target: TaskWorkspaceNavigationIdentity
): target is WorkspaceTaskWorkspaceNavigationIdentity;
export function isWorkspaceTaskWorkspaceNavigation(
  target: TaskWorkspaceNavigationTarget
): target is WorkspaceTaskWorkspaceNavigationTarget;
export function isWorkspaceTaskWorkspaceNavigation(
  target: TaskWorkspaceNavigationTarget | TaskWorkspaceNavigationIdentity
): boolean {
  return "authority" in target && target.authority === "workspace";
}

export function taskWorkspaceNavigationAuthorityKey(
  target: TaskWorkspaceNavigationTarget | TaskWorkspaceNavigationIdentity
): string {
  return isWorkspaceTaskWorkspaceNavigation(target)
    ? JSON.stringify([
        "workspace",
        target.connectionProfileId,
        target.workspaceId,
        target.projectId,
        target.canvasId,
        target.taskId
      ])
    : JSON.stringify(["local", target.projectRoot, target.canvasId, target.taskId]);
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
    taskWorkspaceNavigationAuthorityKey(left) === taskWorkspaceNavigationAuthorityKey(right) &&
    left.blockRef === right.blockRef &&
    left.recordId === right.recordId
  );
}

type ProjectAuthorityTarget = Pick<LocalTaskWorkspaceNavigationTarget, "projectRoot">;
type CanvasAuthorityTarget = Pick<LocalTaskWorkspaceNavigationTarget, "projectRoot" | "canvasId">;
type TaskAuthorityTarget = Pick<
  LocalTaskWorkspaceNavigationTarget,
  "projectRoot" | "canvasId" | "taskId"
>;
type BlockAuthorityTarget = Pick<
  LocalTaskWorkspaceNavigationTarget,
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
  if (isWorkspaceTaskWorkspaceNavigation(navigation)) {
    return { status: "valid", navigation };
  }
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
