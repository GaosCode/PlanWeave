import type {
  AgentFamily,
  ExecutorIntegrationName,
  ExecutorProfileAdapter,
  RunnerTransport
} from "../types.js";

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
};
