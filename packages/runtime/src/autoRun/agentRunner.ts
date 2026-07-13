import type {
  AgentCliExecutorProfile,
  AgentExecutorProfile,
  AgentFamily,
  ExecutorAdapterResult,
  ExecutorIntegrationName,
  ExecutorProfile,
  RunnerTransport
} from "../types.js";
import type { CliProcessExecutor } from "./cliProcess.js";
import type {
  AcpSessionConfiguration,
  ExecutorAgentInfo,
  ExecutorPreflightCheck
} from "./executorPreflightTypes.js";
import type {
  ExecutorBlockInput,
  ExecutorFeedbackInput,
  ExecutorRuntimeOptions
} from "./executorIntegration.js";
import type { NegotiatedCapabilities, RunnerCapability } from "./runnerContractSchemas.js";

type AgentAcpExecutorProfile = Extract<AgentExecutorProfile, { runner: { transport: "acp" } }>;

type AgentBlockInputBase = Omit<ExecutorBlockInput, "profile" | "runtime">;
type AgentFeedbackInputBase = Omit<ExecutorFeedbackInput, "profile" | "runtime">;

export type AgentCliBlockInput = AgentBlockInputBase & {
  profile: AgentCliExecutorProfile;
  runtime?: ExecutorRuntimeOptions;
};

export type AgentCliFeedbackInput = AgentFeedbackInputBase & {
  profile: AgentCliExecutorProfile;
  runtime?: ExecutorRuntimeOptions;
};

export type AgentAcpBlockInput = AgentBlockInputBase & {
  profile: AgentAcpExecutorProfile;
  runtime?: ExecutorRuntimeOptions;
};

export type AgentAcpFeedbackInput = AgentFeedbackInputBase & {
  profile: AgentAcpExecutorProfile;
  runtime?: ExecutorRuntimeOptions;
};

export type CliExecutionContext = {
  executeProcess: CliProcessExecutor;
};

export type AcpLaunchMetadata = {
  command: string;
  args: readonly string[];
  source: {
    registryId: string;
    version: string;
    url: string;
    descriptor: string;
  };
};

export type RunnerPreflightInput = {
  profile: AgentExecutorProfile;
  profileSource?: "builtin" | "package";
  definition: AgentDefinition;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type RunnerPreflightResult = {
  executionIntegration: ExecutorIntegrationName | null;
  checks: ExecutorPreflightCheck[];
  negotiatedCapabilities: NegotiatedCapabilities | null;
  agentInfo?: ExecutorAgentInfo | null;
  sessionConfig?: AcpSessionConfiguration | null;
};

export type AgentDefinition = {
  agent: AgentFamily;
  builtinProfiles: Readonly<Record<string, AgentExecutorProfile>>;
  cli: {
    integration: Exclude<ExecutorIntegrationName, "manual" | "local-review">;
    runBlock(
      input: AgentCliBlockInput,
      context: CliExecutionContext
    ): Promise<ExecutorAdapterResult>;
    runFeedback(
      input: AgentCliFeedbackInput,
      context: CliExecutionContext
    ): Promise<ExecutorAdapterResult>;
  } | null;
  acp: {
    launch: AcpLaunchMetadata | null;
    capabilities: readonly RunnerCapability[];
    optionalCapabilities: readonly RunnerCapability[];
    limitations: readonly string[];
  };
};

type AgentRunnerBase = {
  transport: RunnerTransport;
  availability(
    definition: AgentDefinition
  ):
    | { supported: true; integration: ExecutorIntegrationName | null; message: string }
    | { supported: false; integration: null; message: string };
  preflight(input: RunnerPreflightInput): Promise<RunnerPreflightResult>;
};

export type CliAgentRunner = AgentRunnerBase & {
  transport: "cli";
  runBlock(input: AgentCliBlockInput, definition: AgentDefinition): Promise<ExecutorAdapterResult>;
  runFeedback(
    input: AgentCliFeedbackInput,
    definition: AgentDefinition
  ): Promise<ExecutorAdapterResult>;
};

export type AcpAgentRunner = AgentRunnerBase & {
  transport: "acp";
  runBlock(input: AgentAcpBlockInput, definition: AgentDefinition): Promise<ExecutorAdapterResult>;
  runFeedback(
    input: AgentAcpFeedbackInput,
    definition: AgentDefinition
  ): Promise<ExecutorAdapterResult>;
};

export type AgentRunner = CliAgentRunner | AcpAgentRunner;

export function runnerProfileMismatch(transport: RunnerTransport, profile: ExecutorProfile): Error {
  let transportDetail = "";
  if (profile.adapter === "agent") {
    transportDetail = ` with transport '${profile.runner.transport}'`;
  }
  return new Error(
    `Agent runner '${transport}' received profile adapter '${profile.adapter}'${transportDetail}.`
  );
}
