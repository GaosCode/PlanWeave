import { adapterProfileMismatch, type ExecutorBlockInput, type ExecutorFeedbackInput, type ExecutorIntegration } from "./executorIntegration.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import { runTerminalAgentBlock, runTerminalAgentFeedback } from "./terminalAgentExecutor.js";

export const piIntegration: ExecutorIntegration = {
  adapter: "pi-exec",
  builtinProfiles: {
    "pi-auto": { adapter: "pi-exec", command: "pi", args: ["-p"] }
  },
  runBlock(input: ExecutorBlockInput) {
    if (input.profile.adapter !== "pi-exec") {
      throw adapterProfileMismatch("pi-exec", input.profile);
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
    if (input.profile.adapter !== "pi-exec") {
      throw adapterProfileMismatch("pi-exec", input.profile);
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
