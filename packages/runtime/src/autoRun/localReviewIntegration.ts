import { adapterProfileMismatch, type ExecutorBlockInput, type ExecutorFeedbackInput, type ExecutorIntegration } from "./executorIntegration.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import { runLocalReviewBlock, runLocalReviewFeedback } from "./localReviewExecutor.js";

export const localReviewIntegration: ExecutorIntegration = {
  adapter: "local-review",
  builtinProfiles: {},
  runBlock(input: ExecutorBlockInput) {
    if (input.profile.adapter !== "local-review") {
      throw adapterProfileMismatch("local-review", input.profile);
    }
    return runLocalReviewBlock({
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
    if (input.profile.adapter !== "local-review") {
      throw adapterProfileMismatch("local-review", input.profile);
    }
    return runLocalReviewFeedback({
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
