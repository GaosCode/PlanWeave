import { executorProfileMismatch } from "./executorIntegration.js";
import type { AgentDefinition } from "./agentRunner.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import { runOpencodeBlock, runOpencodeFeedback } from "./opencodeExecutor.js";

export const opencodeAgentDefinition: AgentDefinition = {
  agent: "opencode",
  builtinProfiles: {
    opencode: {
      adapter: "agent",
      agent: "opencode",
      runner: { transport: "cli" },
      command: "opencode",
      args: ["run", "-"]
    },
    "opencode-acp": {
      adapter: "agent",
      agent: "opencode",
      runner: { transport: "acp" }
    }
  },
  cli: {
    integration: "opencode-exec",
    runBlock(input, context) {
      if (input.profile.agent !== "opencode") {
        throw executorProfileMismatch("opencode-exec", input.profile);
      }
      return runOpencodeBlock({
        projectRoot: input.projectRoot,
        claim: input.claim,
        prompt: input.prompt,
        executorName: input.executorName,
        profile: input.profile,
        tmuxEnabled: input.runtime?.tmuxEnabled ?? input.profile.runner.tmuxEnabled,
        tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
        signal: input.runtime?.signal,
        executionWaveId: input.executionWaveId,
        executeProcess: context.executeProcess
      });
    },
    runFeedback(input, context) {
      if (input.profile.agent !== "opencode") {
        throw executorProfileMismatch("opencode-exec", input.profile);
      }
      return runOpencodeFeedback({
        projectRoot: input.workspace.rootPath,
        executionCwd: workspaceExecutionCwd(input.workspace),
        planweaveHome: input.workspace.planweaveHome,
        workspaceResultsDir: input.workspace.resultsDir,
        claim: input.claim,
        executorName: input.executorName,
        profile: input.profile,
        tmuxEnabled: input.runtime?.tmuxEnabled ?? input.profile.runner.tmuxEnabled,
        tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
        signal: input.runtime?.signal,
        executeProcess: context.executeProcess
      });
    }
  },
  acp: {
    launch: {
      command: "opencode",
      args: ["acp"],
      source: {
        registryId: "opencode",
        version: "1.17.18",
        url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
        descriptor: "opencode v1.17.18 binary: opencode acp"
      }
    },
    capabilities: ["session", "prompt", "cancel", "streaming", "tool-updates"],
    optionalCapabilities: ["permission", "authentication", "image", "embedded-context", "session-close", "history-load"],
    limitations: ["Requires an installed OpenCode v1.17.18-compatible binary and agent-owned provider configuration."]
  }
};
