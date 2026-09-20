import { z } from "zod";
import {
  managementAuthorizationStatusSchema,
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
    errorCode: z.string().nullable()
  })
  .strict();
export type OperatorManagementView = z.infer<typeof operatorManagementViewSchema>;
