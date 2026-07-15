import type { GrokExecExecutorProfile } from "../types.js";
import { executorProfileMismatch } from "./executorIntegration.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import type { AgentDefinition } from "./agentRunner.js";
import {
  runSimpleTerminalAgentBlock,
  runSimpleTerminalAgentFeedback
} from "./simpleTerminalAgent.js";
import type { ProtocolAdapter } from "./terminalAgentExecutor.js";

const grokProtocol: ProtocolAdapter<GrokExecExecutorProfile> = {
  adapter: "grok-exec",
  reviewResultMode: "result-file",
  buildInvocation({ profile, promptPath }) {
    return {
      command: profile.command,
      args: [...profile.args, promptPath],
      stdin: ""
    };
  }
};

export const grokAgentDefinition: AgentDefinition = {
  agent: "grok",
  builtinProfiles: {
    grok: {
      adapter: "agent",
      agent: "grok",
      runner: { transport: "cli" },
      command: "grok",
      args: ["--no-auto-update", "--prompt-file"]
    },
    "grok-acp": {
      adapter: "agent",
      agent: "grok",
      runner: { transport: "acp" }
    }
  },
  cli: {
    integration: "grok-exec",
    runBlock(input, context) {
      if (input.profile.agent !== "grok") {
        throw executorProfileMismatch("grok-exec", input.profile);
      }
      return runSimpleTerminalAgentBlock({
        projectRoot: input.projectRoot,
        claim: input.claim,
        prompt: input.prompt,
        executorName: input.executorName,
        profile: input.profile,
        protocol: grokProtocol,
        tmuxEnabled: input.runtime?.tmuxEnabled ?? input.profile.runner.tmuxEnabled,
        tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
        signal: input.runtime?.signal,
        executionWaveId: input.executionWaveId,
        executeProcess: context.executeProcess
      });
    },
    runFeedback(input, context) {
      if (input.profile.agent !== "grok") {
        throw executorProfileMismatch("grok-exec", input.profile);
      }
      return runSimpleTerminalAgentFeedback({
        projectRoot: input.workspace.rootPath,
        executionCwd: workspaceExecutionCwd(input.workspace),
        planweaveHome: input.workspace.planweaveHome,
        workspaceResultsDir: input.workspace.resultsDir,
        claim: input.claim,
        executorName: input.executorName,
        profile: input.profile,
        protocol: grokProtocol,
        tmuxEnabled: input.runtime?.tmuxEnabled ?? input.profile.runner.tmuxEnabled,
        tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
        signal: input.runtime?.signal,
        executeProcess: context.executeProcess
      });
    }
  },
  acp: {
    launch: {
      command: "grok",
      args: ["--no-auto-update", "agent", "stdio"],
      source: {
        registryId: "xai-grok-cli",
        version: "0.2.101",
        url: "https://docs.x.ai/build/cli/headless-scripting",
        descriptor: "xAI Grok CLI 0.2.101: grok --no-auto-update agent stdio (verified 2026-07-15)"
      }
    },
    authentication: {
      preferredMethodIds: ["xai.api_key", "cached_token"],
      headlessSafeMethodIds: ["cached_token"]
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
      "The trusted launch was verified against xAI Grok CLI 0.2.101 help and xAI Headless & Scripting documentation on 2026-07-15.",
      "Interactive Grok authentication must be completed outside headless PlanWeave execution before retrying; ACP never falls back to the Grok CLI runner."
    ]
  }
};
