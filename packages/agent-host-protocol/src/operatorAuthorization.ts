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

export const managementDeviceSecretSchema = z.string().regex(/^pw_device_[A-Za-z0-9_-]{43}$/);
export const managementDeviceEnrollmentSchema = z
  .object({
    deviceSecret: managementDeviceSecretSchema,
    deviceName: z.string().trim().min(1).max(128)
  })
  .strict();
export const managementDeviceRefreshSchema = z
  .object({
    deviceSecret: managementDeviceSecretSchema,
    newToken: managementTokenSchema
  })
  .strict();
export const managementDeviceRevokeSchema = z.object({ deviceId: z.string().uuid() }).strict();
export const managementDeviceSchema = z
  .object({
    deviceId: z.string().uuid(),
    deviceName: z.string(),
    operatorId: opaqueIdentifierSchema,
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable()
  })
  .strict();
export const managementDevicesSchema = z.array(managementDeviceSchema);
export type ManagementDevice = z.infer<typeof managementDeviceSchema>;

export const managementDeviceAccessSchema = managementAuthorizationStatusSchema
  .extend({ deviceId: z.string().uuid() })
  .strict();
