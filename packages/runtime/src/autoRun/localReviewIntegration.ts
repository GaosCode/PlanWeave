import {
  executorProfileMismatch,
  type DirectExecutor,
  type ExecutorBlockInput,
  type ExecutorFeedbackInput
} from "./executorIntegration.js";
import { executeCliProcess } from "./cliProcess.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import { runLocalReviewBlock, runLocalReviewFeedback } from "./localReviewExecutor.js";

export const localReviewExecutor: DirectExecutor = {
  adapter: "local-review",
  builtinProfiles: {},
  runBlock(input: ExecutorBlockInput) {
    if (input.profile.adapter !== "local-review") {
      throw executorProfileMismatch("local-review", input.profile);
    }
    return runLocalReviewBlock({
      projectRoot: input.projectRoot,
      claim: input.claim,
      prompt: input.prompt,
      executorName: input.executorName,
      profile: input.profile,
      tmuxEnabled: input.runtime?.tmuxEnabled,
      tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
      signal: input.runtime?.signal,
      executeProcess: executeCliProcess
    });
  },
  runFeedback(input: ExecutorFeedbackInput) {
    if (input.profile.adapter !== "local-review") {
      throw executorProfileMismatch("local-review", input.profile);
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
      tmuxOwnerRunId: input.runtime?.tmuxOwnerRunId,
      signal: input.runtime?.signal,
      executeProcess: executeCliProcess
    });
  }
};
