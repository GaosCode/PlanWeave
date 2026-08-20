import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  actorRefSchema,
  humanAssignReasonSchema,
  humanProjectIdSchema,
  timestampSchema,
  workItemRefSchema,
  type WorkItemRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  assignmentTargetSchema,
  type AssignmentTarget
} from "@planweave-ai/collaboration-protocol/work/assignment";
export {
  workItemPackageFactsSchema,
  type WorkItemPackageFacts
} from "@planweave-ai/collaboration-protocol/work/package-facts";
import { z } from "zod";
import { humanAuthContextSchema } from "../identity/schemas.js";
import { WORK_ASSIGNMENT_BATCH_MAX } from "./limits.js";

export { workItemRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
export type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
export {
  assignmentAvailabilityReasonSchema,
  assignmentAvailabilitySchema,
  assignmentDisplayProjectionSchema,
  assignmentHostDisplaySchema,
  assignmentHostFactsSchema,
  assignmentHumanDisplaySchema,
  assignmentMembershipFactsSchema,
  eligibleHostBatchRequestSchema,
  assignmentTargetSchema
} from "@planweave-ai/collaboration-protocol/work/assignment";
export type {
  AssignmentAvailability,
  AssignmentAvailabilityReason,
  AssignmentDisplayProjection,
  AssignmentHostDisplay,
  AssignmentHostFacts,
  AssignmentHumanDisplay,
  AssignmentMembershipFacts,
  AssignmentTarget,
  EligibleHostBatchItem,
  EligibleHostBatchRequest,
  EligibleHostBatchResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";

/** Machine targets remain invalid for Task work items. */
export function isMachineAssignmentTarget(target: AssignmentTarget): boolean {
  return target.kind === "exact_host" || target.kind === "automatic_host";
}

export function assertTargetAllowedForWorkItem(
  workItem: WorkItemRef,
  target: AssignmentTarget
): { ok: true } | { ok: false; message: string } {
  if (workItem.kind === "task" && isMachineAssignmentTarget(target)) {
    return {
      ok: false,
      message:
        "Tasks may only be unassigned or assigned to a human member; Host targets are invalid."
    };
  }
  return { ok: true };
}

/** Durable assignment record. Revision 0 represents absence and is never stored. */
export const assignmentRecordSchema = z
  .object({
    workspaceId: opaqueIdentifierSchema,
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    target: assignmentTargetSchema,
    revision: z.number().int().positive(),
    updatedBy: actorRefSchema,
    updatedAt: timestampSchema,
    reason: humanAssignReasonSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const kindOk = assertTargetAllowedForWorkItem(value.workItem, value.target);
    if (!kindOk.ok) {
      ctx.addIssue({ code: "custom", message: kindOk.message, path: ["target"] });
    }
  });
export type AssignmentRecord = z.infer<typeof assignmentRecordSchema>;

/** Actor-bound optimistic-concurrency command used inside Server. */
export const assignmentUpdateCommandSchema = z
  .object({
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    target: assignmentTargetSchema,
    expectedRevision: z.number().int().nonnegative(),
    actor: humanAuthContextSchema,
    reason: humanAssignReasonSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.actor.projectId !== value.projectId) {
      ctx.addIssue({
        code: "custom",
        message: "Actor projectId must match assignment projectId",
        path: ["actor", "projectId"]
      });
    }
    const kindOk = assertTargetAllowedForWorkItem(value.workItem, value.target);
    if (!kindOk.ok) {
      ctx.addIssue({ code: "custom", message: kindOk.message, path: ["target"] });
    }
  });
export type AssignmentUpdateCommand = z.infer<typeof assignmentUpdateCommandSchema>;

export const workAssignmentBatchLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(WORK_ASSIGNMENT_BATCH_MAX);

/** Current durable assignment compare-and-set facts. */
export const assignmentConcurrencyFactsSchema = z
  .object({
    currentRevision: z.number().int().nonnegative(),
    current: assignmentRecordSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.current === undefined) {
      if (value.currentRevision !== 0) {
        ctx.addIssue({
          code: "custom",
          message: "missing assignment record requires currentRevision 0",
          path: ["currentRevision"]
        });
      }
      return;
    }
    if (value.current.revision !== value.currentRevision) {
      ctx.addIssue({
        code: "custom",
        message: "currentRevision must match current.revision",
        path: ["currentRevision"]
      });
    }
  });
export type AssignmentConcurrencyFacts = z.infer<typeof assignmentConcurrencyFactsSchema>;
