import {
  adapterProfileMismatch,
  type ExecutorBlockInput,
  type ExecutorFeedbackInput,
  type ExecutorIntegration
} from "./executorIntegration.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import { runTerminalAgentBlock, runTerminalAgentFeedback } from "./terminalAgentExecutor.js";

export const claudeCodeIntegration: ExecutorIntegration = {
  adapter: "claude-code-exec",
  builtinProfiles: {
    "claude-code": { adapter: "claude-code-exec", command: "claude", args: ["-p"] },
    "claude-code-auto": { adapter: "claude-code-exec", command: "claude", args: ["-p"] }
  },
  runBlock(input: ExecutorBlockInput) {
    if (input.profile.adapter !== "claude-code-exec") {
      throw adapterProfileMismatch("claude-code-exec", input.profile);
    }
    return runTerminalAgentBlock({
      projectRoot: input.projectRoot,
      claim: input.claim,
      prompt: input.prompt,
      executorName: input.executorName,
      profile: input.profile,
      tmuxEnabled: input.runtime?.tmuxEnabled,
      tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId
    });
  },
  runFeedback(input: ExecutorFeedbackInput) {
    if (input.profile.adapter !== "claude-code-exec") {
      throw adapterProfileMismatch("claude-code-exec", input.profile);
    }
    return runTerminalAgentFeedback({
      projectRoot: input.workspace.rootPath,
      executionCwd: workspaceExecutionCwd(input.workspace),
      planweaveHome: input.workspace.planweaveHome,
      workspaceResultsDir: input.workspace.resultsDir,
      claim: input.claim,
      executorName: input.executorName,
      profile: input.profile,
      tmuxEnabled: input.runtime?.tmuxEnabled,
      tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId
    });
  }
};
