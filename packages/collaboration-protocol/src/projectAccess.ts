import { z } from "zod";
import {
  PROJECT_ACCESS_MAX_CANVASES_PER_PAGE,
  PROJECT_ACCESS_MAX_GRANTS,
  PROJECT_ACCESS_MAX_PROJECTS_PER_PAGE
} from "./limits.js";
import {
  actorRefSchema,
  canvasRegistryIdSchema,
  canvasScopeRefSchema,
  humanPrincipalIdSchema,
  packageSnapshotIdSchema,
  membershipGrantIdSchema,
  projectRegistryIdSchema,
  projectScopeRefSchema,
  timestampSchema,
  workspaceIdSchema
} from "./primitives.js";

export const projectAccessSchemaVersion = "project-access/v1" as const;
export const projectAccessSchemaVersionSchema = z.literal(projectAccessSchemaVersion);
export type ProjectAccessSchemaVersion = z.infer<typeof projectAccessSchemaVersionSchema>;

export const projectVisibilitySchema = z.enum(["private", "shared"]);
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>;

export const canvasVisibilitySchema = z.enum(["private", "shared"]);
export type CanvasVisibility = z.infer<typeof canvasVisibilitySchema>;

export const projectAccessRoleSchema = z.enum(["owner", "editor", "viewer"]);
export type ProjectAccessRole = z.infer<typeof projectAccessRoleSchema>;

export const aclRevisionSchema = z.number().int().nonnegative();
export type AclRevision = z.infer<typeof aclRevisionSchema>;

export const aclRevisionRecordSchema = z
  .object({
    revision: aclRevisionSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type AclRevisionRecord = z.infer<typeof aclRevisionRecordSchema>;

/** A registry reference contains only opaque IDs. Filesystem roots are Server-owned. */
export const projectRegistryRefSchema = z
  .object({
    projectRegistryId: projectRegistryIdSchema,
    workspaceId: workspaceIdSchema,
    projectId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  })
  .strict();
export type ProjectRegistryRef = z.infer<typeof projectRegistryRefSchema>;

export const canvasRegistryRefSchema = z
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
export type CanvasRegistryRef = z.infer<typeof canvasRegistryRefSchema>;

/** Client-selected identity only. actor, workspace scope, and paths are injected by Server. */
export const projectAccessRequestSchema = z
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
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional()
  })
  .strict();
export type ProjectAccessRequest = z.infer<typeof projectAccessRequestSchema>;

export const canvasAccessRequestSchema = z
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
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  })
  .strict();
export type CanvasAccessRequest = z.infer<typeof canvasAccessRequestSchema>;

export const accessDeniedReasonSchema = z.enum([
  "missing",
  "revoked",
  "stale",
  "malformed",
  "cross_workspace",
  "cross_project",
  "cross_canvas"
]);
export type AccessDeniedReason = z.infer<typeof accessDeniedReasonSchema>;

export const projectAccessDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("allow"),
      aclRevision: aclRevisionSchema
    })
    .strict(),
  z
    .object({
      decision: z.literal("deny"),
      reason: accessDeniedReasonSchema,
      aclRevision: aclRevisionSchema
    })
    .strict()
]);
export type ProjectAccessDecision = z.infer<typeof projectAccessDecisionSchema>;

/** Server-owned authorization context. Clients cannot construct this from request DTOs. */
export const serverAccessContextSchema = z
  .object({
    actor: actorRefSchema,
    scope: z.union([projectScopeRefSchema, canvasScopeRefSchema]),
    aclRevision: aclRevisionSchema
  })
  .strict();
export type ServerAccessContext = z.infer<typeof serverAccessContextSchema>;

export const projectAccessRecordSchema = z
  .object({
    schemaVersion: projectAccessSchemaVersionSchema,
    registry: projectRegistryRefSchema,
    visibility: projectVisibilitySchema,
    acl: aclRevisionRecordSchema,
    owner: humanPrincipalIdSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type ProjectAccessRecord = z.infer<typeof projectAccessRecordSchema>;

export const canvasAccessRecordSchema = z
  .object({
    schemaVersion: projectAccessSchemaVersionSchema,
    registry: canvasRegistryRefSchema,
    visibility: canvasVisibilitySchema,
    acl: aclRevisionRecordSchema,
    owner: humanPrincipalIdSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type CanvasAccessRecord = z.infer<typeof canvasAccessRecordSchema>;

const membershipGrantBaseSchema = z
  .object({
    schemaVersion: projectAccessSchemaVersionSchema,
    grantId: membershipGrantIdSchema,
    workspaceId: workspaceIdSchema,
    projectId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    humanPrincipalId: humanPrincipalIdSchema,
    role: projectAccessRoleSchema,
    aclRevision: aclRevisionSchema,
    grantedBy: actorRefSchema,
    grantedAt: timestampSchema,
    revokedAt: timestampSchema.nullable()
  })
  .strict();

export const projectMembershipGrantSchema = membershipGrantBaseSchema
  .extend({
    scopeKind: z.literal("project"),
    canvasId: z.null()
  })
  .strict();
export type ProjectMembershipGrant = z.infer<typeof projectMembershipGrantSchema>;

export const canvasMembershipGrantSchema = membershipGrantBaseSchema
  .extend({
    scopeKind: z.literal("canvas"),
    canvasId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  })
  .strict();
export type CanvasMembershipGrant = z.infer<typeof canvasMembershipGrantSchema>;

export const membershipGrantSchema = z.discriminatedUnion("scopeKind", [
  projectMembershipGrantSchema,
  canvasMembershipGrantSchema
]);
export type MembershipGrant = z.infer<typeof membershipGrantSchema>;

const membershipGrantInputBaseSchema = z
  .object({
    projectId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    humanPrincipalId: humanPrincipalIdSchema,
    role: projectAccessRoleSchema
  })
  .strict();
export const membershipGrantInputSchema = z.discriminatedUnion("scopeKind", [
  membershipGrantInputBaseSchema
    .extend({ scopeKind: z.literal("project"), canvasId: z.null() })
    .strict(),
  membershipGrantInputBaseSchema
    .extend({
      scopeKind: z.literal("canvas"),
      canvasId: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    })
    .strict()
]);
export type MembershipGrantInput = z.infer<typeof membershipGrantInputSchema>;

/** Bounded read models; all collection reads are registry/ACL scoped, never directory scoped. */
export const projectAccessPageSchema = z
  .object({
    items: z.array(projectAccessRecordSchema).max(PROJECT_ACCESS_MAX_PROJECTS_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type ProjectAccessPage = z.infer<typeof projectAccessPageSchema>;

export const canvasAccessPageSchema = z
  .object({
    items: z.array(canvasAccessRecordSchema).max(PROJECT_ACCESS_MAX_CANVASES_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type CanvasAccessPage = z.infer<typeof canvasAccessPageSchema>;

/** Bounded cursor pagination shared by registry collection reads. */
const registryCursorSchema = z.number().int().nonnegative();
const registryLimitSchema = z.number().int().min(1).max(PROJECT_ACCESS_MAX_PROJECTS_PER_PAGE);
export const registryPageQuerySchema = z
  .object({
    cursor: registryCursorSchema.default(0),
    limit: registryLimitSchema.default(PROJECT_ACCESS_MAX_PROJECTS_PER_PAGE)
  })
  .strict();
export type RegistryPageQuery = z.infer<typeof registryPageQuerySchema>;

export const membershipGrantPageSchema = z
  .object({
    items: z.array(membershipGrantSchema).max(PROJECT_ACCESS_MAX_GRANTS),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type MembershipGrantPage = z.infer<typeof membershipGrantPageSchema>;

/** Registry operations are bounded by IDs; path/browser and sync operations have no contract. */
export const registryOperationSchema = z.enum([
  "list_authorized_projects",
  "list_authorized_canvases",
  "register_canvas",
  "create_snapshot",
  "read_snapshot",
  "restore_snapshot"
]);
export type RegistryOperation = z.infer<typeof registryOperationSchema>;

const registryProjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const registryCanvasIdSchema = registryProjectIdSchema;

export const registryClientCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list_authorized_projects"),
      cursor: registryCursorSchema.optional(),
      limit: registryLimitSchema.optional()
    })
    .strict(),
  z
    .object({
      operation: z.literal("list_authorized_canvases"),
      projectId: registryProjectIdSchema,
      cursor: registryCursorSchema.optional(),
      limit: registryLimitSchema.optional()
    })
    .strict(),
  z
    .object({
      operation: z.literal("register_canvas"),
      projectId: registryProjectIdSchema,
      canvasId: registryCanvasIdSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("create_snapshot"),
      projectId: registryProjectIdSchema,
      canvasId: registryCanvasIdSchema,
      expectedAclRevision: aclRevisionSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("read_snapshot"),
      projectId: registryProjectIdSchema,
      canvasId: registryCanvasIdSchema,
      snapshotId: packageSnapshotIdSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("restore_snapshot"),
      projectId: registryProjectIdSchema,
      canvasId: registryCanvasIdSchema,
      snapshotId: packageSnapshotIdSchema,
      expectedAclRevision: aclRevisionSchema
    })
    .strict()
]);
export type RegistryClientCommand = z.infer<typeof registryClientCommandSchema>;
