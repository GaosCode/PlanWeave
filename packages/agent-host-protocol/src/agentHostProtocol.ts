import { z } from "zod";
import { normalizedAcpEventBatchSchema } from "./acpEvents.js";
import { capabilitiesSchema } from "./capabilities.js";
import { executionEnvelopeDigestSchema, executionEnvelopeSchema } from "./executionEnvelope.js";
import { hashExecutionEnvelope } from "./executionEnvelopeHash.js";
import { executionAttemptIdSchema, dispatchIdSchema } from "./executionIdentity.js";
import { opaqueIdentifierSchema } from "./identifiers.js";
import { interactionRequestSchema, interactionSettlementSchema } from "./interactions.js";
import { leaseIdSchema } from "./leaseIdentity.js";
import {
  acpRecoveryIdentitySchema,
  dispatchLifecycleIdentitySchema,
  executionCompletedSchema,
  executionFailedSchema,
  executionInterruptedSchema,
  PROGRESS_MESSAGE_MAX_LENGTH
} from "./lifecycle.js";
import {
  mailboxDeliveredSequenceSchema,
  mailboxMessageIdSchema,
  mailboxSequenceSchema
} from "./mailboxIdentity.js";
import { agentHostProtocolVersionSchema } from "./version.js";
import { hostCapacitySchema, hostReadinessObservationSchema } from "./hostReadiness.js";
import {
  canvasRuntimeCancelCommandSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeResponsePayloadSchema
} from "./canvasRuntimeProtocol.js";

export const PROTOCOL_ERROR_MESSAGE_MAX_LENGTH = 4_096 as const;
export const CANCEL_REASON_MAX_LENGTH = 4_096 as const;
export const ACTIVE_LEASE_MAX_COUNT = 128 as const;
const versionedSchema = z.object({ protocolVersion: agentHostProtocolVersionSchema }).strict();
const durableHostEventSchema = versionedSchema.extend({ messageId: mailboxMessageIdSchema });

export const hostHelloSchema = versionedSchema.extend({
  type: z.literal("host.hello"),
  lastAcknowledgedSequence: mailboxSequenceSchema,
  capabilities: capabilitiesSchema,
  capacity: hostCapacitySchema,
  readiness: hostReadinessObservationSchema.optional()
});

export const hostWelcomeSchema = versionedSchema.extend({
  type: z.literal("host.welcome"),
  serverTime: z.string().datetime(),
  heartbeatIntervalMs: z.number().int().positive().safe(),
  leaseDurationMs: z.number().int().positive().safe()
});

export const executeBlockCommandSchema = versionedSchema
  .extend({
    type: z.literal("execute_block"),
    dispatchId: dispatchIdSchema,
    leaseId: leaseIdSchema,
    executionAttemptId: executionAttemptIdSchema,
    leaseExpiresAt: z.string().datetime(),
    envelopeDigest: executionEnvelopeDigestSchema,
    envelope: executionEnvelopeSchema
  })
  .superRefine((command, context) => {
    if (
      command.dispatchId !== command.envelope.execution.dispatchId ||
      command.executionAttemptId !== command.envelope.execution.attemptId
    ) {
      context.addIssue({
        code: "custom",
        message: "Command identity must match the Execution Envelope.",
        path: ["envelope", "execution"]
      });
    }
    if (command.envelopeDigest !== hashExecutionEnvelope(command.envelope)) {
      context.addIssue({
        code: "custom",
        message: "Command envelopeDigest must match the canonical Execution Envelope hash.",
        path: ["envelopeDigest"]
      });
    }
  });

export const cancelExecutionCommandSchema = versionedSchema.extend({
  type: z.literal("cancel_execution"),
  ...dispatchLifecycleIdentitySchema.shape,
  reason: z.string().min(1).max(CANCEL_REASON_MAX_LENGTH)
});

export const resumeExecutionCommandSchema = versionedSchema.extend({
  type: z.literal("resume_execution"),
  ...dispatchLifecycleIdentitySchema.shape,
  priorRecovery: acpRecoveryIdentitySchema,
  leaseExpiresAt: z.string().datetime()
});

export const serverToHostCommandSchema = z.discriminatedUnion("type", [
  executeBlockCommandSchema,
  cancelExecutionCommandSchema,
  resumeExecutionCommandSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeCancelCommandSchema
]);

export const mailboxCommandSchema = z.discriminatedUnion("type", [
  executeBlockCommandSchema,
  cancelExecutionCommandSchema,
  resumeExecutionCommandSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeCancelCommandSchema,
  interactionSettlementSchema.options[0],
  interactionSettlementSchema.options[1],
  interactionSettlementSchema.options[2]
]);

export const mailboxDeliverySchema = versionedSchema.extend({
  type: z.literal("mailbox.message"),
  sequence: mailboxDeliveredSequenceSchema,
  previousSequence: mailboxSequenceSchema,
  messageId: mailboxMessageIdSchema,
  command: mailboxCommandSchema
});

export const mailboxAcknowledgementSchema = durableHostEventSchema.extend({
  type: z.literal("mailbox.ack"),
  sequence: mailboxDeliveredSequenceSchema
});

const hostHeartbeatSchema = durableHostEventSchema.extend({
  type: z.literal("host.heartbeat"),
  activeLeases: z.array(dispatchLifecycleIdentitySchema).max(ACTIVE_LEASE_MAX_COUNT),
  readiness: hostReadinessObservationSchema.optional()
});

const dispatchAcceptedSchema = durableHostEventSchema.extend({
  type: z.literal("dispatch.accepted"),
  ...dispatchLifecycleIdentitySchema.shape
});

export const leaseRenewalRequestSchema = durableHostEventSchema.extend({
  type: z.literal("lease.renew"),
  ...dispatchLifecycleIdentitySchema.shape
});

export const hostToServerEventSchema = z.discriminatedUnion("type", [
  mailboxAcknowledgementSchema,
  hostHeartbeatSchema,
  dispatchAcceptedSchema,
  leaseRenewalRequestSchema,
  durableHostEventSchema.merge(executionInterruptedSchema),
  durableHostEventSchema.merge(executionCompletedSchema),
  durableHostEventSchema.merge(executionFailedSchema),
  durableHostEventSchema.merge(canvasRuntimeResponsePayloadSchema)
]);

export const canvasRuntimeResponseEventSchema = durableHostEventSchema.merge(
  canvasRuntimeResponsePayloadSchema
);

const dispatchProgressSchema = durableHostEventSchema.extend({
  type: z.literal("dispatch.progress"),
  ...dispatchLifecycleIdentitySchema.shape,
  percent: z.number().min(0).max(100).optional(),
  message: z.string().max(PROGRESS_MESSAGE_MAX_LENGTH).optional()
});

const acpEventObservationSchema = durableHostEventSchema.merge(normalizedAcpEventBatchSchema);
const permissionRequestObservationSchema = durableHostEventSchema.merge(
  interactionRequestSchema.options[0]
);
const elicitationRequestObservationSchema = durableHostEventSchema.merge(
  interactionRequestSchema.options[1]
);
const authenticationRequestObservationSchema = durableHostEventSchema.merge(
  interactionRequestSchema.options[2]
);

export const observationEventSchema = z.discriminatedUnion("type", [
  dispatchProgressSchema,
  acpEventObservationSchema,
  permissionRequestObservationSchema,
  elicitationRequestObservationSchema,
  authenticationRequestObservationSchema
]);

export const hostEventSchema = z.discriminatedUnion("type", [
  ...hostToServerEventSchema.options,
  ...observationEventSchema.options
]);

export const hostEventAcknowledgementSchema = versionedSchema.extend({
  type: z.literal("host.event_ack"),
  messageId: mailboxMessageIdSchema
});

export const leaseRenewedSchema = versionedSchema.extend({
  type: z.literal("lease.renewed"),
  ...dispatchLifecycleIdentitySchema.shape,
  leaseExpiresAt: z.string().datetime()
});

export const protocolErrorSchema = versionedSchema.extend({
  type: z.literal("protocol.error"),
  code: opaqueIdentifierSchema,
  message: z.string().min(1).max(PROTOCOL_ERROR_MESSAGE_MAX_LENGTH),
  messageId: mailboxMessageIdSchema.optional()
});

export const serverEventSchema = z.discriminatedUnion("type", [
  hostWelcomeSchema,
  mailboxDeliverySchema,
  hostEventAcknowledgementSchema,
  leaseRenewedSchema,
  protocolErrorSchema
]);

export type HostHello = z.infer<typeof hostHelloSchema>;
export type ServerToHostCommand = z.infer<typeof serverToHostCommandSchema>;
export type MailboxCommand = z.infer<typeof mailboxCommandSchema>;
export type HostToServerEvent = z.infer<typeof hostToServerEventSchema>;
export type ObservationEvent = z.infer<typeof observationEventSchema>;
export type HostEvent = z.infer<typeof hostEventSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
