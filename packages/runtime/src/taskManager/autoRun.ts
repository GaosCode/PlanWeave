import { claimNext, renderPrompt, submitBlockResult, submitFeedback, submitReviewResult } from "./index.js";
import type { AutoRunStepResult, ExecutionGraphSession, ExecutorAdapter } from "../types.js";

export async function runAutoRunStep(options: {
  projectRoot: string;
  executor: ExecutorAdapter;
  session?: ExecutionGraphSession;
}): Promise<AutoRunStepResult> {
  const claim = await claimNext({ projectRoot: options.projectRoot, session: options.session });
  if (claim.kind === "none") {
    return { kind: "idle", claim };
  }
  if (claim.kind === "blocked") {
    return { kind: "blocked", claim };
  }
  if (claim.kind === "batch") {
    return { kind: "batch", claim };
  }
  if (claim.kind === "feedback") {
    const adapterResult = await options.executor.runFeedback({ claim });
    if (adapterResult.kind !== "feedback") {
      throw new Error("Executor adapter must return a feedback report for feedback claims.");
    }
    const submitResult = await submitFeedback({
      projectRoot: options.projectRoot,
      reportPath: adapterResult.reportPath,
      session: options.session
    });
    return { kind: "submitted", claim, adapterResult, submitResult };
  }

  const prompt = await renderPrompt({ projectRoot: options.projectRoot, ref: claim.ref, session: options.session });
  const adapterResult = await options.executor.runBlock({ claim, prompt });
  if (claim.blockType === "review") {
    if (adapterResult.kind !== "review") {
      throw new Error("Executor adapter must return a review result for review block claims.");
    }
    const submitResult = await submitReviewResult({
      projectRoot: options.projectRoot,
      ref: claim.ref,
      resultPath: adapterResult.resultPath,
      session: options.session
    });
    return { kind: "submitted", claim, adapterResult, submitResult };
  }
  if (adapterResult.kind !== "block") {
    throw new Error("Executor adapter must return a block report for implementation/check block claims.");
  }
  const submitResult = await submitBlockResult({
    projectRoot: options.projectRoot,
    ref: claim.ref,
    reportPath: adapterResult.reportPath,
    session: options.session
  });
  return { kind: "submitted", claim, adapterResult, submitResult };
}
