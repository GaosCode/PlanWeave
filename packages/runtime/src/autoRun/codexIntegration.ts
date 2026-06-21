import { runCodexBlock, runCodexFeedback } from "./codexExecutor.js";
import { workspaceExecutionCwd } from "./executorShared.js";
import { adapterProfileMismatch, type ExecutorBlockInput, type ExecutorFeedbackInput, type ExecutorIntegration } from "./executorIntegration.js";

export const codexIntegration: ExecutorIntegration = {
  adapter: "codex-exec",
  builtinProfiles: {
    "codex-auto": { adapter: "codex-exec", command: "codex", args: ["exec", "-"] },
    "codex-reviewer": { adapter: "codex-exec", command: "codex", args: ["exec", "-"], role: "reviewer" }
  },
  runBlock(input: ExecutorBlockInput) {
    if (input.profile.adapter !== "codex-exec") {
      throw adapterProfileMismatch("codex-exec", input.profile);
    }
    return runCodexBlock({
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
    if (input.profile.adapter !== "codex-exec") {
      throw adapterProfileMismatch("codex-exec", input.profile);
    }
    return runCodexFeedback({
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
