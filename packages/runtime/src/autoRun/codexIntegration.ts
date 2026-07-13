import { runCodexBlock, runCodexFeedback } from "./codexExecutor.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import type { AgentDefinition } from "./agentRunner.js";
import { executorProfileMismatch } from "./executorIntegration.js";

export const codexAgentDefinition: AgentDefinition = {
  agent: "codex",
  builtinProfiles: {
    codex: {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "cli" },
      command: "codex",
      args: ["exec", "-"]
    },
    "codex-auto": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "cli" },
      command: "codex",
      args: ["exec", "-"]
    },
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  },
  cli: {
    integration: "codex-exec",
    runBlock(input, context) {
      if (input.profile.agent !== "codex") {
        throw executorProfileMismatch("codex-exec", input.profile);
      }
      return runCodexBlock({
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
      if (input.profile.agent !== "codex") {
        throw executorProfileMismatch("codex-exec", input.profile);
      }
      return runCodexFeedback({
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
      command: "codex-acp",
      args: [],
      source: {
        registryId: "codex-acp",
        version: "1.1.2",
        url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
        descriptor: "@agentclientprotocol/codex-acp@1.1.2"
      }
    },
    capabilities: ["session", "prompt", "cancel", "streaming", "tool-updates"],
    optionalCapabilities: ["permission", "authentication", "image", "embedded-context", "session-close", "history-load"],
    limitations: ["Requires a separately installed codex-acp executable and agent-owned authentication."]
  }
};
