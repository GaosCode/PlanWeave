import type { PiExecExecutorProfile } from "../types.js";
import { executorProfileMismatch } from "./executorIntegration.js";
import type { AgentDefinition } from "./agentRunner.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import {
  runSimpleTerminalAgentBlock,
  runSimpleTerminalAgentFeedback,
  simpleTerminalProtocol
} from "./simpleTerminalAgent.js";

const piProtocol = simpleTerminalProtocol<PiExecExecutorProfile>("pi-exec");

export const piAgentDefinition: AgentDefinition = {
  agent: "pi",
  builtinProfiles: {
    pi: {
      adapter: "agent",
      agent: "pi",
      runner: { transport: "cli" },
      command: "pi",
      args: ["-p"]
    },
    "pi-auto": {
      adapter: "agent",
      agent: "pi",
      runner: { transport: "cli" },
      command: "pi",
      args: ["-p"]
    },
    "pi-acp": {
      adapter: "agent",
      agent: "pi",
      runner: { transport: "acp" }
    }
  },
  cli: {
    integration: "pi-exec",
    runBlock(input, context) {
      if (input.profile.agent !== "pi") {
        throw executorProfileMismatch("pi-exec", input.profile);
      }
      return runSimpleTerminalAgentBlock({
        projectRoot: input.projectRoot,
        claim: input.claim,
        prompt: input.prompt,
        executorName: input.executorName,
        profile: input.profile,
        protocol: piProtocol,
        tmuxEnabled: input.runtime?.tmuxEnabled ?? input.profile.runner.tmuxEnabled,
        tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
        signal: input.runtime?.signal,
        executionWaveId: input.executionWaveId,
        executeProcess: context.executeProcess
      });
    },
    runFeedback(input, context) {
      if (input.profile.agent !== "pi") {
        throw executorProfileMismatch("pi-exec", input.profile);
      }
      return runSimpleTerminalAgentFeedback({
        projectRoot: input.workspace.rootPath,
        executionCwd: workspaceExecutionCwd(input.workspace),
        planweaveHome: input.workspace.planweaveHome,
        workspaceResultsDir: input.workspace.resultsDir,
        claim: input.claim,
        executorName: input.executorName,
        profile: input.profile,
        protocol: piProtocol,
        tmuxEnabled: input.runtime?.tmuxEnabled ?? input.profile.runner.tmuxEnabled,
        tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
        signal: input.runtime?.signal,
        executeProcess: context.executeProcess
      });
    }
  },
  acp: {
    launch: {
      command: "pi-acp",
      args: [],
      source: {
        registryId: "pi-acp",
        version: "0.0.31",
        url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
        descriptor: "pi-acp@0.0.31"
      }
    },
    capabilities: ["session", "prompt", "cancel", "streaming", "tool-updates"],
    optionalCapabilities: ["authentication", "image", "embedded-context", "session-close", "history-load"],
    limitations: ["Requires separately installed pi-acp and pi executables; filesystem and terminal delegation are not supported."]
  }
};
