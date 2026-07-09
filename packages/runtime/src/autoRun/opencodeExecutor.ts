import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecutorAdapterResult,
  OpencodeExecExecutorProfile,
  PackageWorkspaceRef
} from "../types.js";
import {
  executorLimitFailureMessage,
  type BlockClaim,
  type FeedbackClaim
} from "./executorShared.js";
import { opencodeInvocation } from "./opencodeInvocation.js";
import {
  extractOpencodeSessionId,
  formatOpencodeErrorOutput,
  opencodeReport,
  parseOpencodeJsonOutput
} from "./opencodeOutput.js";
import {
  runTerminalAgentProtocolBlock,
  runTerminalAgentProtocolFeedback,
  type ProtocolAdapter
} from "./terminalAgentExecutor.js";

/** OpenCode protocol: invocation rewriting, JSON events, structured errors, review result file. */
export const opencodeProtocol: ProtocolAdapter<OpencodeExecExecutorProfile> = {
  adapter: "opencode-exec",
  sessionMetadataKey: "opencodeSessionId",
  reviewResultMode: "result-file",
  buildInvocation({ profile, prompt, executionCwd }) {
    const invocation = opencodeInvocation(profile, prompt, executionCwd);
    return {
      command: profile.command,
      args: invocation.args,
      stdin: invocation.stdin,
      sessionId: invocation.sessionId,
      jsonMode: invocation.jsonMode
    };
  },
  sessionIdFromOutput: extractOpencodeSessionId,
  formatFailureMessage({ executorName, result, limits }) {
    if (result.limitExceeded) {
      return executorLimitFailureMessage({ executorName, limitExceeded: result.limitExceeded });
    }
    const opencodeError = formatOpencodeErrorOutput(result.stdout, result.stderr);
    if (opencodeError) {
      return `Executor '${executorName}' failed: ${opencodeError}`;
    }
    return result.timedOut
      ? `Executor '${executorName}' timed out after ${limits.timeoutMs}ms.`
      : result.stderr.trim() || `Executor '${executorName}' exited with code ${result.exitCode}.`;
  },
  async interpretResult({ executorName, result, invocation, runDir, agentSessionId }) {
    const jsonOutput = parseOpencodeJsonOutput(result.stdout);
    const nextSessionId =
      agentSessionId ??
      jsonOutput.sessionId ??
      extractOpencodeSessionId(`${result.stdout}\n${result.stderr}`);
    if (jsonOutput.parsedAny || invocation.jsonMode) {
      await writeFile(join(runDir, "events.ndjson"), result.stdout, "utf8");
    }
    const structuredError =
      formatOpencodeErrorOutput(result.stdout, result.stderr) ?? jsonOutput.error;
    return {
      agentSessionId: nextSessionId,
      successFailureReason: structuredError
        ? `Executor '${executorName}' returned an OpenCode error event: ${structuredError}`
        : null,
      reportContent: opencodeReport(jsonOutput, result.stdout, result.stderr, nextSessionId)
    };
  },
  finishMetadata({ kind, profile, failureReason }) {
    if (kind === "feedback") {
      return { failureReason };
    }
    return {
      sandbox: profile.sandbox ?? null,
      resumed: false,
      failureReason
    };
  }
};

export async function runOpencodeBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: OpencodeExecExecutorProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  return runTerminalAgentProtocolBlock({ ...options, protocol: opencodeProtocol });
}

export async function runOpencodeFeedback(options: {
  projectRoot: string;
  executionCwd: string;
  planweaveHome: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: OpencodeExecExecutorProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  return runTerminalAgentProtocolFeedback({ ...options, protocol: opencodeProtocol });
}
