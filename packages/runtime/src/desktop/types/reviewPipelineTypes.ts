import type {
  ReviewHookDefinition,
  ReviewTriggerCondition
} from "../../types.js";

export type DesktopReviewPipelineStep = {
  blockRef: string;
  blockId: string;
  title: string;
  enabled: boolean;
  preset: string;
  triggerCondition: ReviewTriggerCondition;
  inputContext: string;
  passCriteria: string;
  feedbackFormat: string;
  maxFeedbackCycles: number;
  hook: ReviewHookDefinition | null;
  promptMarkdown: string;
};

export type DesktopReviewPipeline = {
  taskId: string;
  taskTitle: string;
  packageDefaults: {
    maxFeedbackCycles: number;
    completionPolicy: "strict";
  };
  steps: DesktopReviewPipelineStep[];
};

export type DesktopReviewPipelineStepInput = Omit<DesktopReviewPipelineStep, "blockRef"> & {
  blockRef?: string | null;
};

export type DesktopUpdateReviewPipelineInput = {
  packageDefaults?: {
    maxFeedbackCycles: number;
    completionPolicy: "strict";
  };
  steps: DesktopReviewPipelineStepInput[];
};
