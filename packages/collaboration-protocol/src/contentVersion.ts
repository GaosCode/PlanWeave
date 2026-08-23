import { z } from "zod";
import { canvasRuntimePackageFingerprintSchema } from "./runtimeStatus.js";
import {
  CONTENT_VERSION_MAX_MEMBER_BYTES,
  CONTENT_VERSION_MAX_MEMBERS,
  CONTENT_VERSION_MAX_REASON_LENGTH,
  CONTENT_VERSION_MAX_TOTAL_BYTES
} from "./limits.js";
import {
  actorRefSchema,
  canvasScopeRefSchema,
  contentVersionIdSchema,
  deviceSessionIdSchema,
  opaqueIdentifierSchema,
  timestampSchema
} from "./primitives.js";
import { packageSnapshotDigestSchema } from "./packageSnapshot.js";
import { aclRevisionSchema, canvasVisibilitySchema } from "./projectAccess.js";
export {
  workspaceCanvasPublishLocalSourceSchema,
  type WorkspaceCanvasPublishLocalSource
} from "./workspaceCanvasPublishSource.js";
import { workspaceCanvasPublishLocalSourceSchema } from "./workspaceCanvasPublishSource.js";

/**
 * Server-authoritative immutable content versions. These records deliberately
 * exclude Git refs, runtime state/results, project roots, and cache locations.
 */
export const contentVersionSchemaVersion = "content-version/v1" as const;
export const contentVersionSchemaVersionSchema = z.literal(contentVersionSchemaVersion);
export type ContentVersionSchemaVersion = z.infer<typeof contentVersionSchemaVersionSchema>;

/** Logical member address inside a content version, never a filesystem path. */
export const contentVersionDesktopLayoutMemberPath = "desktop/layout.json" as const;

export const contentVersionMemberPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), "absolute_path_forbidden")
  .refine((value) => !value.includes("\\"), "backslash_path_forbidden")
  .refine((value) => {
    const segments = value.split("/");
    return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
  }, "path_traversal_forbidden")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "invalid_content_version_member_path");
export type ContentVersionMemberPath = z.infer<typeof contentVersionMemberPathSchema>;

export const contentVersionMemberKindSchema = z.enum([
  "manifest",
  "task_prompt",
  "block_prompt",
  "desktop_layout"
]);
export type ContentVersionMemberKind = z.infer<typeof contentVersionMemberKindSchema>;

const taskPromptPathPattern = /^nodes\/[^/]+\/prompt\.md$/;
const blockPromptPathPattern = /^nodes\/[^/]+\/blocks\/[^/]+\.prompt\.md$/;
const textEncoder = new TextEncoder();

export const contentVersionMemberSchema = z
  .object({
    kind: contentVersionMemberKindSchema,
    path: contentVersionMemberPathSchema,
    content: z.string().max(CONTENT_VERSION_MAX_MEMBER_BYTES),
    digestSha256: packageSnapshotDigestSchema,
    sizeBytes: z.number().int().nonnegative().max(CONTENT_VERSION_MAX_MEMBER_BYTES)
  })
  .strict()
  .superRefine((value, context) => {
    const actualSize = textEncoder.encode(value.content).byteLength;
    if (actualSize !== value.sizeBytes) {
      context.addIssue({
        code: "custom",
        message: "content_version_member_size_mismatch",
        path: ["sizeBytes"]
      });
    }
    const pathIsValid =
      (value.kind === "manifest" && value.path === "manifest.json") ||
      (value.kind === "desktop_layout" && value.path === contentVersionDesktopLayoutMemberPath) ||
      (value.kind === "task_prompt" && taskPromptPathPattern.test(value.path)) ||
      (value.kind === "block_prompt" && blockPromptPathPattern.test(value.path));
    if (!pathIsValid) {
      context.addIssue({
        code: "custom",
        message: "content_version_member_kind_path_mismatch",
        path: ["path"]
      });
    }
  });
export type ContentVersionMember = z.infer<typeof contentVersionMemberSchema>;

function expectedMemberKind(path: string): ContentVersionMemberKind | undefined {
  if (path === "manifest.json") return "manifest";
  if (path === contentVersionDesktopLayoutMemberPath) return "desktop_layout";
  if (taskPromptPathPattern.test(path)) return "task_prompt";
  if (blockPromptPathPattern.test(path)) return "block_prompt";
  return undefined;
}

const canonicalContentVersionMemberPathCollator = new Intl.Collator("en-US", {
  usage: "sort",
  sensitivity: "variant",
  numeric: false,
  caseFirst: "false",
  ignorePunctuation: false
});

/** Canonical member-path comparison used when serialising immutable content versions. */
export function compareContentVersionMemberPaths(left: string, right: string): number {
  return canonicalContentVersionMemberPathCollator.compare(left, right);
}

/**
 * Complete, canonical content submitted to Server. Member order is part of the
 * canonical input: lexicographically ordered normalized paths, one manifest,
 * one layout, and only task/block prompts in between.
 */
export const completeContentVersionSchema = z
  .object({
    members: z.array(contentVersionMemberSchema).min(2).max(CONTENT_VERSION_MAX_MEMBERS),
    canonicalDigest: packageSnapshotDigestSchema,
    totalBytes: z.number().int().positive().max(CONTENT_VERSION_MAX_TOTAL_BYTES)
  })
  .strict()
  .superRefine((value, context) => {
    const paths = value.members.map((member) => member.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        message: "duplicate_content_version_member_path",
        path: ["members"]
      });
    }
    for (let index = 0; index < value.members.length; index += 1) {
      const member = value.members[index]!;
      if (index > 0 && compareContentVersionMemberPaths(paths[index - 1]!, member.path) >= 0) {
        context.addIssue({
          code: "custom",
          message: "content_version_members_must_be_canonically_ordered",
          path: ["members", index, "path"]
        });
      }
      if (expectedMemberKind(member.path) !== member.kind) {
        context.addIssue({
          code: "custom",
          message: "content_version_member_kind_path_mismatch",
          path: ["members", index, "kind"]
        });
      }
    }
    if (value.members.filter((member) => member.kind === "manifest").length !== 1) {
      context.addIssue({
        code: "custom",
        message: "content_version_requires_one_manifest",
        path: ["members"]
      });
    }
    if (value.members.filter((member) => member.kind === "desktop_layout").length !== 1) {
      context.addIssue({
        code: "custom",
        message: "content_version_requires_one_desktop_layout",
        path: ["members"]
      });
    }
    const totalBytes = value.members.reduce((sum, member) => sum + member.sizeBytes, 0);
    if (totalBytes !== value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "content_version_total_bytes_mismatch",
        path: ["totalBytes"]
      });
    }
  });
export type CompleteContentVersion = z.infer<typeof completeContentVersionSchema>;

/** Canonical serialisation input for SHA-256. The Server computes and verifies the digest. */
export function canonicalContentVersionDigestPayload(input: CompleteContentVersion): string {
  const parsed = completeContentVersionSchema.parse(input);
  return JSON.stringify({
    members: parsed.members.map(({ kind, path, digestSha256, sizeBytes }) => ({
      kind,
      path,
      digestSha256,
      sizeBytes
    })),
    totalBytes: parsed.totalBytes
  });
}

export const completedContentVersionRefSchema = z
  .object({
    versionId: contentVersionIdSchema,
    canonicalDigest: packageSnapshotDigestSchema,
    verification: z.literal("complete")
  })
  .strict()
  .superRefine((value, context) => {
    if (value.versionId !== `version-${value.canonicalDigest}`) {
      context.addIssue({
        code: "custom",
        message: "content_version_id_must_bind_canonical_digest",
        path: ["versionId"]
      });
    }
  });
export type CompletedContentVersionRef = z.infer<typeof completedContentVersionRefSchema>;

export const authoritativeContentVersionSchema = z
  .object({
    schemaVersion: contentVersionSchemaVersionSchema,
    scope: canvasScopeRefSchema,
    content: completeContentVersionSchema,
    completed: completedContentVersionRefSchema,
    createdAt: timestampSchema,
    createdBy: actorRefSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.content.canonicalDigest !== value.completed.canonicalDigest) {
      context.addIssue({
        code: "custom",
        message: "completed_content_version_digest_mismatch",
        path: ["completed", "canonicalDigest"]
      });
    }
  });
export type AuthoritativeContentVersion = z.infer<typeof authoritativeContentVersionSchema>;

export const contentVersionRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export type ContentVersionRevision = z.infer<typeof contentVersionRevisionSchema>;

export const authoritativeContentHeadSchema = z
  .object({
    schemaVersion: contentVersionSchemaVersionSchema,
    scope: canvasScopeRefSchema,
    revision: contentVersionRevisionSchema,
    content: completedContentVersionRefSchema,
    advancedAt: timestampSchema
  })
  .strict();
export type AuthoritativeContentHead = z.infer<typeof authoritativeContentHeadSchema>;

/** Immutable Server authority that a Runtime Host must materialize before reading Runtime facts. */
export const canvasRuntimeContentTargetSchema = z
  .object({
    revision: contentVersionRevisionSchema,
    content: completedContentVersionRefSchema,
    graphFingerprint: canvasRuntimePackageFingerprintSchema
  })
  .strict();
export type CanvasRuntimeContentTarget = z.infer<typeof canvasRuntimeContentTargetSchema>;

/** Journal records can only point at a completed immutable content object. */
export const contentVersionJournalEntrySchema = z
  .object({
    schemaVersion: contentVersionSchemaVersionSchema,
    scope: canvasScopeRefSchema,
    revision: contentVersionRevisionSchema,
    previousRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    content: completedContentVersionRefSchema,
    acceptedAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.revision !== value.previousRevision + 1) {
      context.addIssue({
        code: "custom",
        message: "content_version_journal_must_be_contiguous",
        path: ["revision"]
      });
    }
  });
export type ContentVersionJournalEntry = z.infer<typeof contentVersionJournalEntrySchema>;

/**
 * Client-generated idempotency key for atomic Workspace canvas creation.
 * Repeat requests with the same identity must not create a second canvas.
 */
export const workspaceCanvasPublishOperationIdSchema = opaqueIdentifierSchema.brand(
  "WorkspaceCanvasPublishOperationId"
);
export type WorkspaceCanvasPublishOperationId = z.infer<
  typeof workspaceCanvasPublishOperationIdSchema
>;

export const workspaceCanvasPublishRecoveryTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type WorkspaceCanvasPublishRecoveryToken = z.infer<
  typeof workspaceCanvasPublishRecoveryTokenSchema
>;

/**
 * Project-scoped atomic initial publish. Server derives workspaceId from auth
 * and assigns the Workspace canvasId. The request never carries
 * connectionProfileId or a client-chosen Server canvasId.
 */
export const workspaceCanvasInitialPublishRequestSchema = z
  .object({
    operationId: workspaceCanvasPublishOperationIdSchema,
    localSource: workspaceCanvasPublishLocalSourceSchema,
    content: completeContentVersionSchema
  })
  .strict();
export type WorkspaceCanvasInitialPublishRequest = z.infer<
  typeof workspaceCanvasInitialPublishRequestSchema
>;

export const workspaceCanvasPublishedAuthoritySchema = z
  .object({
    operationId: workspaceCanvasPublishOperationIdSchema,
    recoveryToken: workspaceCanvasPublishRecoveryTokenSchema,
    scope: canvasScopeRefSchema,
    revision: contentVersionRevisionSchema,
    content: completedContentVersionRefSchema,
    visibility: canvasVisibilitySchema
  })
  .strict();
export type WorkspaceCanvasPublishedAuthority = z.infer<
  typeof workspaceCanvasPublishedAuthoritySchema
>;

export const workspaceCanvasInitialPublishFailureReasonSchema = z.enum([
  "authorization_revoked",
  "content_verification_failed",
  "storage_unavailable",
  "canvas_already_exists",
  "operation_conflict",
  "canvas_publish_incomplete"
]);
export type WorkspaceCanvasInitialPublishFailureReason = z.infer<
  typeof workspaceCanvasInitialPublishFailureReasonSchema
>;

const workspaceCanvasInitialPublishAcceptedSchema = z
  .object({
    operationId: workspaceCanvasPublishOperationIdSchema,
    recoveryToken: workspaceCanvasPublishRecoveryTokenSchema,
    scope: canvasScopeRefSchema,
    revision: contentVersionRevisionSchema,
    content: completedContentVersionRefSchema,
    visibility: canvasVisibilitySchema
  })
  .strict();

export const workspaceCanvasInitialPublishResultSchema = z.discriminatedUnion("outcome", [
  workspaceCanvasInitialPublishAcceptedSchema.extend({
    outcome: z.literal("published")
  }),
  workspaceCanvasInitialPublishAcceptedSchema.extend({
    outcome: z.literal("reused")
  }),
  z
    .object({
      outcome: z.literal("rejected"),
      reason: workspaceCanvasInitialPublishFailureReasonSchema,
      retryable: z.boolean(),
      detail: z.string().trim().min(1).max(CONTENT_VERSION_MAX_REASON_LENGTH),
      scope: z.null(),
      recoveryToken: z.null()
    })
    .strict()
]);
export type WorkspaceCanvasInitialPublishResult = z.infer<
  typeof workspaceCanvasInitialPublishResultSchema
>;

export const contentVersionFetchRequestSchema = z
  .object({
    projectId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    canvasId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    content: completedContentVersionRefSchema
  })
  .strict();
export type ContentVersionFetchRequest = z.infer<typeof contentVersionFetchRequestSchema>;

export const authorizedContentVersionFetchSchema = z
  .object({
    request: contentVersionFetchRequestSchema,
    scope: canvasScopeRefSchema,
    deviceSessionId: deviceSessionIdSchema,
    aclRevision: aclRevisionSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.request.projectId !== value.scope.projectId ||
      value.request.canvasId !== value.scope.canvasId
    ) {
      context.addIssue({
        code: "custom",
        message: "authorized_content_version_fetch_scope_mismatch"
      });
    }
  });
export type AuthorizedContentVersionFetch = z.infer<typeof authorizedContentVersionFetchSchema>;

export const contentVersionMaterializeRequestSchema = z
  .object({
    content: completedContentVersionRefSchema,
    expectedCurrentVersionId: contentVersionIdSchema.nullable()
  })
  .strict();
export type ContentVersionMaterializeRequest = z.infer<
  typeof contentVersionMaterializeRequestSchema
>;

export const contentVersionMaterializeOutcomeSchema = z.enum([
  "materialized",
  "already_materialized",
  "retry_required",
  "rejected"
]);
export type ContentVersionMaterializeOutcome = z.infer<
  typeof contentVersionMaterializeOutcomeSchema
>;

export const contentVersionMaterializeResultSchema = z
  .object({
    outcome: contentVersionMaterializeOutcomeSchema,
    content: completedContentVersionRefSchema,
    retryable: z.boolean(),
    reason: z.string().trim().min(1).max(CONTENT_VERSION_MAX_REASON_LENGTH).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const successful = value.outcome === "materialized" || value.outcome === "already_materialized";
    if (successful && (value.retryable || value.reason !== null)) {
      context.addIssue({
        code: "custom",
        message: "successful_materialization_cannot_have_retry_reason"
      });
    }
    if (!successful && value.reason === null) {
      context.addIssue({
        code: "custom",
        message: "failed_materialization_requires_reason",
        path: ["reason"]
      });
    }
  });
export type ContentVersionMaterializeResult = z.infer<typeof contentVersionMaterializeResultSchema>;
