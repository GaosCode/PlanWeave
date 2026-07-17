import { z } from "zod";
import {
  acpRequestIdSchema,
  acpSessionIdSchema,
  canvasIdSchema,
  claimRefSchema,
  executorRunIdSchema,
  projectIdSchema
} from "./runnerContractSchemas.js";
import { safeRunnerEventTextSchema, utf8ByteLength } from "./runnerEventRedaction.js";

export const runnerPermissionInteractionVersionSchema = z.literal(
  "planweave.runner-interaction/v1"
);
export const runnerPermissionInteractionResponseVersionSchema = z.literal(
  "planweave.runner-interaction-response/v1"
);
export const runnerInteractionSnapshotVersionSchema = z.literal(
  "planweave.runner-interaction-snapshot/v1"
);
export const runnerInteractionResponseReceiptVersionSchema = z.literal(
  "planweave.runner-interaction-response-receipt/v1"
);
export const runnerInteractionOwnerResultVersionSchema = z.literal(
  "planweave.runner-interaction-owner-result/v1"
);
export const runnerInteractionSettlementVersionSchema = z.literal(
  "planweave.runner-interaction-settlement/v1"
);

const nonEmptySafeTextSchema = (maxBytes: number, fieldName: string) =>
  safeRunnerEventTextSchema(maxBytes, fieldName).refine(
    (value) => value.trim().length > 0,
    `${fieldName} must not be empty.`
  );

const opaqueAcpIdSchema = (fieldName: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => utf8ByteLength(value) <= 1024,
      `${fieldName} exceeds the 1024-byte UTF-8 limit.`
    );

export const runnerToolCallIdSchema = opaqueAcpIdSchema("ACP tool call id");
export const runnerPermissionOptionIdSchema = opaqueAcpIdSchema("ACP permission option id");

export const runnerInteractionClientLabelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Decision source must be a stable client label.");

export const runnerInteractionIdentitySchema = z
  .object({
    projectId: projectIdSchema,
    canvasId: canvasIdSchema,
    claimRef: claimRefSchema,
    executorRunId: executorRunIdSchema,
    sessionId: acpSessionIdSchema,
    requestId: acpRequestIdSchema,
    ownerLeaseId: z.string().uuid(),
    ownerGeneration: z.number().int().positive()
  })
  .strict();
export type RunnerInteractionIdentity = z.infer<typeof runnerInteractionIdentitySchema>;

export const runnerInteractionActionIdentitySchema = z
  .object({
    recordId: z.string().min(1).max(2048),
    requestId: acpRequestIdSchema,
    ownerLeaseId: z.string().uuid()
  })
  .strict();
export type RunnerInteractionActionIdentity = z.infer<typeof runnerInteractionActionIdentitySchema>;

export const runnerPermissionDecisionSchema = z.enum(["approve", "deny"]);
export type RunnerPermissionDecision = z.infer<typeof runnerPermissionDecisionSchema>;

export const runnerPermissionOptionSchema = z
  .object({
    optionId: runnerPermissionOptionIdSchema,
    label: nonEmptySafeTextSchema(1024, "Permission option label"),
    decision: runnerPermissionDecisionSchema
  })
  .strict();
export type RunnerPermissionOption = z.infer<typeof runnerPermissionOptionSchema>;

export const runnerPermissionInteractionRequestSchema = z
  .object({
    version: runnerPermissionInteractionVersionSchema,
    kind: z.literal("permission"),
    identity: runnerInteractionIdentitySchema,
    requestedAt: z.string().datetime(),
    summary: nonEmptySafeTextSchema(4096, "Permission request summary"),
    toolCallId: runnerToolCallIdSchema,
    options: z.array(runnerPermissionOptionSchema).min(1).max(64)
  })
  .strict()
  .superRefine((request, context) => {
    const seen = new Set<string>();
    request.options.forEach((option, index) => {
      if (seen.has(option.optionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", index, "optionId"],
          message: `Permission optionId '${option.optionId}' must be unique.`
        });
      }
      seen.add(option.optionId);
    });
  });
export type RunnerPermissionInteractionRequest = z.infer<
  typeof runnerPermissionInteractionRequestSchema
>;

// The first version intentionally contains permission only. New interaction kinds
// get their own strict member rather than widening this persisted contract.
export const runnerInteractionRequestSchema = runnerPermissionInteractionRequestSchema;
export type RunnerInteractionRequest = z.infer<typeof runnerInteractionRequestSchema>;

export const runnerPermissionInteractionDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("select"),
      optionId: runnerPermissionOptionIdSchema
    })
    .strict(),
  z.object({ kind: z.literal("cancel") }).strict()
]);
export type RunnerPermissionInteractionDecision = z.infer<
  typeof runnerPermissionInteractionDecisionSchema
>;

export const runnerPermissionInteractionResponseSchema = z
  .object({
    version: runnerPermissionInteractionResponseVersionSchema,
    identity: runnerInteractionIdentitySchema,
    decision: runnerPermissionInteractionDecisionSchema,
    respondedAt: z.string().datetime(),
    decisionSource: runnerInteractionClientLabelSchema,
    reason: nonEmptySafeTextSchema(4096, "Permission response reason").nullable()
  })
  .strict()
  .superRefine((response, context) => {
    if (response.decision.kind === "cancel" && response.reason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A cancelled permission response requires a reason."
      });
    }
  });
export type RunnerPermissionInteractionResponse = z.infer<
  typeof runnerPermissionInteractionResponseSchema
>;

export const runnerInteractionOwnerResultSchema = z
  .object({
    version: runnerInteractionOwnerResultVersionSchema,
    identity: runnerInteractionIdentitySchema,
    outcome: z.literal("expired"),
    reason: z.enum(["establishment_failed", "aborted", "deadline", "terminal_cleanup"]),
    recordedAt: z.string().datetime(),
    message: nonEmptySafeTextSchema(4096, "Runner interaction owner result message")
  })
  .strict();
export type RunnerInteractionOwnerResult = z.infer<typeof runnerInteractionOwnerResultSchema>;

export const runnerInteractionSettlementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: runnerInteractionSettlementVersionSchema,
      kind: z.literal("response"),
      response: runnerPermissionInteractionResponseSchema
    })
    .strict(),
  z
    .object({
      version: runnerInteractionSettlementVersionSchema,
      kind: z.literal("owner_result"),
      ownerResult: runnerInteractionOwnerResultSchema
    })
    .strict()
]);
export type RunnerInteractionSettlement = z.infer<typeof runnerInteractionSettlementSchema>;

export const runnerInteractionErrorCodeSchema = z.enum([
  "interaction_contract_invalid",
  "interaction_request_conflict",
  "interaction_already_answered",
  "interaction_identity_mismatch",
  "interaction_owner_replaced",
  "interaction_owner_unavailable",
  "interaction_run_terminal",
  "interaction_option_not_advertised",
  "interaction_not_found",
  "interaction_path_invalid",
  "interaction_path_unsafe"
]);
export type RunnerInteractionErrorCode = z.infer<typeof runnerInteractionErrorCodeSchema>;

export const runnerInteractionSnapshotSchema = z
  .object({
    version: runnerInteractionSnapshotVersionSchema,
    interactionId: acpRequestIdSchema,
    status: z.enum(["pending", "answered", "expired"]),
    request: runnerPermissionInteractionRequestSchema,
    response: runnerPermissionInteractionResponseSchema.nullable(),
    ownerResult: runnerInteractionOwnerResultSchema.nullable().default(null)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const expectedStatus = snapshot.response
      ? "answered"
      : snapshot.ownerResult
        ? "expired"
        : "pending";
    if (snapshot.status !== expectedStatus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Interaction snapshot status must match response presence."
      });
    }
    if (snapshot.response && snapshot.ownerResult) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownerResult"],
        message: "Interaction snapshot cannot contain both a client response and owner result."
      });
    }
    if (snapshot.interactionId !== snapshot.request.identity.requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interactionId"],
        message: "Interaction snapshot id must equal the request id."
      });
    }
  });
export type RunnerInteractionSnapshot = z.infer<typeof runnerInteractionSnapshotSchema>;

export const runnerInteractionResponseReceiptSchema = z
  .object({
    version: runnerInteractionResponseReceiptVersionSchema,
    identity: runnerInteractionIdentitySchema,
    acceptedAt: z.string().datetime(),
    decision: runnerPermissionInteractionDecisionSchema,
    selectedOption: runnerPermissionOptionSchema.nullable(),
    decisionSource: runnerInteractionClientLabelSchema
  })
  .strict()
  .superRefine((receipt, context) => {
    if ((receipt.decision.kind === "cancel") !== (receipt.selectedOption === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedOption"],
        message: "Only a selected decision may include the selected option."
      });
    }
    if (
      receipt.decision.kind === "select" &&
      receipt.selectedOption?.optionId !== receipt.decision.optionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedOption", "optionId"],
        message: "Receipt selected option must match the decision optionId."
      });
    }
  });
export type RunnerInteractionResponseReceipt = z.infer<
  typeof runnerInteractionResponseReceiptSchema
>;

export function runnerInteractionIdentityMatches(
  left: RunnerInteractionIdentity,
  right: RunnerInteractionIdentity
): boolean {
  return (
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId &&
    left.claimRef === right.claimRef &&
    left.executorRunId === right.executorRunId &&
    left.sessionId === right.sessionId &&
    left.requestId === right.requestId &&
    left.ownerLeaseId === right.ownerLeaseId &&
    left.ownerGeneration === right.ownerGeneration
  );
}
