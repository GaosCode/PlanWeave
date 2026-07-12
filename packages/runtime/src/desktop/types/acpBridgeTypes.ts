import { z } from "zod";
import { runnerEventCursorSchema } from "../../autoRun/runnerEventReplay.js";
import { runnerRecordReadModelSchema } from "../../autoRun/runnerRecordReadModel.js";
import {
  runnerRequestActionIdentitySchema,
  runnerSessionActionIdentitySchema
} from "../../autoRun/runnerContractSchemas.js";
import type { RunnerRecordReadModel } from "../../autoRun/runnerRecordReadModel.js";

const nonEmptyStringSchema = z.string().min(1).max(4_096);

export const desktopRunnerRecordSubscriptionInputSchema = z
  .object({
    subscriptionId: nonEmptyStringSchema.max(256),
    ref: z
      .object({
        projectRoot: nonEmptyStringSchema,
        canvasId: nonEmptyStringSchema.max(256).nullable().optional()
      })
      .strict(),
    recordId: nonEmptyStringSchema.max(1_024),
    cursor: runnerEventCursorSchema.optional()
  })
  .strict();
export type DesktopRunnerRecordSubscriptionInput = z.infer<
  typeof desktopRunnerRecordSubscriptionInputSchema
>;

export const desktopRunnerRecordSubscriptionPushSchema = z
  .object({
    subscriptionId: nonEmptyStringSchema.max(256),
    updateSequence: z.number().int().positive(),
    snapshot: runnerRecordReadModelSchema
  })
  .strict();
export type DesktopRunnerRecordSubscriptionPush = z.infer<
  typeof desktopRunnerRecordSubscriptionPushSchema
>;

export type DesktopRunnerRecordSubscriptionStart = {
  subscriptionId: string;
  updateSequence: 0;
  snapshot: RunnerRecordReadModel | null;
};

export type DesktopRunnerRecordSubscriptionUpdate = Omit<
  DesktopRunnerRecordSubscriptionPush,
  "subscriptionId"
>;

export const desktopAgentSessionActionIdentitySchema = runnerSessionActionIdentitySchema;
export type DesktopAgentSessionActionIdentity = z.infer<typeof desktopAgentSessionActionIdentitySchema>;

export const desktopAgentActionIdentitySchema = runnerRequestActionIdentitySchema;
export type DesktopAgentActionIdentity = z.infer<typeof desktopAgentActionIdentitySchema>;

export const desktopAgentActionValueSchema = z.json();
export type DesktopAgentActionValue = z.infer<typeof desktopAgentActionValueSchema>;

export type DesktopPendingAgentRequest = {
  requestId: string;
  interactionId: string;
  kind: "permission" | "authentication" | "elicitation";
  requestedAt: string;
  summary: string;
};
