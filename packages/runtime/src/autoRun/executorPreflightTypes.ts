import { z } from "zod";
import {
  agentFamilySchema,
  executorIntegrationSchema,
  executorProfileAdapterSchema,
  runnerTransportSchema
} from "../types/executor.js";
import { acpSessionConfigurationSchema } from "./acpSessionConfiguration.js";
import {
  runnerAuthenticationStateSchema,
  runnerCapabilitySchema
} from "./runnerContractSchemas.js";

export {
  acpSessionConfigOptionSchema,
  acpSessionConfigurationSchema,
  acpSessionModeStateSchema
} from "./acpSessionConfiguration.js";
export type { AcpSessionConfiguration } from "./acpSessionConfiguration.js";

const EXECUTOR_AGENT_INFO_FIELD_MAX_LENGTH = 256;
export const invalidExecutorAgentInfoMessage =
  "ACP initialize returned invalid agentInfo; name and version must be non-empty strings.";

export const executorAgentInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(EXECUTOR_AGENT_INFO_FIELD_MAX_LENGTH),
    version: z.string().trim().min(1).max(EXECUTOR_AGENT_INFO_FIELD_MAX_LENGTH)
  })
  .strict();
export type ExecutorAgentInfo = z.infer<typeof executorAgentInfoSchema>;

export const executorPreflightCheckNameSchema = z.enum([
  "profile_exists",
  "adapter_supported",
  "cwd_resolved",
  "command_started",
  "command_version",
  "acp_initialized",
  "acp_authenticated",
  "acp_session",
  "acp_capabilities",
  "interaction_policy"
]);
export type ExecutorPreflightCheckName = z.infer<typeof executorPreflightCheckNameSchema>;

export const executorPreflightFailureCodeSchema = z.enum([
  "missing_command",
  "invalid_profile",
  "auth_required",
  "unsupported_capability",
  "initialization_failed",
  "timeout",
  "cancelled",
  "unsafe_interaction"
]);
export type ExecutorPreflightFailureCode = z.infer<typeof executorPreflightFailureCodeSchema>;

export function executorSpawnFailureCode(error: unknown): ExecutorPreflightFailureCode {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
    ? "missing_command"
    : "initialization_failed";
}

export const executorPreflightCheckStatusSchema = z.enum(["passed", "failed", "skipped"]);
export type ExecutorPreflightCheckStatus = z.infer<typeof executorPreflightCheckStatusSchema>;

export const executorPreflightCheckSchema = z
  .object({
    check: executorPreflightCheckNameSchema,
    status: executorPreflightCheckStatusSchema,
    message: z.string(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().int().optional(),
    timedOut: z.boolean().optional(),
    failureCode: executorPreflightFailureCodeSchema.optional()
  })
  .strict();
export type ExecutorPreflightCheck = z.infer<typeof executorPreflightCheckSchema>;

const executorPreflightResultShape = {
  name: z.string(),
  adapter: z.union([executorIntegrationSchema, executorProfileAdapterSchema]).nullable(),
  profileAdapter: executorProfileAdapterSchema.nullable().optional(),
  executionIntegration: executorIntegrationSchema.nullable().optional(),
  agentId: agentFamilySchema.nullable().optional(),
  runnerKind: runnerTransportSchema.nullable().optional(),
  failureCode: executorPreflightFailureCodeSchema.nullable().optional(),
  agentInfo: executorAgentInfoSchema.nullable().optional(),
  authentication: runnerAuthenticationStateSchema.nullable().optional(),
  capabilities: z.array(runnerCapabilitySchema).max(32).nullable().optional(),
  sessionConfig: acpSessionConfigurationSchema.nullable().optional(),
  ok: z.boolean(),
  message: z.string(),
  checks: z.array(executorPreflightCheckSchema)
} as const;

/** Accepts the additive public contract, including source-compatible legacy values. */
export const executorPreflightResultSchema = z.object(executorPreflightResultShape).strict();
export type ExecutorPreflightResult = z.infer<typeof executorPreflightResultSchema>;

export const producedExecutorPreflightResultSchema = z
  .object({
    ...executorPreflightResultShape,
    profileAdapter: executorProfileAdapterSchema.nullable(),
    executionIntegration: executorIntegrationSchema.nullable(),
    agentId: agentFamilySchema.nullable(),
    runnerKind: runnerTransportSchema.nullable(),
    failureCode: executorPreflightFailureCodeSchema.nullable(),
    agentInfo: executorAgentInfoSchema.nullable(),
    authentication: runnerAuthenticationStateSchema.nullable(),
    capabilities: z.array(runnerCapabilitySchema).max(32).nullable(),
    sessionConfig: acpSessionConfigurationSchema.nullable()
  })
  .strict();
export type ProducedExecutorPreflightResult = z.infer<typeof producedExecutorPreflightResultSchema>;
