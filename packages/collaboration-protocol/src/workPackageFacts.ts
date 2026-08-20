import {
  blockRefSchema,
  canvasRuntimeGraphFingerprintSchema,
  canvasRuntimeSourceRevisionSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import { WORK_ASSIGNMENT_BATCH_MAX } from "./limits.js";
import { workItemRefSchema, type WorkItemRef } from "./primitives.js";

/** Immutable Plan Package facts used by collaboration Work policy. */
export const workItemPackageFactsSchema = z
  .object({
    canvasId: opaqueIdentifierSchema,
    kind: z.enum(["task", "block"]),
    exists: z.boolean(),
    taskId: opaqueIdentifierSchema.optional(),
    blockRef: blockRefSchema.optional(),
    blockType: z.enum(["implementation", "review"]).optional(),
    requiredCapabilities: z.array(z.string().min(1)).max(128)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "task") {
      if (value.taskId === undefined) {
        context.addIssue({
          code: "custom",
          message: "task facts require taskId",
          path: ["taskId"]
        });
      }
      if (value.blockRef !== undefined || value.blockType !== undefined) {
        context.addIssue({
          code: "custom",
          message: "task facts must not include block fields",
          path: ["blockRef"]
        });
      }
    }
    if (value.kind === "block" && value.blockRef === undefined) {
      context.addIssue({
        code: "custom",
        message: "block facts require blockRef",
        path: ["blockRef"]
      });
    }
  });
export type WorkItemPackageFacts = z.infer<typeof workItemPackageFactsSchema>;

export const resolveWorkItemsRequestSchema = z
  .object({
    workItems: z.array(workItemRefSchema).min(1).max(WORK_ASSIGNMENT_BATCH_MAX)
  })
  .strict();
export type ResolveWorkItemsRequest = z.infer<typeof resolveWorkItemsRequestSchema>;

export const resolveWorkItemsResultSchema = z
  .object({
    sourceRevision: canvasRuntimeSourceRevisionSchema,
    graphFingerprint: canvasRuntimeGraphFingerprintSchema,
    facts: z.array(workItemPackageFactsSchema).min(1).max(WORK_ASSIGNMENT_BATCH_MAX)
  })
  .strict();
export type ResolveWorkItemsResult = z.infer<typeof resolveWorkItemsResultSchema>;

function factMatchesReference(fact: WorkItemPackageFacts, reference: WorkItemRef): boolean {
  if (fact.canvasId !== reference.canvasId || fact.kind !== reference.kind) return false;
  return reference.kind === "task"
    ? fact.taskId === reference.taskId
    : fact.blockRef === reference.blockRef;
}

/** Parse a response and bind every fact to the request identity and order. */
export function parseResolveWorkItemsResult(
  requestInput: unknown,
  resultInput: unknown
): ResolveWorkItemsResult {
  const request = resolveWorkItemsRequestSchema.parse(requestInput);
  return resolveWorkItemsResultSchema
    .superRefine((result, context) => {
      if (result.facts.length !== request.workItems.length) {
        context.addIssue({
          code: "custom",
          message: "Work package facts result length must match the request.",
          path: ["facts"]
        });
        return;
      }
      for (const [index, reference] of request.workItems.entries()) {
        const fact = result.facts[index];
        if (!fact || !factMatchesReference(fact, reference)) {
          context.addIssue({
            code: "custom",
            message: "Work package facts must preserve request identity and order.",
            path: ["facts", index]
          });
        }
      }
    })
    .parse(resultInput);
}
