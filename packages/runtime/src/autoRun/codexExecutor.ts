import type {
  CodexExecExecutorProfile,
  ExecutorAdapterResult,
  PackageWorkspaceRef
} from "../types.js";
import { codexExecArgs, codexResumeArgs, extractCodexSessionId } from "./codexProtocol.js";
import type { BlockClaim, FeedbackClaim } from "./executorShared.js";
import {
  runTerminalAgentProtocolBlock,
  runTerminalAgentProtocolFeedback,
  type ProtocolAdapter
} from "./terminalAgentExecutor.js";

/** Codex protocol: sandbox argv, session capture, resume-on-failure, review via stdout JSON. */
export const codexProtocol: ProtocolAdapter<CodexExecExecutorProfile> = {
  adapter: "codex-exec",
  sessionMetadataKey: "codexSessionId",
  reviewResultMode: "stdout-json",
  usesReviewResultEnvironment: false,
  preparePrompt({ prompt }) {
    return prompt;
  },
  buildInvocation({ profile, prompt }) {
    return {
      command: profile.command,
      args: codexExecArgs(profile),
      stdin: prompt
    };
  },
  sessionIdFromOutput: extractCodexSessionId,
  buildResumeInvocation({ profile, sessionId }) {
    return {
      command: profile.command,
      args: codexResumeArgs(
        profile,
        sessionId,
        "continue this block and produce the required report"
      ),
      stdin: ""
    };
  },
  finishMetadata({ kind, profile, agentSessionId, resumed }) {
    if (kind === "feedback") {
      return {};
    }
    return {
      sandbox: profile.sandbox ?? null,
      role: profile.role ?? null,
      resumed
    };
  }
};

export async function runCodexBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: CodexExecExecutorProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  return runTerminalAgentProtocolBlock({ ...options, protocol: codexProtocol });
}

export async function runCodexFeedback(options: {
  projectRoot: string;
  executionCwd: string;
  planweaveHome: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: CodexExecExecutorProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  return runTerminalAgentProtocolFeedback({ ...options, protocol: codexProtocol });
}
