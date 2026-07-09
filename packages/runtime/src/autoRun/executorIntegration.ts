import type {
  ExecutorAdapterResult,
  ExecutorProfile,
  PackageWorkspaceRef,
  ProjectWorkspace
} from "../types.js";
import type { BlockClaim, FeedbackClaim } from "./executorShared.js";

export type ExecutorRuntimeOptions = {
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
};

export type ExecutorBlockInput = {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: ExecutorProfile;
  runtime?: ExecutorRuntimeOptions;
};

export type ExecutorFeedbackInput = {
  projectRoot: PackageWorkspaceRef;
  workspace: ProjectWorkspace;
  claim: FeedbackClaim;
  executorName: string;
  profile: ExecutorProfile;
  runtime?: ExecutorRuntimeOptions;
};

export type ExecutorIntegration = {
  adapter: ExecutorProfile["adapter"];
  builtinProfiles: Record<string, ExecutorProfile>;
  runBlock(input: ExecutorBlockInput): Promise<ExecutorAdapterResult>;
  runFeedback(input: ExecutorFeedbackInput): Promise<ExecutorAdapterResult>;
};

export function adapterProfileMismatch(
  adapter: ExecutorProfile["adapter"],
  profile: ExecutorProfile
): Error {
  return new Error(
    `Executor integration '${adapter}' received profile adapter '${profile.adapter}'.`
  );
}
