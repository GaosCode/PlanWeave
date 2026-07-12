import type {
  ExecutorAdapterResult,
  ExecutorIntegrationName,
  ExecutorProfile,
  PackageWorkspaceRef,
  ProjectWorkspace
} from "../types.js";
import type { BlockClaim, FeedbackClaim } from "./executorShared.js";
import type { RunnerInteractionBroker } from "./liveControl.js";

export type ExecutorRuntimeOptions = {
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
  signal?: AbortSignal;
  cliSignal?: AbortSignal;
  timeoutMs?: number;
  desktopRunId?: string;
  runSessionId?: string;
  interactionBroker?: RunnerInteractionBroker;
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

export type DirectExecutor = {
  adapter: Extract<ExecutorIntegrationName, "manual" | "local-review">;
  builtinProfiles: Record<string, ExecutorProfile>;
  runBlock(input: ExecutorBlockInput): Promise<ExecutorAdapterResult>;
  runFeedback(input: ExecutorFeedbackInput): Promise<ExecutorAdapterResult>;
};

export function executorProfileMismatch(
  adapter: ExecutorIntegrationName,
  profile: ExecutorProfile
): Error {
  return new Error(
    `Executor integration '${adapter}' received profile adapter '${profile.adapter}'.`
  );
}
