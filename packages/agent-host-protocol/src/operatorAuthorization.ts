import { z } from "zod";
import { opaqueIdentifierSchema } from "./identifiers.js";

export const managementTokenSchema = z.string().regex(/^pw_operator_[A-Za-z0-9_-]{43}$/);
export const managementRecoveryCodeSchema = z.string().regex(/^pw_recover_[A-Za-z0-9_-]{43}$/);
export const managementAuthorizationStatusSchema = z
  .object({
    operatorId: opaqueIdentifierSchema,
    expiresAt: z.iso.datetime(),
    renewAfter: z.iso.datetime()
  })
  .strict();
export type ManagementAuthorizationStatus = z.infer<typeof managementAuthorizationStatusSchema>;
export const managementAuthorizeRequestSchema = z
  .object({
    operatorId: opaqueIdentifierSchema,
    newToken: managementTokenSchema
  })
  .strict();
export const managementRecoverRequestSchema = managementAuthorizeRequestSchema
  .extend({
    recoveryCode: managementRecoveryCodeSchema
  })
  .strict();
