import { z } from "zod";
import { artifactMediaTypeSchema } from "./artifactMediaType.js";
import { artifactRefSchema } from "./artifacts.js";
import { opaqueIdentifierSchema } from "./identifiers.js";
import { OUTPUT_MAX_ARTIFACT_BYTES } from "./limits.js";
import { agentHostProtocolVersionSchema } from "./version.js";

export const CANVAS_RUNTIME_JSON_MAX_DEPTH = 8 as const;
export const CANVAS_RUNTIME_JSON_MAX_ARRAY_ITEMS = 256 as const;
export const CANVAS_RUNTIME_JSON_MAX_OBJECT_KEYS = 128 as const;
export const CANVAS_RUNTIME_JSON_MAX_KEY_LENGTH = 128 as const;
export const CANVAS_RUNTIME_JSON_MAX_STRING_LENGTH = 16_384 as const;
export const CANVAS_RUNTIME_JSON_MAX_BYTES = 131_072 as const;
export const CANVAS_RUNTIME_ERROR_MESSAGE_MAX_LENGTH = 4_096 as const;
export const CANVAS_RUNTIME_SOURCE_REVISION_MAX_LENGTH = 256 as const;

const forbiddenJsonKeys = new Set(["__proto__", "constructor", "prototype"]);

type JsonPrimitive = string | number | boolean | null;
export type CanvasRuntimeJsonValue =
  | JsonPrimitive
  | CanvasRuntimeJsonValue[]
  | { [key: string]: CanvasRuntimeJsonValue };

function jsonValueSchemaAtDepth(depth: number): z.ZodType<CanvasRuntimeJsonValue> {
  const primitiveSchema = z.union([
    z.string().max(CANVAS_RUNTIME_JSON_MAX_STRING_LENGTH),
    z.number().finite(),
    z.boolean(),
    z.null()
  ]);
  if (depth >= CANVAS_RUNTIME_JSON_MAX_DEPTH) return primitiveSchema;
  const nested = z.lazy(() => jsonValueSchemaAtDepth(depth + 1));
  const arraySchema = z.array(nested).max(CANVAS_RUNTIME_JSON_MAX_ARRAY_ITEMS);
  const objectInputSchema = z
    .custom<Record<string, unknown>>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
          Object.getPrototypeOf(value) === null),
      "Canvas Runtime JSON object must be a plain object."
    )
    .superRefine((value, context) => {
      const keys = Object.keys(value);
      if (keys.length > CANVAS_RUNTIME_JSON_MAX_OBJECT_KEYS) {
        context.addIssue({ code: "custom", message: "Canvas Runtime JSON object is too large." });
      }
      for (const key of keys) {
        if (forbiddenJsonKeys.has(key)) {
          context.addIssue({
            code: "custom",
            message: "Canvas Runtime JSON contains a forbidden key.",
            path: [key]
          });
        }
      }
    });
  const objectSchema = objectInputSchema.pipe(
    z.record(z.string().min(1).max(CANVAS_RUNTIME_JSON_MAX_KEY_LENGTH), nested)
  );
  return z.union([primitiveSchema, arraySchema, objectSchema]);
}

export const canvasRuntimeJsonValueSchema: z.ZodType<CanvasRuntimeJsonValue> =
  jsonValueSchemaAtDepth(0).superRefine((value, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength > CANVAS_RUNTIME_JSON_MAX_BYTES
    ) {
      context.addIssue({ code: "custom", message: "Canvas Runtime JSON payload is too large." });
    }
  });

export const canvasRuntimeRequestIdSchema =
  opaqueIdentifierSchema.brand<"CanvasRuntimeRequestId">();
export const canvasRuntimeLeaseIdSchema = opaqueIdentifierSchema.brand<"CanvasRuntimeLeaseId">();
export const canvasRuntimeDeadlineSchema = z.iso.datetime();
export const canvasRuntimeSourceRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(CANVAS_RUNTIME_SOURCE_REVISION_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .brand<"CanvasRuntimeSourceRevision">();
export const canvasRuntimeGraphFingerprintSchema = z
  .string()
  .regex(/^pkg-[a-f0-9]{64}$/)
  .brand<"CanvasRuntimeGraphFingerprint">();

export const canvasRuntimeLogicalScopeSchema = z
  .object({
    workspaceId: opaqueIdentifierSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema
  })
  .strict();

export const canvasRuntimeSourceEvidenceSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    sourceRevision: canvasRuntimeSourceRevisionSchema,
    graphFingerprint: canvasRuntimeGraphFingerprintSchema
  })
  .strict();

const leasedOperationShape = {
  runtimeLeaseId: canvasRuntimeLeaseIdSchema
};

const mutationOperationShape = {
  ...leasedOperationShape,
  evidence: canvasRuntimeSourceEvidenceSchema,
  input: canvasRuntimeJsonValueSchema
};

function jsonObject(value: CanvasRuntimeJsonValue): Record<string, CanvasRuntimeJsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function requireMatchingField(
  input: CanvasRuntimeJsonValue,
  field: "operationId" | "sourceRevision" | "graphFingerprint",
  expected: string,
  context: z.RefinementCtx
): void {
  const actual = jsonObject(input)?.[field];
  if (actual !== undefined && actual !== expected) {
    context.addIssue({
      code: "custom",
      message: `Canvas Runtime ${field} must match the outer request evidence.`,
      path: ["input", field]
    });
  }
}

const availabilityOperationSchema = z.object({ operation: z.literal("availability") }).strict();
const acquireOperationSchema = z
  .object({
    operation: z.literal("acquire"),
    expectedEvidence: canvasRuntimeSourceEvidenceSchema.omit({ operationId: true }).optional()
  })
  .strict();
const statusOperationSchema = z
  .object({ operation: z.literal("status"), ...leasedOperationShape })
  .strict();
const inspectOperationSchema = z
  .object({
    operation: z.literal("inspect"),
    ...leasedOperationShape,
    input: canvasRuntimeJsonValueSchema
  })
  .strict();

function mutationOperationSchema<T extends string>(operation: T) {
  return z
    .object({ operation: z.literal(operation), ...mutationOperationShape })
    .strict()
    .superRefine((value, context) => {
      requireMatchingField(value.input, "operationId", value.evidence.operationId, context);
      requireMatchingField(value.input, "sourceRevision", value.evidence.sourceRevision, context);
      requireMatchingField(
        value.input,
        "graphFingerprint",
        value.evidence.graphFingerprint,
        context
      );
    });
}

function queryOperationSchema<T extends "query" | "reconcile">(operation: T) {
  return z
    .object({
      operation: z.literal(operation),
      ...leasedOperationShape,
      operationId: opaqueIdentifierSchema,
      input: canvasRuntimeJsonValueSchema
    })
    .strict()
    .superRefine((value, context) =>
      requireMatchingField(value.input, "operationId", value.operationId, context)
    );
}

const artifactReadOperationSchema = z
  .object({
    operation: z.literal("artifact_read"),
    ...leasedOperationShape,
    sourceRevision: canvasRuntimeSourceRevisionSchema,
    input: canvasRuntimeJsonValueSchema
  })
  .strict()
  .superRefine((value, context) =>
    requireMatchingField(value.input, "sourceRevision", value.sourceRevision, context)
  );
const releaseOperationSchema = z
  .object({ operation: z.literal("release"), ...leasedOperationShape })
  .strict();

export const canvasRuntimeOperationSchema = z.discriminatedUnion("operation", [
  availabilityOperationSchema,
  acquireOperationSchema,
  statusOperationSchema,
  inspectOperationSchema,
  mutationOperationSchema("claim"),
  mutationOperationSchema("activate"),
  queryOperationSchema("query"),
  queryOperationSchema("reconcile"),
  mutationOperationSchema("mark_interrupted"),
  mutationOperationSchema("resume_attempt"),
  mutationOperationSchema("retry_attempt"),
  mutationOperationSchema("complete"),
  mutationOperationSchema("fail"),
  artifactReadOperationSchema,
  releaseOperationSchema
]);

export const canvasRuntimeRequestCommandSchema = z
  .object({
    type: z.literal("canvas_runtime.request"),
    protocolVersion: agentHostProtocolVersionSchema,
    requestId: canvasRuntimeRequestIdSchema,
    scope: canvasRuntimeLogicalScopeSchema,
    deadline: canvasRuntimeDeadlineSchema,
    operation: canvasRuntimeOperationSchema
  })
  .strict();

export const canvasRuntimeCancelCommandSchema = z
  .object({
    type: z.literal("canvas_runtime.cancel"),
    protocolVersion: agentHostProtocolVersionSchema,
    requestId: canvasRuntimeRequestIdSchema,
    targetRequestId: canvasRuntimeRequestIdSchema,
    scope: canvasRuntimeLogicalScopeSchema,
    deadline: canvasRuntimeDeadlineSchema
  })
  .strict()
  .refine((command) => command.requestId !== command.targetRequestId, {
    message: "Canvas Runtime cancel request must have its own request identity.",
    path: ["targetRequestId"]
  });

export const canvasRuntimeUnavailableReasonSchema = z.enum([
  "runtime_not_attached",
  "host_offline",
  "content_out_of_sync"
]);

const canvasRuntimeAvailabilityResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      status: canvasRuntimeJsonValueSchema,
      sourceRevision: canvasRuntimeSourceRevisionSchema,
      graphFingerprint: canvasRuntimeGraphFingerprintSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: canvasRuntimeUnavailableReasonSchema,
      lastSeenAt: z.iso.datetime().optional()
    })
    .strict()
]);

const canvasRuntimeAcquireResultSchema = z
  .object({
    runtimeLeaseId: canvasRuntimeLeaseIdSchema,
    sourceRevision: canvasRuntimeSourceRevisionSchema,
    graphFingerprint: canvasRuntimeGraphFingerprintSchema,
    acquiredAt: z.iso.datetime(),
    expiresAt: z.iso.datetime()
  })
  .strict()
  .refine((result) => Date.parse(result.expiresAt) > Date.parse(result.acquiredAt), {
    message: "Canvas Runtime lease must expire after it is acquired.",
    path: ["expiresAt"]
  });

export const canvasRuntimeArtifactMetadataSchema = z
  .object({
    artifactRef: artifactRefSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().positive().safe(),
    mediaType: artifactMediaTypeSchema
  })
  .strict()
  .refine((artifact) => artifact.sizeBytes <= OUTPUT_MAX_ARTIFACT_BYTES, {
    message: `Canvas Runtime artifact must not exceed ${OUTPUT_MAX_ARTIFACT_BYTES} bytes.`,
    path: ["sizeBytes"]
  })
  .refine((artifact) => artifact.artifactRef === `artifact:sha256:${artifact.sha256}`, {
    message: "Canvas Runtime artifact reference must match its digest.",
    path: ["artifactRef"]
  });

const canvasRuntimeArtifactTransferBaseSchema = z.object({
  version: z.literal("canvas-runtime-artifact-transfer/v1"),
  grantId: opaqueIdentifierSchema,
  runtimeLeaseId: canvasRuntimeLeaseIdSchema,
  artifactRef: artifactRefSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: artifactMediaTypeSchema,
  expiresAt: z.iso.datetime()
});

export const canvasRuntimeArtifactTransferDescriptorSchema = z
  .discriminatedUnion("direction", [
    canvasRuntimeArtifactTransferBaseSchema
      .extend({
        direction: z.literal("download"),
        sizeBytes: z.number().int().positive().max(OUTPUT_MAX_ARTIFACT_BYTES)
      })
      .strict(),
    canvasRuntimeArtifactTransferBaseSchema
      .extend({
        direction: z.literal("upload"),
        maxSizeBytes: z.number().int().positive().max(OUTPUT_MAX_ARTIFACT_BYTES)
      })
      .strict()
  ])
  .superRefine((descriptor, context) => {
    if (descriptor.artifactRef !== `artifact:sha256:${descriptor.sha256}`) {
      context.addIssue({
        code: "custom",
        message: "Canvas Runtime artifact transfer reference must match its digest.",
        path: ["artifactRef"]
      });
    }
  });

export const canvasRuntimeArtifactTransferInputSchema = z
  .object({
    domainInput: canvasRuntimeJsonValueSchema,
    transfer: canvasRuntimeArtifactTransferDescriptorSchema
  })
  .strict();

const genericSuccessOperations = [
  "status",
  "inspect",
  "claim",
  "activate",
  "query",
  "reconcile",
  "mark_interrupted",
  "resume_attempt",
  "retry_attempt",
  "complete",
  "fail"
] as const;

const genericSuccessSchemas = genericSuccessOperations.map((operation) =>
  z
    .object({
      outcome: z.literal("success"),
      operation: z.literal(operation),
      result: canvasRuntimeJsonValueSchema
    })
    .strict()
);

export const canvasRuntimeSuccessSchema = z.discriminatedUnion("operation", [
  z
    .object({
      outcome: z.literal("success"),
      operation: z.literal("availability"),
      result: canvasRuntimeAvailabilityResultSchema
    })
    .strict(),
  z
    .object({
      outcome: z.literal("success"),
      operation: z.literal("acquire"),
      result: canvasRuntimeAcquireResultSchema
    })
    .strict(),
  ...genericSuccessSchemas,
  z
    .object({
      outcome: z.literal("success"),
      operation: z.literal("artifact_read"),
      result: canvasRuntimeArtifactMetadataSchema
    })
    .strict(),
  z
    .object({
      outcome: z.literal("success"),
      operation: z.literal("release"),
      result: z.object({ released: z.literal(true) }).strict()
    })
    .strict(),
  z
    .object({
      outcome: z.literal("success"),
      operation: z.literal("cancel"),
      result: z
        .object({ targetRequestId: canvasRuntimeRequestIdSchema, cancelled: z.boolean() })
        .strict()
    })
    .strict()
]);

export const canvasRuntimeErrorSchema = z
  .object({
    outcome: z.literal("error"),
    operation: z.enum([
      "availability",
      "acquire",
      "status",
      "inspect",
      "claim",
      "activate",
      "query",
      "reconcile",
      "mark_interrupted",
      "resume_attempt",
      "retry_attempt",
      "complete",
      "fail",
      "artifact_read",
      "release",
      "cancel"
    ]),
    error: z
      .object({
        code: opaqueIdentifierSchema,
        message: z.string().min(1).max(CANVAS_RUNTIME_ERROR_MESSAGE_MAX_LENGTH),
        retryable: z.boolean(),
        reconcileRequired: z.boolean().optional()
      })
      .strict()
  })
  .strict();

export const canvasRuntimeResponsePayloadSchema = z
  .object({
    type: z.literal("canvas_runtime.response"),
    protocolVersion: agentHostProtocolVersionSchema,
    requestId: canvasRuntimeRequestIdSchema,
    response: z.union([canvasRuntimeSuccessSchema, canvasRuntimeErrorSchema])
  })
  .strict();

export type CanvasRuntimeLogicalScope = z.infer<typeof canvasRuntimeLogicalScopeSchema>;
export type CanvasRuntimeRequestId = z.infer<typeof canvasRuntimeRequestIdSchema>;
export type CanvasRuntimeLeaseId = z.infer<typeof canvasRuntimeLeaseIdSchema>;
export type CanvasRuntimeSourceEvidence = z.infer<typeof canvasRuntimeSourceEvidenceSchema>;
export type CanvasRuntimeArtifactTransferDescriptor = z.infer<
  typeof canvasRuntimeArtifactTransferDescriptorSchema
>;
export type CanvasRuntimeArtifactTransferInput = z.infer<
  typeof canvasRuntimeArtifactTransferInputSchema
>;
export type CanvasRuntimeOperation = z.infer<typeof canvasRuntimeOperationSchema>;
export type CanvasRuntimeRequestCommand = z.infer<typeof canvasRuntimeRequestCommandSchema>;
export type CanvasRuntimeCancelCommand = z.infer<typeof canvasRuntimeCancelCommandSchema>;
export type CanvasRuntimeResponsePayload = z.infer<typeof canvasRuntimeResponsePayloadSchema>;
