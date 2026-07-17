import { z } from "zod";
import {
  runnerRequestActionIdentitySchema,
  runnerSessionActionIdentitySchema
} from "./runnerContractSchemas.js";
import { utf8ByteLength } from "./runnerEventRedaction.js";
import { runnerPermissionOptionIdSchema } from "./runnerInteractionContract.js";

/**
 * Cross-process control is a transport to the current live owner, not a durable
 * ownership record. A restarted client may rediscover an owner that is still
 * alive; a restarted owner must publish a new lease and cannot take over the
 * previous ACP connection, pending promises, or prompt queue.
 */
export const AGENT_RUN_CONTROL_PROTOCOL_VERSION = "planweave.agent-run-control/v1" as const;
export const AGENT_RUN_CONTROL_MAX_FRAME_BYTES = 131_072;
export const AGENT_RUN_CONTROL_MAX_FOLLOW_UP_BYTES = 65_536;
export const AGENT_RUN_CONTROL_MAX_UNIX_ADDRESS_BYTES = 100;
export const AGENT_RUN_CONTROL_MAX_NAMED_PIPE_ADDRESS_BYTES = 512;

// biome-ignore lint/style/useExportsLast: Public schemas stay beside their version constant and dependent schemas.
export const agentRunControlProtocolVersionSchema = z.literal(AGENT_RUN_CONTROL_PROTOCOL_VERSION);

const UUID_V4_LENGTH = 36;
const ELICITATION_CONTENT_KEY_MAX_CHARACTERS = 256;
const CONTROL_ERROR_MESSAGE_MAX_CHARACTERS = 4096;
const invalidEndpointAddressPattern = /[\0\r\n]/u;
const namedPipeAddressPattern = /^\\\\\.\\pipe\\[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const uuidV4Schema = z
  .string()
  .length(UUID_V4_LENGTH)
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected a canonical UUIDv4 identifier."
  );

export const agentRunControlLeaseIdSchema = uuidV4Schema.brand("AgentRunControlLeaseId");
export const agentRunControlCommandIdSchema = uuidV4Schema.brand("AgentRunControlCommandId");
export const agentRunControlTransportSchema = z.enum(["unix", "named_pipe"]);

const addressSchema = z
  .string()
  .min(1)
  .max(AGENT_RUN_CONTROL_MAX_NAMED_PIPE_ADDRESS_BYTES)
  .refine(
    (value) => !invalidEndpointAddressPattern.test(value),
    "Control endpoint address is invalid."
  );

export const agentRunControlEndpointDescriptorSchema = z
  .object({
    version: agentRunControlProtocolVersionSchema,
    transport: agentRunControlTransportSchema,
    address: addressSchema,
    leaseId: agentRunControlLeaseIdSchema,
    ownerPid: z.number().int().positive().safe(),
    publishedAt: z.string().datetime()
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.transport === "unix") {
      if (!descriptor.address.startsWith("/")) {
        context.addIssue({
          code: "custom",
          path: ["address"],
          message: "Unix control endpoint address must be an absolute path."
        });
      }
      if (utf8ByteLength(descriptor.address) > AGENT_RUN_CONTROL_MAX_UNIX_ADDRESS_BYTES) {
        context.addIssue({
          code: "custom",
          path: ["address"],
          message: `Unix control endpoint address exceeds ${AGENT_RUN_CONTROL_MAX_UNIX_ADDRESS_BYTES} UTF-8 bytes.`
        });
      }
      return;
    }

    if (!namedPipeAddressPattern.test(descriptor.address)) {
      context.addIssue({
        code: "custom",
        path: ["address"],
        message: "Named pipe address must use the \\\\.\\pipe\\<name> format."
      });
    }
    if (utf8ByteLength(descriptor.address) > AGENT_RUN_CONTROL_MAX_NAMED_PIPE_ADDRESS_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["address"],
        message: `Named pipe address exceeds ${AGENT_RUN_CONTROL_MAX_NAMED_PIPE_ADDRESS_BYTES} UTF-8 bytes.`
      });
    }
  });

const elicitationAcceptedOutcomeSchema = z
  .object({
    action: z.literal("accept"),
    content: z.record(z.string().min(1).max(ELICITATION_CONTENT_KEY_MAX_CHARACTERS), z.json())
  })
  .strict();
const elicitationDeclinedOutcomeSchema = z.object({ action: z.literal("decline") }).strict();
const elicitationCancelledOutcomeSchema = z.object({ action: z.literal("cancel") }).strict();

export const agentRunControlRespondOutcomeSchema = z.union([
  runnerPermissionOptionIdSchema,
  elicitationAcceptedOutcomeSchema,
  elicitationDeclinedOutcomeSchema,
  elicitationCancelledOutcomeSchema
]);

const commandEnvelopeShape = {
  version: agentRunControlProtocolVersionSchema,
  commandId: agentRunControlCommandIdSchema,
  leaseId: agentRunControlLeaseIdSchema
} as const;

export const agentRunControlCancelCommandSchema = z
  .object({
    ...commandEnvelopeShape,
    kind: z.literal("cancel"),
    identity: runnerSessionActionIdentitySchema
  })
  .strict();

const followUpPromptSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Follow-up prompt must not be blank.")
  .refine(
    (value) => utf8ByteLength(value) <= AGENT_RUN_CONTROL_MAX_FOLLOW_UP_BYTES,
    `Follow-up prompt exceeds ${AGENT_RUN_CONTROL_MAX_FOLLOW_UP_BYTES} UTF-8 bytes.`
  );

export const agentRunControlFollowUpCommandSchema = z
  .object({
    ...commandEnvelopeShape,
    kind: z.literal("follow_up"),
    identity: runnerSessionActionIdentitySchema,
    prompt: followUpPromptSchema
  })
  .strict();

export const agentRunControlRespondCommandSchema = z
  .object({
    ...commandEnvelopeShape,
    kind: z.literal("respond"),
    identity: runnerRequestActionIdentitySchema,
    outcome: agentRunControlRespondOutcomeSchema
  })
  .strict();

export const agentRunControlCommandSchema = z
  .discriminatedUnion("kind", [
    agentRunControlCancelCommandSchema,
    agentRunControlFollowUpCommandSchema,
    agentRunControlRespondCommandSchema
  ])
  .superRefine((command, context) => {
    if (utf8ByteLength(JSON.stringify(command)) > AGENT_RUN_CONTROL_MAX_FRAME_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Control command exceeds ${AGENT_RUN_CONTROL_MAX_FRAME_BYTES} UTF-8 bytes.`
      });
    }
  });

export const agentRunControlActionSchema = z.discriminatedUnion("kind", [
  agentRunControlCancelCommandSchema.omit({ version: true, commandId: true, leaseId: true }),
  agentRunControlFollowUpCommandSchema.omit({ version: true, commandId: true, leaseId: true }),
  agentRunControlRespondCommandSchema.omit({ version: true, commandId: true, leaseId: true })
]);

export const agentRunControlReceiptResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted") }).strict(),
  z
    .object({
      status: z.literal("delivered"),
      deliveredAt: z.string().datetime()
    })
    .strict()
]);

export const agentRunControlSuccessReceiptSchema = z
  .object({
    version: agentRunControlProtocolVersionSchema,
    ok: z.literal(true),
    commandId: agentRunControlCommandIdSchema,
    acceptedAt: z.string().datetime(),
    ownerPid: z.number().int().positive().safe(),
    leaseId: agentRunControlLeaseIdSchema,
    result: agentRunControlReceiptResultSchema
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.result.status === "delivered" &&
      Date.parse(receipt.result.deliveredAt) < Date.parse(receipt.acceptedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "deliveredAt"],
        message: "deliveredAt must not precede acceptedAt."
      });
    }
  });

export const agentRunControlErrorCodeSchema = z.enum([
  "invalid_identity",
  "stale_lease",
  "not_owner",
  "not_active",
  "request_not_pending",
  "capability_denied",
  "delivery_failed",
  "protocol_mismatch"
]);

export const agentRunControlErrorResponseSchema = z
  .object({
    version: agentRunControlProtocolVersionSchema,
    ok: z.literal(false),
    commandId: agentRunControlCommandIdSchema.nullable(),
    code: agentRunControlErrorCodeSchema,
    message: z.string().min(1).max(CONTROL_ERROR_MESSAGE_MAX_CHARACTERS)
  })
  .strict();

export const agentRunControlResponseSchema = z.union([
  agentRunControlSuccessReceiptSchema,
  agentRunControlErrorResponseSchema
]);

export type AgentRunControlProtocolVersion = z.infer<typeof agentRunControlProtocolVersionSchema>;
export type AgentRunControlLeaseId = z.infer<typeof agentRunControlLeaseIdSchema>;
export type AgentRunControlCommandId = z.infer<typeof agentRunControlCommandIdSchema>;
export type AgentRunControlTransport = z.infer<typeof agentRunControlTransportSchema>;
export type AgentRunControlEndpointDescriptor = z.infer<
  typeof agentRunControlEndpointDescriptorSchema
>;
export type AgentRunControlRespondOutcome = z.infer<typeof agentRunControlRespondOutcomeSchema>;
export type AgentRunControlCommand = z.infer<typeof agentRunControlCommandSchema>;
export type AgentRunControlAction = z.infer<typeof agentRunControlActionSchema>;
export type AgentRunControlReceiptResult = z.infer<typeof agentRunControlReceiptResultSchema>;
export type AgentRunControlSuccessReceipt = z.infer<typeof agentRunControlSuccessReceiptSchema>;
export type AgentRunControlErrorCode = z.infer<typeof agentRunControlErrorCodeSchema>;
export type AgentRunControlErrorResponse = z.infer<typeof agentRunControlErrorResponseSchema>;
export type AgentRunControlResponse = z.infer<typeof agentRunControlResponseSchema>;
