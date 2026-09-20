import { z } from "zod";
import {
  managementAuthorizationStatusSchema,
  managementDevicesSchema,
  managementRecoveryCodeSchema
} from "@planweave-ai/agent-host-protocol/operator-control";

export const operatorManagementInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128)
  })
  .strict();
export const operatorManagementRecoverInputSchema = operatorManagementInputSchema
  .extend({
    recoveryCode: managementRecoveryCodeSchema
  })
  .strict();
export type OperatorManagementInput = z.infer<typeof operatorManagementInputSchema>;
export type OperatorManagementRecoverInput = z.infer<typeof operatorManagementRecoverInputSchema>;
export const operatorManagementViewSchema = z
  .object({
    profileId: z.string(),
    authorization: managementAuthorizationStatusSchema.nullable(),
    errorCode: z.string().nullable(),
    deviceId: z.string().uuid().nullable().optional(),
    devices: managementDevicesSchema.optional()
  })
  .strict();
export type OperatorManagementView = z.infer<typeof operatorManagementViewSchema>;

export const operatorManagementRevokeInputSchema = operatorManagementInputSchema
  .extend({ deviceId: z.string().uuid() })
  .strict();
export type OperatorManagementRevokeInput = z.infer<typeof operatorManagementRevokeInputSchema>;
