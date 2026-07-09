import type {
  DesktopReviewPipelineStepInput,
  DesktopUpdateReviewPipelineInput
} from "@planweave-ai/runtime";

export function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

export function parseNonNegativeIntegerInput(value: string): number {
  return normalizeNonNegativeInteger(Number(value));
}

function normalizeHookArgs(
  hook: DesktopReviewPipelineStepInput["hook"]
): DesktopReviewPipelineStepInput["hook"] {
  if (!hook) {
    return null;
  }
  return {
    ...hook,
    args: hook.args.filter((arg) => arg !== "")
  };
}

export function normalizeReviewPipelineDraft(
  input: DesktopUpdateReviewPipelineInput
): DesktopUpdateReviewPipelineInput {
  const normalized: DesktopUpdateReviewPipelineInput = {
    steps: input.steps.map((step) => ({
      ...step,
      maxFeedbackCycles: normalizeNonNegativeInteger(step.maxFeedbackCycles),
      hook: normalizeHookArgs(step.hook)
    }))
  };

  if (input.packageDefaults) {
    normalized.packageDefaults = {
      ...input.packageDefaults,
      maxFeedbackCycles: normalizeNonNegativeInteger(input.packageDefaults.maxFeedbackCycles)
    };
  }

  return normalized;
}
