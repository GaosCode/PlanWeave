import { adapterProfileMismatch, type ExecutorBlockInput, type ExecutorFeedbackInput, type ExecutorIntegration } from "./executorIntegration.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import { runOpencodeBlock, runOpencodeFeedback } from "./opencodeExecutor.js";

export const opencodeIntegration: ExecutorIntegration = {
  adapter: "opencode-exec",
  builtinProfiles: {},
  runBlock(input: ExecutorBlockInput) {
    if (input.profile.adapter !== "opencode-exec") {
      throw adapterProfileMismatch("opencode-exec", input.profile);
    }
    return runOpencodeBlock({
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
    if (input.profile.adapter !== "opencode-exec") {
      throw adapterProfileMismatch("opencode-exec", input.profile);
    }
    return runOpencodeFeedback({
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
