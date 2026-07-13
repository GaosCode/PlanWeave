import type {
  AgentFamily,
  ExecutorIntegrationName,
  ExecutorProfileAdapter,
  RunnerTransport
} from "../types.js";
import { z } from "zod";

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

const acpSessionTextSchema = z.string().max(4_096);
const acpSessionDescriptionSchema = acpSessionTextSchema.nullable();

export const acpSessionModeStateSchema = z
  .object({
    currentModeId: acpSessionTextSchema,
    availableModes: z
      .array(
        z
          .object({
            id: acpSessionTextSchema,
            name: acpSessionTextSchema,
            description: acpSessionDescriptionSchema
          })
          .strict()
      )
      .max(256)
  })
  .strict();

export const acpSessionConfigOptionSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: acpSessionTextSchema,
      type: z.literal("select"),
      name: acpSessionTextSchema,
      description: acpSessionDescriptionSchema,
      category: acpSessionTextSchema.nullable(),
      currentValue: acpSessionTextSchema,
      options: z
        .array(
          z
            .object({
              value: acpSessionTextSchema,
              name: acpSessionTextSchema,
              description: acpSessionDescriptionSchema,
              group: acpSessionTextSchema.nullable()
            })
            .strict()
        )
        .max(512)
    })
    .strict(),
  z
    .object({
      id: acpSessionTextSchema,
      type: z.literal("boolean"),
      name: acpSessionTextSchema,
      description: acpSessionDescriptionSchema,
      category: acpSessionTextSchema.nullable(),
      currentValue: z.boolean()
    })
    .strict()
]);

export const acpSessionConfigurationSchema = z
  .object({
    modes: acpSessionModeStateSchema.nullable(),
    configOptions: z.array(acpSessionConfigOptionSchema).max(256)
  })
  .strict();
export type AcpSessionConfiguration = z.infer<typeof acpSessionConfigurationSchema>;

export type ExecutorPreflightCheckName =
  | "profile_exists"
  | "adapter_supported"
  | "cwd_resolved"
  | "command_started"
  | "command_version"
  | "acp_initialized"
  | "acp_authenticated"
  | "acp_capabilities"
  | "interaction_policy";

export type ExecutorPreflightFailureCode =
  | "missing_command"
  | "invalid_profile"
  | "auth_required"
  | "unsupported_capability"
  | "initialization_failed"
  | "timeout"
  | "unsafe_interaction";

export function executorSpawnFailureCode(error: unknown): ExecutorPreflightFailureCode {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
    ? "missing_command"
    : "initialization_failed";
}

export type ExecutorPreflightCheckStatus = "passed" | "failed" | "skipped";

export type ExecutorPreflightCheck = {
  check: ExecutorPreflightCheckName;
  status: ExecutorPreflightCheckStatus;
  message: string;
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  timedOut?: boolean;
  failureCode?: ExecutorPreflightFailureCode;
};

export type ExecutorPreflightResult = {
  name: string;
  /** Compatibility field derived from executionIntegration, or profileAdapter for ACP. */
  adapter: ExecutorIntegrationName | ExecutorProfileAdapter | null;
  profileAdapter?: ExecutorProfileAdapter | null;
  executionIntegration?: ExecutorIntegrationName | null;
  agentId?: AgentFamily | null;
  runnerKind?: RunnerTransport | null;
  failureCode?: ExecutorPreflightFailureCode | null;
  agentInfo?: ExecutorAgentInfo | null;
  sessionConfig?: AcpSessionConfiguration | null;
  ok: boolean;
  message: string;
  checks: ExecutorPreflightCheck[];
};

export type ProducedExecutorPreflightResult = Omit<
  ExecutorPreflightResult,
  "profileAdapter" | "executionIntegration"
> & {
  profileAdapter: ExecutorProfileAdapter | null;
  executionIntegration: ExecutorIntegrationName | null;
  agentId: AgentFamily | null;
  runnerKind: RunnerTransport | null;
  failureCode: ExecutorPreflightFailureCode | null;
  agentInfo: ExecutorAgentInfo | null;
  sessionConfig: AcpSessionConfiguration | null;
};
