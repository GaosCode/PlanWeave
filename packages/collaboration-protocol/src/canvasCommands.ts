import { blockRefSchema, opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import {
  CANVAS_COMMAND_LAYOUT_COORDINATE_ABS_MAX,
  CANVAS_COMMAND_MAX_ACCEPTANCE_ITEM_LENGTH,
  CANVAS_COMMAND_MAX_ACCEPTANCE_ITEMS,
  CANVAS_COMMAND_MAX_BLOCK_PROMPT_ENTRIES,
  CANVAS_COMMAND_MAX_BULK_UPDATES,
  CANVAS_COMMAND_MAX_CAPABILITIES,
  CANVAS_COMMAND_MAX_CAPABILITY_LENGTH,
  CANVAS_COMMAND_MAX_DEPENDS_ON,
  CANVAS_COMMAND_MAX_JOURNAL_DELTA_ENTRIES,
  CANVAS_COMMAND_MAX_LAYOUT_NODES,
  CANVAS_COMMAND_MAX_PROMPT_MARKDOWN_CHARS,
  CANVAS_COMMAND_MAX_REASON_LENGTH,
  CANVAS_COMMAND_MAX_SHARED_RESOURCE_LENGTH,
  CANVAS_COMMAND_MAX_SHARED_RESOURCES,
  CANVAS_COMMAND_MAX_TITLE_LENGTH,
  CANVAS_COMMAND_PROTOCOL_VERSION,
  COLLABORATION_REVISION_MAX
} from "./limits.js";
import {
  actorRefSchema,
  canvasScopeRefSchema,
  humanProjectIdSchema,
  packageSnapshotIdSchema,
  timestampSchema
} from "./primitives.js";
import { completedContentVersionRefSchema } from "./contentVersion.js";
import {
  packageSnapshotDigestSchema,
  packageSnapshotDigestManifestSchema
} from "./packageSnapshot.js";

/**
 * Server-authoritative shared Canvas command, journal, snapshot, and reconnect contracts.
 *
 * Presence (see `presence.ts`) is ephemeral and independent: it never carries operationId,
 * revision, journal cursor, or durable mutation intents. Clients submit typed intents only;
 * Server injects actor/authorized scope, orders operations, enforces CAS, and returns outcomes.
 *
 * Fail-closed: unknown command kinds and unknown fields are rejected by `.strict()` schemas.
 * Client input must not include actor, authorization, projectRoot, absolute path, or revision override.
 */

export const canvasCommandProtocolVersionSchema = z.literal(CANVAS_COMMAND_PROTOCOL_VERSION);
export type CanvasCommandProtocolVersion = z.infer<typeof canvasCommandProtocolVersionSchema>;

export const canvasCommandSchemaVersion = "canvas-command/v1" as const;
export const canvasCommandSchemaVersionSchema = z.literal(canvasCommandSchemaVersion);
export type CanvasCommandSchemaVersion = z.infer<typeof canvasCommandSchemaVersionSchema>;

export const canvasJournalSchemaVersion = "canvas-journal/v1" as const;
export const canvasJournalSchemaVersionSchema = z.literal(canvasJournalSchemaVersion);

/**
 * v2 replaces the inline baseline with an immutable content-version reference.
 * A v1 snapshot must be rejected rather than being interpreted as a v2 baseline.
 */
export const canvasSnapshotSchemaVersion = "canvas-snapshot/v2" as const;
export const canvasSnapshotSchemaVersionSchema = z.literal(canvasSnapshotSchemaVersion);

/**
 * Client-generated idempotency key. Exact replay is guaranteed only while the operation remains
 * in the Server's per-scope terminal receipt window.
 */
export const canvasCommandOperationIdSchema = opaqueIdentifierSchema.brand(
  "CanvasCommandOperationId"
);
export type CanvasCommandOperationId = z.infer<typeof canvasCommandOperationIdSchema>;

export const canvasJournalEntryIdSchema = opaqueIdentifierSchema.brand("CanvasJournalEntryId");
export type CanvasJournalEntryId = z.infer<typeof canvasJournalEntryIdSchema>;

/** Monotonic CAS counter for one project/canvas durable graph state. 0 means empty/initial. */
export const canvasRevisionSchema = z.number().int().nonnegative().max(COLLABORATION_REVISION_MAX);
export type CanvasRevision = z.infer<typeof canvasRevisionSchema>;

/** Stored revisions after the first accepted mutation are always >= 1. */
export const canvasStoredRevisionSchema = canvasRevisionSchema.min(1);
export type CanvasStoredRevision = z.infer<typeof canvasStoredRevisionSchema>;

export const canvasContentDigestSchema = packageSnapshotDigestSchema;
export type CanvasContentDigest = z.infer<typeof canvasContentDigestSchema>;

const canvasIdSchema = opaqueIdentifierSchema;
const taskIdSchema = opaqueIdentifierSchema;
const blockIdSchema = opaqueIdentifierSchema;

const canvasPromptMarkdownSchema = z.string().min(1).max(CANVAS_COMMAND_MAX_PROMPT_MARKDOWN_CHARS);

const canvasTitleSchema = z.string().trim().min(1).max(CANVAS_COMMAND_MAX_TITLE_LENGTH);

const canvasAcceptanceItemsSchema = z
  .array(z.string().trim().min(1).max(CANVAS_COMMAND_MAX_ACCEPTANCE_ITEM_LENGTH))
  .max(CANVAS_COMMAND_MAX_ACCEPTANCE_ITEMS);

const canvasDependsOnIdsSchema = z.array(blockIdSchema).max(CANVAS_COMMAND_MAX_DEPENDS_ON);

const canvasSharedResourcesSchema = z
  .array(z.string().trim().min(1).max(CANVAS_COMMAND_MAX_SHARED_RESOURCE_LENGTH))
  .max(CANVAS_COMMAND_MAX_SHARED_RESOURCES);

const canvasCapabilitiesSchema = z
  .array(z.string().trim().min(1).max(CANVAS_COMMAND_MAX_CAPABILITY_LENGTH))
  .max(CANVAS_COMMAND_MAX_CAPABILITIES);

const layoutCoordinateSchema = z
  .number()
  .finite()
  .min(-CANVAS_COMMAND_LAYOUT_COORDINATE_ABS_MAX)
  .max(CANVAS_COMMAND_LAYOUT_COORDINATE_ABS_MAX);

export const canvasLayoutNodeSchema = z
  .object({
    nodeId: opaqueIdentifierSchema,
    x: layoutCoordinateSchema,
    y: layoutCoordinateSchema
  })
  .strict();
export type CanvasLayoutNode = z.infer<typeof canvasLayoutNodeSchema>;

export const canvasLayoutNodesSchema = z
  .array(canvasLayoutNodeSchema)
  .min(1)
  .max(CANVAS_COMMAND_MAX_LAYOUT_NODES)
  .superRefine((nodes, context) => {
    const ids = nodes.map((node) => node.nodeId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "layout node ids must be unique", path: [] });
    }
  });

/** Routing scope only. Client never supplies workspaceId or actor. */
export const canvasCommandClientScopeSchema = z
  .object({
    projectId: humanProjectIdSchema,
    canvasId: canvasIdSchema
  })
  .strict();
export type CanvasCommandClientScope = z.infer<typeof canvasCommandClientScopeSchema>;

/** Server-authorized scope after ACL; always includes workspaceId. */
export const canvasCommandAuthorizedScopeSchema = canvasScopeRefSchema;
export type CanvasCommandAuthorizedScope = z.infer<typeof canvasCommandAuthorizedScopeSchema>;

const taskFieldPatchSchema = z
  .object({
    title: canvasTitleSchema.optional(),
    promptMarkdown: canvasPromptMarkdownSchema.optional(),
    executor: z.union([opaqueIdentifierSchema, z.null()]).optional(),
    acceptance: canvasAcceptanceItemsSchema.optional(),
    baseContentDigest: canvasContentDigestSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.title === undefined &&
      value.promptMarkdown === undefined &&
      value.executor === undefined &&
      value.acceptance === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "task field patch requires at least one mutable field"
      });
    }
  });

const blockFieldPatchSchema = z
  .object({
    title: canvasTitleSchema.optional(),
    promptMarkdown: canvasPromptMarkdownSchema.optional(),
    executor: z.union([opaqueIdentifierSchema, z.null()]).optional(),
    dependsOn: canvasDependsOnIdsSchema.optional(),
    sharedResources: canvasSharedResourcesSchema.optional(),
    requiredCapabilities: canvasCapabilitiesSchema.optional(),
    reviewRequired: z.boolean().optional(),
    maxFeedbackCycles: z.number().int().nonnegative().max(100).optional(),
    baseContentDigest: canvasContentDigestSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.title === undefined &&
      value.promptMarkdown === undefined &&
      value.executor === undefined &&
      value.dependsOn === undefined &&
      value.sharedResources === undefined &&
      value.requiredCapabilities === undefined &&
      value.reviewRequired === undefined &&
      value.maxFeedbackCycles === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "block field patch requires at least one mutable field"
      });
    }
  });

const blockPromptEntrySchema = z
  .object({
    blockId: blockIdSchema,
    markdown: canvasPromptMarkdownSchema
  })
  .strict();

/**
 * Closed set of durable Canvas mutation intents.
 * Runtime adapts these into Plan Package graph mutations after Server acceptance.
 * Forbidden: free-form filesystem paths, projectRoot, auth blobs, actor, revision override.
 */
const canvasCommandIntentUnionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("add_task"),
      taskId: taskIdSchema,
      title: canvasTitleSchema,
      promptMarkdown: canvasPromptMarkdownSchema,
      acceptance: canvasAcceptanceItemsSchema.optional(),
      executor: opaqueIdentifierSchema.optional(),
      blockPrompts: z
        .array(blockPromptEntrySchema)
        .max(CANVAS_COMMAND_MAX_BLOCK_PROMPT_ENTRIES)
        .optional(),
      layout: canvasLayoutNodeSchema.optional(),
      layoutUpdatedAt: timestampSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove_task"),
      taskId: taskIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_task_fields"),
      taskId: taskIdSchema,
      fields: taskFieldPatchSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_task_prompt"),
      taskId: taskIdSchema,
      promptMarkdown: canvasPromptMarkdownSchema,
      baseContentDigest: canvasContentDigestSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("add_block"),
      taskId: taskIdSchema,
      blockId: blockIdSchema,
      blockType: z.enum(["implementation", "review"]),
      title: canvasTitleSchema,
      promptMarkdown: canvasPromptMarkdownSchema,
      dependsOn: canvasDependsOnIdsSchema.optional(),
      executor: opaqueIdentifierSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove_block"),
      blockRef: blockRefSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_block_fields"),
      blockRef: blockRefSchema,
      fields: blockFieldPatchSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_block_prompt"),
      blockRef: blockRefSchema,
      promptMarkdown: canvasPromptMarkdownSchema,
      baseContentDigest: canvasContentDigestSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("add_task_dependency"),
      fromTaskId: taskIdSchema,
      toTaskId: taskIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove_task_dependency"),
      fromTaskId: taskIdSchema,
      toTaskId: taskIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("reconnect_task_dependency"),
      fromTaskId: taskIdSchema,
      oldToTaskId: taskIdSchema,
      newFromTaskId: taskIdSchema.optional(),
      newToTaskId: taskIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_layout"),
      nodes: canvasLayoutNodesSchema,
      updatedAt: timestampSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("bulk_update_blocks"),
      updates: z
        .array(
          z
            .object({
              blockRef: blockRefSchema,
              fields: blockFieldPatchSchema
            })
            .strict()
        )
        .min(1)
        .max(CANVAS_COMMAND_MAX_BULK_UPDATES)
    })
    .strict()
]);

export const canvasCommandIntentSchema = canvasCommandIntentUnionSchema.superRefine(
  (value, context) => {
    if (value.kind === "add_task_dependency" && value.fromTaskId === value.toTaskId) {
      context.addIssue({
        code: "custom",
        message: "task dependency endpoints must differ",
        path: ["toTaskId"]
      });
    }
  }
);
export type CanvasCommandIntent = z.infer<typeof canvasCommandIntentSchema>;

/** New submissions must make layout metadata deterministic across materializers. */
export const canvasCommandSubmissionIntentSchema = canvasCommandIntentSchema.superRefine(
  (value, context) => {
    if (value.kind === "update_layout" && value.updatedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "update_layout requires updatedAt",
        path: ["updatedAt"]
      });
    }
    if (
      value.kind === "add_task" &&
      value.layout !== undefined &&
      value.layoutUpdatedAt === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "add_task with layout requires layoutUpdatedAt",
        path: ["layoutUpdatedAt"]
      });
    }
  }
);

/**
 * Client submit envelope. Excludes actor, authorization, projectRoot, absolute path,
 * and authoritative revision override (only expectedRevision for CAS is allowed).
 */
export const canvasCommandSubmitSchema = z
  .object({
    type: z.literal("canvas.command.submit"),
    protocolVersion: canvasCommandProtocolVersionSchema,
    schemaVersion: canvasCommandSchemaVersionSchema,
    projectId: humanProjectIdSchema,
    canvasId: canvasIdSchema,
    operationId: canvasCommandOperationIdSchema,
    expectedRevision: canvasRevisionSchema,
    intent: canvasCommandSubmissionIntentSchema
  })
  .strict();
export type CanvasCommandSubmit = z.infer<typeof canvasCommandSubmitSchema>;

/**
 * Server-internal authorized command after ACL + identity injection.
 * Never accepted from Desktop wire parsers; produced only by Server ingress.
 */
export const canvasCommandAuthorizedSchema = z
  .object({
    type: z.literal("canvas.command.authorized"),
    protocolVersion: canvasCommandProtocolVersionSchema,
    schemaVersion: canvasCommandSchemaVersionSchema,
    scope: canvasCommandAuthorizedScopeSchema,
    operationId: canvasCommandOperationIdSchema,
    expectedRevision: canvasRevisionSchema,
    intent: canvasCommandIntentSchema,
    actor: actorRefSchema,
    authorizedAt: timestampSchema
  })
  .strict();
export type CanvasCommandAuthorized = z.infer<typeof canvasCommandAuthorizedSchema>;

export const canvasCommandRejectCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "unknown_canvas",
  "cross_scope",
  "unsupported_version",
  "invalid_command",
  "unknown_command",
  "stale_revision",
  "operation_conflict",
  "payload_too_large",
  "rate_limited",
  "journal_unavailable",
  "snapshot_malformed",
  "server_error"
]);
export type CanvasCommandRejectCode = z.infer<typeof canvasCommandRejectCodeSchema>;

/** CAS conflict details when expectedRevision does not match authoritative head. */
export const canvasCommandCasConflictSchema = z
  .object({
    expectedRevision: canvasRevisionSchema,
    authoritativeRevision: canvasRevisionSchema,
    authoritativeContentDigest: canvasContentDigestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expectedRevision === value.authoritativeRevision) {
      context.addIssue({
        code: "custom",
        message: "CAS conflict requires expectedRevision != authoritativeRevision",
        path: ["authoritativeRevision"]
      });
    }
  });
export type CanvasCommandCasConflict = z.infer<typeof canvasCommandCasConflictSchema>;

const canvasCommandAcceptedObjectSchema = z
  .object({
    type: z.literal("canvas.command.accepted"),
    protocolVersion: canvasCommandProtocolVersionSchema,
    schemaVersion: canvasCommandSchemaVersionSchema,
    scope: canvasCommandAuthorizedScopeSchema,
    operationId: canvasCommandOperationIdSchema,
    /** Authoritative revision after this operation (same pair on pure idempotent replay). */
    revision: canvasStoredRevisionSchema,
    previousRevision: canvasRevisionSchema,
    contentDigest: canvasContentDigestSchema,
    journalEntryId: canvasJournalEntryIdSchema,
    actor: actorRefSchema,
    acceptedAt: timestampSchema,
    /** True when Server returned the prior outcome for a duplicate identical operationId. */
    idempotentReplay: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.revision !== value.previousRevision + 1) {
      context.addIssue({
        code: "custom",
        message: "accepted revision must equal previousRevision + 1",
        path: ["revision"]
      });
    }
  });
export const canvasCommandAcceptedSchema = canvasCommandAcceptedObjectSchema;
export type CanvasCommandAccepted = z.infer<typeof canvasCommandAcceptedSchema>;

export const canvasCommandRejectedSchema = z
  .object({
    type: z.literal("canvas.command.rejected"),
    protocolVersion: canvasCommandProtocolVersionSchema,
    schemaVersion: canvasCommandSchemaVersionSchema,
    projectId: humanProjectIdSchema,
    canvasId: canvasIdSchema,
    operationId: canvasCommandOperationIdSchema,
    code: canvasCommandRejectCodeSchema,
    /** Present only for stale_revision CAS failures. */
    conflict: canvasCommandCasConflictSchema.optional(),
    /** Optional bounded diagnostic; never tokens, secrets, or absolute paths. */
    detail: z.string().trim().min(1).max(CANVAS_COMMAND_MAX_REASON_LENGTH).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.code === "stale_revision" && value.conflict === undefined) {
      context.addIssue({
        code: "custom",
        message: "stale_revision requires conflict details",
        path: ["conflict"]
      });
    }
    if (value.code !== "stale_revision" && value.conflict !== undefined) {
      context.addIssue({
        code: "custom",
        message: "conflict details are only valid for stale_revision",
        path: ["conflict"]
      });
    }
  });
export type CanvasCommandRejected = z.infer<typeof canvasCommandRejectedSchema>;

export const canvasCommandOutcomeSchema = z.union([
  canvasCommandAcceptedSchema,
  canvasCommandRejectedSchema
]);
export type CanvasCommandOutcome = z.infer<typeof canvasCommandOutcomeSchema>;

/**
 * Append-only journal entry for one accepted mutation.
 * Ordering key is `revision` (monotone per project/canvas). Presence updates never appear here.
 */
export const canvasJournalEntrySchema = z
  .object({
    schemaVersion: canvasJournalSchemaVersionSchema,
    entryId: canvasJournalEntryIdSchema,
    scope: canvasCommandAuthorizedScopeSchema,
    revision: canvasStoredRevisionSchema,
    previousRevision: canvasRevisionSchema,
    operationId: canvasCommandOperationIdSchema,
    intent: canvasCommandIntentSchema,
    /** SHA-256 over the canonical intent payload for integrity checks without re-serializing ambiguity. */
    intentDigest: canvasContentDigestSchema,
    contentDigest: canvasContentDigestSchema,
    actor: actorRefSchema,
    acceptedAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.revision !== value.previousRevision + 1) {
      context.addIssue({
        code: "custom",
        message: "journal revision must be previousRevision + 1",
        path: ["revision"]
      });
    }
  });
export type CanvasJournalEntry = z.infer<typeof canvasJournalEntrySchema>;

/**
 * Snapshot metadata for the current authoritative canvas head.
 */
export const canvasSnapshotMetadataSchema = z
  .object({
    schemaVersion: canvasSnapshotSchemaVersionSchema,
    scope: canvasCommandAuthorizedScopeSchema,
    revision: canvasRevisionSchema,
    contentDigest: canvasContentDigestSchema,
    createdAt: timestampSchema,
    /** Optional link to package snapshot registry entry when content is materialised there. */
    packageSnapshotId: packageSnapshotIdSchema.optional(),
    /** Bounded digest manifest; never embeds raw prompt bodies on the wire. */
    digestManifest: packageSnapshotDigestManifestSchema.optional(),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024 * 1_024)
      .optional()
  })
  .strict();
export type CanvasSnapshotMetadata = z.infer<typeof canvasSnapshotMetadataSchema>;

/**
 * Full canonical baseline for reconnect when the journal cannot satisfy a delta.
 * Clients fetch the immutable `content` reference through the content authority before
 * establishing their replica. Snapshot responses deliberately never carry content bodies.
 */
export const canvasSnapshotContentSchema = z
  .object({
    metadata: canvasSnapshotMetadataSchema,
    encoding: z.literal("content_version_ref"),
    content: completedContentVersionRefSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.content.canonicalDigest !== value.metadata.contentDigest) {
      context.addIssue({
        code: "custom",
        message: "snapshot_content_digest_mismatch",
        path: ["content", "canonicalDigest"]
      });
    }
  });
export type CanvasSnapshotContent = z.infer<typeof canvasSnapshotContentSchema>;

export const canvasReconnectRequestSchema = z
  .object({
    type: z.literal("canvas.reconnect.request"),
    protocolVersion: canvasCommandProtocolVersionSchema,
    schemaVersion: canvasCommandSchemaVersionSchema,
    projectId: humanProjectIdSchema,
    canvasId: canvasIdSchema,
    /** Last authoritative revision the client has fully applied (0 = none). */
    afterRevision: canvasRevisionSchema,
    /** Optional integrity check against the client's last applied head. */
    afterContentDigest: canvasContentDigestSchema.optional()
  })
  .strict();
export type CanvasReconnectRequest = z.infer<typeof canvasReconnectRequestSchema>;

export const canvasReconnectDeltaSchema = z
  .object({
    type: z.literal("canvas.reconnect.delta"),
    protocolVersion: canvasCommandProtocolVersionSchema,
    schemaVersion: canvasCommandSchemaVersionSchema,
    scope: canvasCommandAuthorizedScopeSchema,
    afterRevision: canvasRevisionSchema,
    headRevision: canvasRevisionSchema,
    headContentDigest: canvasContentDigestSchema,
    entries: z.array(canvasJournalEntrySchema).max(CANVAS_COMMAND_MAX_JOURNAL_DELTA_ENTRIES)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.headRevision < value.afterRevision) {
      context.addIssue({
        code: "custom",
        message: "headRevision must be >= afterRevision",
        path: ["headRevision"]
      });
    }
    if (value.entries.length === 0 && value.headRevision !== value.afterRevision) {
      context.addIssue({
        code: "custom",
        message: "empty delta requires headRevision === afterRevision",
        path: ["entries"]
      });
    }
    let expectedPrevious = value.afterRevision;
    for (let index = 0; index < value.entries.length; index += 1) {
      const entry = value.entries[index]!;
      if (entry.previousRevision !== expectedPrevious) {
        context.addIssue({
          code: "custom",
          message: "journal delta entries must form a contiguous chain",
          path: ["entries", index, "previousRevision"]
        });
        break;
      }
      expectedPrevious = entry.revision;
    }
    if (value.entries.length > 0) {
      const last = value.entries[value.entries.length - 1]!;
      if (last.revision !== value.headRevision) {
        context.addIssue({
          code: "custom",
          message: "last delta entry revision must equal headRevision",
          path: ["headRevision"]
        });
      }
      if (last.contentDigest !== value.headContentDigest) {
        context.addIssue({
          code: "custom",
          message: "last delta entry contentDigest must equal headContentDigest",
          path: ["headContentDigest"]
        });
      }
    }
  });
export type CanvasReconnectDelta = z.infer<typeof canvasReconnectDeltaSchema>;

export const canvasReconnectSnapshotReasonSchema = z.enum([
  "retention_gap",
  "revision_ahead",
  "digest_mismatch",
  "fresh_session",
  "truncated_journal"
]);
export type CanvasReconnectSnapshotReason = z.infer<typeof canvasReconnectSnapshotReasonSchema>;

export const canvasReconnectSnapshotSchema = z
  .object({
    type: z.literal("canvas.reconnect.snapshot"),
    protocolVersion: canvasCommandProtocolVersionSchema,
    schemaVersion: canvasCommandSchemaVersionSchema,
    scope: canvasCommandAuthorizedScopeSchema,
    reason: canvasReconnectSnapshotReasonSchema,
    afterRevision: canvasRevisionSchema,
    snapshot: canvasSnapshotContentSchema
  })
  .strict();
export type CanvasReconnectSnapshot = z.infer<typeof canvasReconnectSnapshotSchema>;

export const canvasReconnectErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "unknown_canvas",
  "cross_scope",
  "unsupported_version",
  "invalid_request",
  "snapshot_malformed",
  "server_error"
]);
export type CanvasReconnectErrorCode = z.infer<typeof canvasReconnectErrorCodeSchema>;

export const canvasReconnectErrorSchema = z
  .object({
    type: z.literal("canvas.reconnect.error"),
    protocolVersion: canvasCommandProtocolVersionSchema,
    schemaVersion: canvasCommandSchemaVersionSchema,
    projectId: humanProjectIdSchema,
    canvasId: canvasIdSchema,
    code: canvasReconnectErrorCodeSchema,
    detail: z.string().trim().min(1).max(CANVAS_COMMAND_MAX_REASON_LENGTH).optional()
  })
  .strict();
export type CanvasReconnectError = z.infer<typeof canvasReconnectErrorSchema>;

export const canvasReconnectResponseSchema = z.discriminatedUnion("type", [
  canvasReconnectDeltaSchema,
  canvasReconnectSnapshotSchema,
  canvasReconnectErrorSchema
]);
export type CanvasReconnectResponse = z.infer<typeof canvasReconnectResponseSchema>;

export const canvasCommandClientMessageSchema = z.discriminatedUnion("type", [
  canvasCommandSubmitSchema,
  canvasReconnectRequestSchema
]);
export type CanvasCommandClientMessage = z.infer<typeof canvasCommandClientMessageSchema>;

/** Server messages use a union so refined accepted/delta schemas remain fail-closed. */
export const canvasCommandServerMessageSchema = z.union([
  canvasCommandAcceptedSchema,
  canvasCommandRejectedSchema,
  canvasReconnectDeltaSchema,
  canvasReconnectSnapshotSchema,
  canvasReconnectErrorSchema
]);
export type CanvasCommandServerMessage = z.infer<typeof canvasCommandServerMessageSchema>;

export function parseCanvasCommandSubmit(input: unknown): CanvasCommandSubmit {
  return canvasCommandSubmitSchema.parse(input);
}

export function parseCanvasCommandOutcome(input: unknown): CanvasCommandOutcome {
  return canvasCommandOutcomeSchema.parse(input);
}

export function parseCanvasReconnectRequest(input: unknown): CanvasReconnectRequest {
  return canvasReconnectRequestSchema.parse(input);
}

export function parseCanvasReconnectResponse(input: unknown): CanvasReconnectResponse {
  return canvasReconnectResponseSchema.parse(input);
}

export function parseCanvasJournalEntry(input: unknown): CanvasJournalEntry {
  return canvasJournalEntrySchema.parse(input);
}

/**
 * Idempotency decision surface for Server (documented in contracts; applied in B-002).
 * Within the bounded terminal receipt window:
 * - identical operationId + intent → replay the prior terminal outcome
 * - same operationId + different intent → reject with operation_conflict
 *
 * Once an older receipt is evicted, that operationId is unseen and runs authorization, CAS, and
 * content validation again; if still valid, the intent may be applied again.
 */
export const canvasCommandIdempotencyDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("apply"),
      operationId: canvasCommandOperationIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("replay"),
      operationId: canvasCommandOperationIdSchema,
      outcome: canvasCommandAcceptedSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("conflict"),
      operationId: canvasCommandOperationIdSchema,
      code: z.literal("operation_conflict")
    })
    .strict()
]);
export type CanvasCommandIdempotencyDecision = z.infer<
  typeof canvasCommandIdempotencyDecisionSchema
>;
