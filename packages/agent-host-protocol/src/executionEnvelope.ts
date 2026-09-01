import { z } from "zod";
import { artifactMediaTypeSchema } from "./artifactMediaType.js";
import { artifactRefSchema } from "./artifacts.js";
import { blockRefSchema } from "./blockRef.js";
import { capabilitiesSchema, hasCanvasRuntimeExecutionCapability } from "./capabilities.js";
import { canonicalizeJson } from "./canonicalJson.js";
import { executionIdentitySchema } from "./executionIdentity.js";
import { opaqueIdentifierSchema } from "./identifiers.js";
import {
  ACCEPTANCE_ITEM_MAX_LENGTH,
  ACCEPTANCE_MAX_COUNT,
  DEPENDENCY_SUMMARY_MAX_COUNT,
  DEPENDENCY_SUMMARY_MAX_LENGTH,
  EXECUTION_ENVELOPE_MAX_BYTES,
  INPUT_ARTIFACT_MAX_COUNT,
  INPUT_ARTIFACT_NAME_MAX_LENGTH,
  OUTPUT_MAX_ARTIFACT_BYTES,
  OUTPUT_MAX_ARTIFACT_COUNT,
  RENDERED_PROMPT_MAX_LENGTH,
  SESSION_CONFIG_OPTION_MAX_COUNT,
  SOURCE_IDENTITY_MAX_LENGTH
} from "./limits.js";
import { ownerPackageLocatorSchema } from "./ownerPackageLocator.js";

/** Current incompatible Execution Envelope wire shape. */
export const executionEnvelopeProtocolVersion = 2 as const;

/** Digest algorithm used for Execution Envelope content addressing. */
export const executionEnvelopeDigestAlgorithm = "sha256" as const;

/** Prefix for content-addressed Execution Envelope digests. */
export const executionEnvelopeDigestPrefix = "envelope:sha256:" as const;
export const executionEnvelopeDigestSchema = z.string().regex(/^envelope:sha256:[a-f0-9]{64}$/);
export type ExecutionEnvelopeDigest = z.infer<typeof executionEnvelopeDigestSchema>;

const utf8Encoder = new TextEncoder();

function boundedUtf8String(options: { minBytes?: number; maxBytes: number }) {
  return z.string().refine(
    (value) => {
      const byteLength = utf8Encoder.encode(value).byteLength;
      return byteLength >= (options.minBytes ?? 0) && byteLength <= options.maxBytes;
    },
    `must be between ${options.minBytes ?? 0} and ${options.maxBytes} UTF-8 bytes`
  );
}

const sourceIdentitySchema = z
  .string()
  .min(1)
  .max(SOURCE_IDENTITY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const executionRuntimeAuthoritySchema = z.enum(["owner_canvas", "workspace_canvas"]);
export type ExecutionRuntimeAuthority = z.infer<typeof executionRuntimeAuthoritySchema>;

/**
 * Outcome of a dependency Block as summarized for a downstream envelope.
 * Portable status only; no Host paths or raw result bodies.
 */
export const dependencyOutcomeSchema = z.enum(["completed", "passed", "failed", "skipped"]);

export type DependencyOutcome = z.infer<typeof dependencyOutcomeSchema>;

/**
 * Bounded summary of one upstream Block result needed to execute the target Block.
 */
export const dependencyResultSummarySchema = z
  .object({
    blockRef: blockRefSchema,
    outcome: dependencyOutcomeSchema,
    summary: boundedUtf8String({ minBytes: 1, maxBytes: DEPENDENCY_SUMMARY_MAX_LENGTH }),
    reportArtifactRef: artifactRefSchema.optional()
  })
  .strict();

export type DependencyResultSummary = z.infer<typeof dependencyResultSummarySchema>;

/**
 * Dispatch-scoped, content-addressed input artifact the Host may fetch under its lease.
 * Never a Coordinator absolute path.
 */
export const dispatchInputArtifactSchema = z
  .object({
    artifactRef: artifactRefSchema,
    logicalName: z
      .string()
      .min(1)
      .max(INPUT_ARTIFACT_NAME_MAX_LENGTH)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    mediaType: artifactMediaTypeSchema.optional()
  })
  .strict();

export type DispatchInputArtifact = z.infer<typeof dispatchInputArtifactSchema>;

/**
 * Portable ACP session request.
 * Host maps logical options through local allowlists; no cwd, env, or credentials.
 */
export const requestedAcpSessionConfigSchema = z
  .object({
    modeId: opaqueIdentifierSchema.optional(),
    configOptions: z
      .array(
        z
          .object({
            optionId: opaqueIdentifierSchema,
            valueId: opaqueIdentifierSchema
          })
          .strict()
      )
      .max(SESSION_CONFIG_OPTION_MAX_COUNT)
      .optional()
  })
  .strict();

export type RequestedAcpSessionConfig = z.infer<typeof requestedAcpSessionConfigSchema>;

/**
 * Bounds the Host may produce for report/output artifacts under this dispatch.
 */
export const outputContractSchema = z
  .object({
    reportRequired: z.boolean(),
    maxArtifactBytes: z.number().int().positive().max(OUTPUT_MAX_ARTIFACT_BYTES),
    maxArtifactCount: z.number().int().nonnegative().max(OUTPUT_MAX_ARTIFACT_COUNT)
  })
  .strict();

export type OutputContract = z.infer<typeof outputContractSchema>;

/**
 * Trace correlation identifiers for logs and progress without Host-private paths.
 */
export const traceCorrelationSchema = z
  .object({
    correlationId: opaqueIdentifierSchema,
    parentDispatchId: opaqueIdentifierSchema.optional()
  })
  .strict();

export type TraceCorrelation = z.infer<typeof traceCorrelationSchema>;

/** Exact managed Runtime working-set evidence for Canvas execution. */
export const runtimeMaterializationEvidenceSchema = z
  .object({
    sourceRevision: sourceIdentitySchema,
    graphFingerprint: sourceIdentitySchema
  })
  .strict();

export type RuntimeMaterializationEvidence = z.infer<typeof runtimeMaterializationEvidenceSchema>;

/**
 * Immutable, content-addressed Execution Envelope for one exact Block attempt.
 *
 * Intentionally omits Coordinator absolute paths, executable command/args,
 * arbitrary environment maps, credentials/tokens, Git/worktree/merge policy,
 * and provider-specific secrets. Unknown fields are rejected by `.strict()`.
 */
const executionEnvelopeCommonSchema = z
  .object({
    execution: executionIdentitySchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    taskId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    blockType: z.enum(["implementation", "review"]),
    /** Package or graph revision that produced this rendered envelope. */
    sourceRevision: sourceIdentitySchema,
    /** Optional additional graph fingerprint when distinct from sourceRevision. */
    graphFingerprint: sourceIdentitySchema.optional(),
    /** Exact materialization evidence; present only for managed Canvas Runtime execution. */
    runtimeMaterialization: runtimeMaterializationEvidenceSchema.optional(),
    renderedPrompt: boundedUtf8String({ minBytes: 1, maxBytes: RENDERED_PROMPT_MAX_LENGTH }),
    acceptance: z
      .array(boundedUtf8String({ minBytes: 1, maxBytes: ACCEPTANCE_ITEM_MAX_LENGTH }))
      .max(ACCEPTANCE_MAX_COUNT),
    dependencySummaries: z.array(dependencyResultSummarySchema).max(DEPENDENCY_SUMMARY_MAX_COUNT),
    inputArtifacts: z.array(dispatchInputArtifactSchema).max(INPUT_ARTIFACT_MAX_COUNT),
    /** Logical workspace identity; Host maps via local allowlist. */
    workspaceId: opaqueIdentifierSchema,
    /** Owner Fleet run workspace hint when Host has no collaboration workspace mapping. */
    ownerPackageLocator: ownerPackageLocatorSchema.optional(),
    /** Logical ACP agent/profile identity; Host maps via local allowlist. */
    agentId: opaqueIdentifierSchema,
    agentProfileId: opaqueIdentifierSchema,
    session: requestedAcpSessionConfigSchema,
    requiredCapabilities: capabilitiesSchema,
    output: outputContractSchema,
    trace: traceCorrelationSchema
  })
  .strict();

/** Historical v1 wire shape retained for persisted dispatch replay. */
const executionEnvelopeV1Schema = executionEnvelopeCommonSchema
  .extend({ protocolVersion: z.literal(1) })
  .strict();

/** Current v2 shape with explicit, Server-authorized Runtime scope. */
const executionEnvelopeV2Schema = executionEnvelopeCommonSchema
  .extend({
    protocolVersion: z.literal(executionEnvelopeProtocolVersion),
    /** Host must not infer Runtime authority from workspaceId shape. */
    runtimeAuthority: executionRuntimeAuthoritySchema
  })
  .strict();

export const executionEnvelopeSchema = z
  .discriminatedUnion("protocolVersion", [executionEnvelopeV1Schema, executionEnvelopeV2Schema])
  .superRefine((envelope, context) => {
    const managedCanvasExecution = hasCanvasRuntimeExecutionCapability(
      envelope.requiredCapabilities
    );
    if (managedCanvasExecution !== (envelope.runtimeMaterialization !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["runtimeMaterialization"],
        message: managedCanvasExecution
          ? "Managed Canvas execution requires Runtime materialization evidence."
          : "Runtime materialization evidence is reserved for managed Canvas execution."
      });
    }
    if (!envelope.blockRef.startsWith(`${envelope.taskId}#`)) {
      context.addIssue({
        code: "custom",
        path: ["blockRef"],
        message: "blockRef task segment must match taskId"
      });
    }
    const canonicalBytes = utf8Encoder.encode(canonicalizeJson(envelope)).byteLength;
    if (canonicalBytes > EXECUTION_ENVELOPE_MAX_BYTES) {
      context.addIssue({
        code: "too_big",
        origin: "string",
        maximum: EXECUTION_ENVELOPE_MAX_BYTES,
        inclusive: true,
        path: [],
        message: `Execution Envelope exceeds ${EXECUTION_ENVELOPE_MAX_BYTES} canonical UTF-8 bytes`
      });
    }
  });

/** Shared field schemas for producers that assemble current v2 envelope inputs. */
export const executionEnvelopeFieldSchemas = executionEnvelopeV2Schema.shape;

export type ExecutionEnvelope = z.infer<typeof executionEnvelopeSchema>;
export type ExecutionEnvelopeInput = z.input<typeof executionEnvelopeSchema>;

/**
 * Parse unknown input as a strict Execution Envelope.
 * Rejects unknown fields, over-limit payloads, and incompatible protocol versions.
 */
export function parseExecutionEnvelope(input: unknown): ExecutionEnvelope {
  return executionEnvelopeSchema.parse(input);
}

/**
 * Canonical JSON bytes of a parsed Execution Envelope (UTF-8 of canonicalizeJson).
 */
export function canonicalizeExecutionEnvelope(envelope: ExecutionEnvelope): string {
  return canonicalizeJson(envelope);
}

/**
 * True when a string is a well-formed envelope content digest for the current algorithm.
 */
export function isExecutionEnvelopeDigest(value: string): boolean {
  return executionEnvelopeDigestSchema.safeParse(value).success;
}
