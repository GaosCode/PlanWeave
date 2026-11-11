import { z } from "zod";
import {
  PACKAGE_SNAPSHOT_MAX_FILE_BYTES,
  PACKAGE_SNAPSHOT_MAX_PATH_LENGTH,
  PACKAGE_SNAPSHOT_MAX_PROMPT_DIGESTS,
  PACKAGE_SNAPSHOT_MAX_RETAINED,
  PACKAGE_SNAPSHOT_MAX_SOURCE_REVISION_LENGTH,
  PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES
} from "./limits.js";
import {
  actorRefSchema,
  canvasRegistryIdSchema,
  canvasScopeRefSchema,
  packageSnapshotIdSchema,
  projectRegistryIdSchema,
  timestampSchema,
  workspaceIdSchema
} from "./primitives.js";
import { canvasVisibilitySchema, projectVisibilitySchema } from "./projectAccess.js";
import {
  hasPortablePackageFileSegmentLengths,
  packageFileNamespaceConflict
} from "./packageFileNamespace.js";

export const packageSnapshotSchemaVersion = "package-snapshot/v1" as const;
export const packageSnapshotSchemaVersionSchema = z.literal(packageSnapshotSchemaVersion);
export type PackageSnapshotSchemaVersion = z.infer<typeof packageSnapshotSchemaVersionSchema>;

export const packageSnapshotMigrationSchemaVersion = "package-snapshot-migration/v1" as const;
export const packageSnapshotMigrationSchemaVersionSchema = z.literal(
  packageSnapshotMigrationSchemaVersion
);

export const packageSnapshotMigrationMarkerSchema = z.enum([
  "none",
  "legacy_package_mapped",
  "canvas_registry_created",
  "snapshot_registered",
  "digest_verified",
  "migration_failed"
]);
export type PackageSnapshotMigrationMarker = z.infer<typeof packageSnapshotMigrationMarkerSchema>;

export const packageSnapshotStateSchema = z.enum([
  "available",
  "missing",
  "revoked",
  "stale",
  "malformed"
]);
export type PackageSnapshotState = z.infer<typeof packageSnapshotStateSchema>;

export const packageSnapshotRestoreMarkerSchema = z.enum([
  "none",
  "restore_pending",
  "restore_complete"
]);
export type PackageSnapshotRestoreMarker = z.infer<typeof packageSnapshotRestoreMarkerSchema>;

export const packageSnapshotSourceRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(PACKAGE_SNAPSHOT_MAX_SOURCE_REVISION_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type PackageSnapshotSourceRevision = z.infer<typeof packageSnapshotSourceRevisionSchema>;

export const packageSnapshotDigestSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);
export type PackageSnapshotDigest = z.infer<typeof packageSnapshotDigestSchema>;

export const packageSnapshotRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(PACKAGE_SNAPSHOT_MAX_PATH_LENGTH)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), "absolute_path_forbidden")
  .refine((value) => !value.includes("\\"), "backslash_path_forbidden")
  .refine((value) => {
    const segments = value.split("/");
    return !segments.some((part) => part === ".." || part === "." || part.length === 0);
  }, "path_traversal_forbidden")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "invalid_package_relative_path")
  .refine(hasPortablePackageFileSegmentLengths, "package_path_segment_too_long");
export type PackageSnapshotRelativePath = z.infer<typeof packageSnapshotRelativePathSchema>;

export const packageSnapshotSizeSchema = z
  .number()
  .int()
  .nonnegative()
  .max(PACKAGE_SNAPSHOT_MAX_FILE_BYTES);
export type PackageSnapshotSize = z.infer<typeof packageSnapshotSizeSchema>;

export const packageSnapshotDigestMetadataSchema = z
  .object({
    digestSha256: packageSnapshotDigestSchema,
    sizeBytes: packageSnapshotSizeSchema
  })
  .strict();
export type PackageSnapshotDigestMetadata = z.infer<typeof packageSnapshotDigestMetadataSchema>;

export const packageSnapshotPromptDigestSchema = z
  .object({
    path: packageSnapshotRelativePathSchema,
    digest: packageSnapshotDigestMetadataSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.path.endsWith(".md")) {
      ctx.addIssue({
        code: "custom",
        message: "prompt_digest_requires_markdown_path",
        path: ["path"]
      });
    }
  });
export type PackageSnapshotPromptDigest = z.infer<typeof packageSnapshotPromptDigestSchema>;

/** Manifest and prompt content are represented by bounded digests, never raw package content. */
export const packageSnapshotDigestManifestSchema = z
  .object({
    manifest: packageSnapshotDigestMetadataSchema,
    prompts: z.array(packageSnapshotPromptDigestSchema).max(PACKAGE_SNAPSHOT_MAX_PROMPT_DIGESTS),
    totalBytes: z.number().int().nonnegative().max(PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES)
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = value.prompts.map((prompt) => prompt.path);
    const namespaceConflict = packageFileNamespaceConflict(["manifest.json", ...paths]);
    if (namespaceConflict) {
      ctx.addIssue({ code: "custom", message: namespaceConflict, path: ["prompts"] });
    }
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({ code: "custom", message: "duplicate_prompt_digest_path", path: ["prompts"] });
    }
    const calculatedMinimum =
      value.manifest.sizeBytes +
      value.prompts.reduce((sum, prompt) => sum + prompt.digest.sizeBytes, 0);
    if (value.totalBytes < calculatedMinimum) {
      ctx.addIssue({
        code: "custom",
        message: "snapshot_total_bytes_understated",
        path: ["totalBytes"]
      });
    }
  });
export type PackageSnapshotDigestManifest = z.infer<typeof packageSnapshotDigestManifestSchema>;

export const packageSnapshotRegistryRefSchema = z
  .object({
    projectRegistryId: projectRegistryIdSchema,
    canvasRegistryId: canvasRegistryIdSchema,
    workspaceId: workspaceIdSchema,
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
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  })
  .strict();
export type PackageSnapshotRegistryRef = z.infer<typeof packageSnapshotRegistryRefSchema>;

export const packageSnapshotImmutableMetadataSchema = z
  .object({
    snapshotId: packageSnapshotIdSchema,
    registry: packageSnapshotRegistryRefSchema,
    sourceRevision: packageSnapshotSourceRevisionSchema,
    createdAt: timestampSchema,
    creator: actorRefSchema,
    digestManifest: packageSnapshotDigestManifestSchema,
    migrationMarker: packageSnapshotMigrationMarkerSchema
  })
  .strict();
export type PackageSnapshotImmutableMetadata = z.infer<
  typeof packageSnapshotImmutableMetadataSchema
>;

export const packageSnapshotMutableMetadataSchema = z
  .object({
    state: packageSnapshotStateSchema,
    aclRevision: z.number().int().nonnegative(),
    visibility: z
      .object({ project: projectVisibilitySchema, canvas: canvasVisibilitySchema })
      .strict(),
    updatedAt: timestampSchema,
    revokedAt: timestampSchema.nullable(),
    retentionOrder: z.number().int().positive().max(PACKAGE_SNAPSHOT_MAX_RETAINED).nullable(),
    restoreMarker: packageSnapshotRestoreMarkerSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "revoked" && value.revokedAt === null) {
      ctx.addIssue({
        code: "custom",
        message: "revoked_snapshot_requires_revoked_at",
        path: ["revokedAt"]
      });
    }
    if (value.state !== "revoked" && value.revokedAt !== null) {
      ctx.addIssue({
        code: "custom",
        message: "non_revoked_snapshot_cannot_have_revoked_at",
        path: ["revokedAt"]
      });
    }
  });
export type PackageSnapshotMutableMetadata = z.infer<typeof packageSnapshotMutableMetadataSchema>;

export const packageSnapshotSchema = z
  .object({
    schemaVersion: packageSnapshotSchemaVersionSchema,
    immutable: packageSnapshotImmutableMetadataSchema,
    mutable: packageSnapshotMutableMetadataSchema
  })
  .strict();
export type PackageSnapshot = z.infer<typeof packageSnapshotSchema>;

/** Client requests identify a registered canvas/snapshot only; actor/scope are Server-injected. */
export const restorePackageSnapshotRequestSchema = z
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
    snapshotId: packageSnapshotIdSchema,
    expectedAclRevision: z.number().int().nonnegative()
  })
  .strict();
export type RestorePackageSnapshotRequest = z.infer<typeof restorePackageSnapshotRequestSchema>;

export const createPackageSnapshotRequestSchema = z
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
    expectedAclRevision: z.number().int().nonnegative()
  })
  .strict();
export type CreatePackageSnapshotRequest = z.infer<typeof createPackageSnapshotRequestSchema>;

export const createPackageSnapshotResultSchema = z
  .object({
    snapshot: packageSnapshotSchema,
    actor: actorRefSchema,
    scope: canvasScopeRefSchema
  })
  .strict();
export type CreatePackageSnapshotResult = z.infer<typeof createPackageSnapshotResultSchema>;

export const restoreOutcomeSchema = z.enum([
  "restored",
  "noop",
  "missing",
  "revoked",
  "stale",
  "malformed",
  "conflict"
]);
export type RestoreOutcome = z.infer<typeof restoreOutcomeSchema>;

export const restorePackageSnapshotResultSchema = z
  .object({
    schemaVersion: packageSnapshotSchemaVersionSchema,
    outcome: restoreOutcomeSchema,
    snapshotId: packageSnapshotIdSchema,
    scope: canvasScopeRefSchema,
    actor: actorRefSchema,
    aclRevision: z.number().int().nonnegative(),
    migrationMarker: packageSnapshotMigrationMarkerSchema,
    sourceRevision: packageSnapshotSourceRevisionSchema.nullable(),
    restoredAt: timestampSchema.nullable(),
    detail: z.string().trim().min(1).max(256).nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    const successful = value.outcome === "restored" || value.outcome === "noop";
    if (successful && value.sourceRevision === null) {
      ctx.addIssue({
        code: "custom",
        message: "successful_restore_requires_source_revision",
        path: ["sourceRevision"]
      });
    }
    if (value.outcome === "restored" && value.restoredAt === null) {
      ctx.addIssue({
        code: "custom",
        message: "restored_outcome_requires_timestamp",
        path: ["restoredAt"]
      });
    }
    if (value.outcome !== "restored" && value.restoredAt !== null) {
      ctx.addIssue({
        code: "custom",
        message: "non_restored_outcome_cannot_have_timestamp",
        path: ["restoredAt"]
      });
    }
  });
export type RestorePackageSnapshotResult = z.infer<typeof restorePackageSnapshotResultSchema>;
