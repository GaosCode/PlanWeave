import { z } from "zod";
import { SETUP_CODE_REASON_MAX_LENGTH } from "./limits.js";
import {
  humanDeviceTokenSchema,
  humanIdentitySchemaVersionSchema,
  humanIdentityTokenSchema,
  humanPrincipalIdSchema,
  humanPrincipalMergeIdSchema,
  identityCredentialIdSchema,
  timestampSchema
} from "./primitives.js";

/**
 * Rotate one Server-global Human Identity Credential. The presented token is
 * revoked; the replacement is returned once.
 */
export const humanIdentityRenewRequestSchema = z
  .object({
    schemaVersion: humanIdentitySchemaVersionSchema,
    identityToken: humanIdentityTokenSchema
  })
  .strict();
export type HumanIdentityRenewRequest = z.infer<typeof humanIdentityRenewRequestSchema>;

export const humanIdentityRenewResponseSchema = z
  .object({
    schemaVersion: humanIdentitySchemaVersionSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    identityCredentialId: identityCredentialIdSchema,
    identityToken: humanIdentityTokenSchema,
    identityExpiresAt: timestampSchema
  })
  .strict();
export type HumanIdentityRenewResponse = z.infer<typeof humanIdentityRenewResponseSchema>;

/** Revoke one identity credential. Other credentials for the same principal remain. */
export const humanIdentityRevokeRequestSchema = z
  .object({
    schemaVersion: humanIdentitySchemaVersionSchema,
    identityToken: humanIdentityTokenSchema,
    reason: z.string().trim().min(1).max(SETUP_CODE_REASON_MAX_LENGTH)
  })
  .strict();
export type HumanIdentityRevokeRequest = z.infer<typeof humanIdentityRevokeRequestSchema>;

export const humanIdentityRevokeResponseSchema = z
  .object({
    schemaVersion: humanIdentitySchemaVersionSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    identityCredentialId: identityCredentialIdSchema,
    revokedAt: timestampSchema
  })
  .strict();
export type HumanIdentityRevokeResponse = z.infer<typeof humanIdentityRevokeResponseSchema>;

/**
 * Auditable merge of two proven Human Principals. Both identity tokens must be
 * currently valid. The source id becomes an alias of the canonical id.
 * Unproven splits fail closed; there is no silent merge.
 */
export const humanPrincipalMergeRequestSchema = z
  .object({
    schemaVersion: humanIdentitySchemaVersionSchema,
    sourceIdentityToken: humanIdentityTokenSchema,
    canonicalIdentityToken: humanIdentityTokenSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sourceIdentityToken === value.canonicalIdentityToken) {
      ctx.addIssue({
        code: "custom",
        message: "identity_merge_tokens_must_differ",
        path: ["sourceIdentityToken"]
      });
    }
  });
export type HumanPrincipalMergeRequest = z.infer<typeof humanPrincipalMergeRequestSchema>;

export const humanPrincipalMergeResponseSchema = z
  .object({
    schemaVersion: humanIdentitySchemaVersionSchema,
    canonicalHumanPrincipalId: humanPrincipalIdSchema,
    alreadyEquivalent: z.boolean().optional(),
    mergeId: humanPrincipalMergeIdSchema.optional(),
    sourceHumanPrincipalId: humanPrincipalIdSchema.optional(),
    mergedAt: timestampSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.alreadyEquivalent === true) return;
    if (
      value.mergeId === undefined ||
      value.sourceHumanPrincipalId === undefined ||
      value.mergedAt === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "identity_merge_audit_required",
        path: ["mergeId"]
      });
    }
  });
export type HumanPrincipalMergeResponse = z.infer<typeof humanPrincipalMergeResponseSchema>;

/**
 * Recover a Server-global identity credential from a still-valid Workspace
 * device session or legacy project device. Independent of setup-code redeem.
 */
export const humanIdentityRecoverRequestSchema = z
  .object({
    schemaVersion: humanIdentitySchemaVersionSchema,
    existingDeviceToken: humanDeviceTokenSchema
  })
  .strict();
export type HumanIdentityRecoverRequest = z.infer<typeof humanIdentityRecoverRequestSchema>;

export const humanIdentityRecoverResponseSchema = z
  .object({
    schemaVersion: humanIdentitySchemaVersionSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    identityCredentialId: identityCredentialIdSchema,
    identityToken: humanIdentityTokenSchema,
    identityExpiresAt: timestampSchema
  })
  .strict();
export type HumanIdentityRecoverResponse = z.infer<typeof humanIdentityRecoverResponseSchema>;
