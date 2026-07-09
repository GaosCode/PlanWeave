import type { ExecutorProfile } from "./executor.js";

export const supportedManifestVersion = "plan-package/v1" as const;

export const nodeTypes = ["task"] as const;

export const edgeTypes = ["depends_on"] as const;

export const blockTypes = ["implementation", "review"] as const;

export const reviewTriggerConditions = ["after_required_work_completed", "manual"] as const;

export type NodeType = (typeof nodeTypes)[number];
export type EdgeType = (typeof edgeTypes)[number];
export type BlockType = (typeof blockTypes)[number];

export type ReviewHookDefinition = {
  id: string;
  type: "executable";
  command: string;
  args: string[];
  executionPolicy: "trusted-local";
};

export type ReviewTriggerCondition = (typeof reviewTriggerConditions)[number];

export type BlockParallelPolicy = {
  /** @deprecated Use locks including "exclusive" instead of safe: false. */
  safe?: boolean;
  locks: string[];
};

export type ManifestImplementationBlock = {
  id: string;
  type: "implementation";
  title: string;
  prompt: string;
  depends_on: string[];
  executor?: string;
  parallel: BlockParallelPolicy;
};

export type ManifestReviewBlock = {
  id: string;
  type: "review";
  title: string;
  prompt: string;
  depends_on: string[];
  executor?: string;
  review: {
    required: boolean;
    maxFeedbackCycles: number;
    preset?: string;
    triggerCondition?: ReviewTriggerCondition;
    inputContext?: string;
    passCriteria?: string;
    feedbackFormat?: string;
    hook: ReviewHookDefinition | null;
  };
};

export type ManifestBlock = ManifestImplementationBlock | ManifestReviewBlock;

export type ManifestTaskNode = {
  id: string;
  type: "task";
  title: string;
  prompt: string;
  executor?: string;
  acceptance: string[];
  blocks: ManifestBlock[];
};

export type ManifestNode = ManifestTaskNode;

export type ManifestEdge = {
  from: string;
  to: string;
  type: EdgeType;
};

export type PlanPackageManifest = {
  version: typeof supportedManifestVersion;
  project: {
    title: string;
    description: string;
  };
  execution: {
    defaultExecutor?: string;
    parallel: {
      enabled: boolean;
      maxConcurrent: number;
    };
  };
  review: {
    maxFeedbackCycles: number;
    completionPolicy: "strict";
  };
  executors?: Record<string, ExecutorProfile>;
  nodes: ManifestNode[];
  edges: ManifestEdge[];
};
