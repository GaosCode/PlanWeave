import type { ClaudeCodeExecExecutorProfile } from "../types.js";
import { executorProfileMismatch } from "./executorIntegration.js";
import type { AgentDefinition } from "./agentRunner.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import {
  runSimpleTerminalAgentBlock,
  runSimpleTerminalAgentFeedback,
  simpleTerminalProtocol
} from "./simpleTerminalAgent.js";

const claudeCodeProtocol =
  simpleTerminalProtocol<ClaudeCodeExecExecutorProfile>("claude-code-exec");

export const claudeCodeAgentDefinition: AgentDefinition = {
  agent: "claude-code",
  builtinProfiles: {
    "claude-code": {
      adapter: "agent",
      agent: "claude-code",
      runner: { transport: "cli" },
      command: "claude",
      args: ["-p"]
    },
    "claude-code-auto": {
      adapter: "agent",
      agent: "claude-code",
      runner: { transport: "cli" },
      command: "claude",
      args: ["-p"]
    },
    "claude-code-acp": {
      adapter: "agent",
      agent: "claude-code",
      runner: { transport: "acp" }
    }
  },
  cli: {
    integration: "claude-code-exec",
    runBlock(input, context) {
      if (input.profile.agent !== "claude-code") {
        throw executorProfileMismatch("claude-code-exec", input.profile);
      }
      return runSimpleTerminalAgentBlock({
        projectRoot: input.projectRoot,
        claim: input.claim,
        prompt: input.prompt,
        executorName: input.executorName,
        profile: input.profile,
        protocol: claudeCodeProtocol,
        tmuxEnabled: input.runtime?.tmuxEnabled ?? input.profile.runner.tmuxEnabled,
        tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
        signal: input.runtime?.signal,
        executionWaveId: input.executionWaveId,
        executeProcess: context.executeProcess
      });
    },
    runFeedback(input, context) {
      if (input.profile.agent !== "claude-code") {
        throw executorProfileMismatch("claude-code-exec", input.profile);
      }
      return runSimpleTerminalAgentFeedback({
        projectRoot: input.workspace.rootPath,
        executionCwd: workspaceExecutionCwd(input.workspace),
        planweaveHome: input.workspace.planweaveHome,
        workspaceResultsDir: input.workspace.resultsDir,
        claim: input.claim,
        executorName: input.executorName,
        profile: input.profile,
        protocol: claudeCodeProtocol,
        tmuxEnabled: input.runtime?.tmuxEnabled ?? input.profile.runner.tmuxEnabled,
        tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
        signal: input.runtime?.signal,
        executeProcess: context.executeProcess
      });
    }
  },
  acp: {
    launch: {
      command: "claude-agent-acp",
      args: [],
      source: {
        registryId: "claude-acp",
        version: "0.58.1",
        url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
        descriptor: "@agentclientprotocol/claude-agent-acp@0.58.1"
      }
    },
    capabilities: ["session", "prompt", "cancel", "streaming", "tool-updates"],
    optionalCapabilities: [
      "permission",
      "authentication",
      "image",
      "embedded-context",
      "session-close",
      "history-load"
    ],
    limitations: [
      "Requires a separately installed claude-agent-acp executable and agent-owned authentication."
    ]
  }
};
