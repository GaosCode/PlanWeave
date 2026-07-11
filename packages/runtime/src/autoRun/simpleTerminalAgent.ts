import type {
  AgentCliExecutorProfile,
  ExecutorAdapterResult,
  ExecutorIntegrationName,
  PackageWorkspaceRef
} from "../types.js";
import type { BlockClaim, FeedbackClaim } from "./executorShared.js";
import type { CliProcessExecutor } from "./cliProcess.js";
import {
  runTerminalAgentProtocolBlock,
  runTerminalAgentProtocolFeedback,
  type ProtocolAdapter
} from "./terminalAgentExecutor.js";

/** Protocol preset for a terminal dialect that uses profile argv and has no session capture. */
export function simpleTerminalProtocol<Profile extends AgentCliExecutorProfile>(
  adapter: ExecutorIntegrationName
): ProtocolAdapter<Profile> {
  return {
    adapter,
    reviewResultMode: "result-file",
    buildInvocation({ profile, prompt }) {
      return { command: profile.command, args: profile.args, stdin: prompt };
    }
  };
}

export function runSimpleTerminalAgentBlock<Profile extends AgentCliExecutorProfile>(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: Profile;
  protocol: ProtocolAdapter<Profile>;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
  signal?: AbortSignal;
  executeProcess: CliProcessExecutor;
}): Promise<ExecutorAdapterResult> {
  return runTerminalAgentProtocolBlock(options);
}

export function runSimpleTerminalAgentFeedback<Profile extends AgentCliExecutorProfile>(options: {
  projectRoot: string;
  executionCwd: string;
  planweaveHome: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: Profile;
  protocol: ProtocolAdapter<Profile>;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
  signal?: AbortSignal;
  executeProcess: CliProcessExecutor;
}): Promise<ExecutorAdapterResult> {
  return runTerminalAgentProtocolFeedback(options);
}
