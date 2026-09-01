import { z } from "zod";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol/browser";
import {
  completedContentVersionRefSchema,
  completeContentVersionSchema,
  contentVersionMemberSchema
} from "./contentVersion.js";
import {
  CONTENT_VERSION_MAX_MEMBERS,
  CONTENT_VERSION_MAX_TOTAL_BYTES,
  CONTENT_VERSION_TRANSFER_MAX_FRAME_BYTES,
  CONTENT_VERSION_TRANSFER_MAX_WIRE_BYTES
} from "./limits.js";
import { packageSnapshotSourceRevisionSchema } from "./packageSnapshot.js";
import { humanPrincipalIdSchema } from "./primitives.js";

/** A Server-owned owner Canvas materialization, separate from Workspace canvas publication. */
export const ownerCanvasMaterializationSchemaVersion = "owner-canvas-materialization/v1" as const;
export const ownerCanvasMaterializationSchemaVersionSchema = z.literal(
  ownerCanvasMaterializationSchemaVersion
);
export type OwnerCanvasMaterializationSchemaVersion = z.infer<
  typeof ownerCanvasMaterializationSchemaVersionSchema
>;

export const ownerCanvasMaterializationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type OwnerCanvasMaterializationId = z.infer<typeof ownerCanvasMaterializationIdSchema>;

/** Public owner authority. Runtime workspace identities deliberately do not cross this boundary. */
export const ownerCanvasMaterializationScopeSchema = z
  .object({
    ownerHumanPrincipalId: humanPrincipalIdSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema
  })
  .strict();
export type OwnerCanvasMaterializationScope = z.infer<typeof ownerCanvasMaterializationScopeSchema>;

export const ownerCanvasMaterializationExpectedHeadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z
    .object({
      kind: z.literal("present"),
      revision: z.number().int().positive(),
      content: completedContentVersionRefSchema
    })
    .strict()
]);
export type OwnerCanvasMaterializationExpectedHead = z.infer<
  typeof ownerCanvasMaterializationExpectedHeadSchema
>;

export const ownerCanvasMaterializationHeadViewSchema = z
  .object({
    schemaVersion: ownerCanvasMaterializationSchemaVersionSchema,
    scope: ownerCanvasMaterializationScopeSchema,
    head: ownerCanvasMaterializationExpectedHeadSchema
  })
  .strict();
export type OwnerCanvasMaterializationHeadView = z.infer<
  typeof ownerCanvasMaterializationHeadViewSchema
>;

/** Metadata is the first frame of an upload and remains bounded independently of content size. */
export const ownerCanvasMaterializationRequestMetadataSchema = z
  .object({
    schemaVersion: ownerCanvasMaterializationSchemaVersionSchema,
    materializationId: ownerCanvasMaterializationIdSchema,
    scope: ownerCanvasMaterializationScopeSchema,
    expectedHead: ownerCanvasMaterializationExpectedHeadSchema
  })
  .strict();
export type OwnerCanvasMaterializationRequestMetadata = z.infer<
  typeof ownerCanvasMaterializationRequestMetadataSchema
>;

/** In-process DTO. Network callers should use the framed upload contract below. */
export const ownerCanvasMaterializationRequestSchema =
  ownerCanvasMaterializationRequestMetadataSchema
    .extend({ content: completeContentVersionSchema })
    .strict();
export type OwnerCanvasMaterializationRequest = z.infer<
  typeof ownerCanvasMaterializationRequestSchema
>;

export const ownerCanvasMaterializationResultSchema = z
  .object({
    schemaVersion: ownerCanvasMaterializationSchemaVersionSchema,
    materializationId: ownerCanvasMaterializationIdSchema,
    scope: ownerCanvasMaterializationScopeSchema,
    head: z
      .object({
        revision: z.number().int().positive(),
        content: completedContentVersionRefSchema
      })
      .strict(),
    contentRevision: packageSnapshotSourceRevisionSchema,
    graphFingerprint: z.string().regex(/^pkg-[a-f0-9]{64}$/)
  })
  .strict();
export type OwnerCanvasMaterializationResult = z.infer<
  typeof ownerCanvasMaterializationResultSchema
>;

/** Bounded upload stream for complete content; unlike generic Operator JSON it supports full content limits. */
export const ownerCanvasMaterializationUploadMediaType =
  "application/x-planweave-owner-canvas-materialization-ndjson" as const;

export const ownerCanvasMaterializationUploadHeaderFrameSchema = z
  .object({ type: z.literal("header"), request: ownerCanvasMaterializationRequestMetadataSchema })
  .strict();
export const ownerCanvasMaterializationUploadMemberFrameSchema = z
  .object({
    type: z.literal("member"),
    index: z.number().int().nonnegative(),
    member: contentVersionMemberSchema
  })
  .strict();
export const ownerCanvasMaterializationUploadCompleteFrameSchema = z
  .object({
    type: z.literal("complete"),
    canonicalDigest: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    totalBytes: z.number().int().positive().max(CONTENT_VERSION_MAX_TOTAL_BYTES),
    memberCount: z.number().int().min(2).max(CONTENT_VERSION_MAX_MEMBERS)
  })
  .strict();
export const ownerCanvasMaterializationUploadFrameSchema = z.discriminatedUnion("type", [
  ownerCanvasMaterializationUploadHeaderFrameSchema,
  ownerCanvasMaterializationUploadMemberFrameSchema,
  ownerCanvasMaterializationUploadCompleteFrameSchema
]);
export type OwnerCanvasMaterializationUploadFrame = z.infer<
  typeof ownerCanvasMaterializationUploadFrameSchema
>;

export const ownerCanvasMaterializationUploadLimits = {
  maxFrameBytes: CONTENT_VERSION_TRANSFER_MAX_FRAME_BYTES,
  maxWireBytes: CONTENT_VERSION_TRANSFER_MAX_WIRE_BYTES
} as const;
