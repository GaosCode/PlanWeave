import { resolvePackageWorkspace } from "../package/loadPackage.js";
import { withExecutorResultsWriteLease } from "./executorResultsLifecycle.js";
import type { ExecutorIntegrationName, ExecutorProfile } from "../types.js";
import { agentFamilySchema } from "../types.js";
import {
  builtinAgentProfiles,
  acpAgentDefinition,
  registeredAgentDefinitions,
  resolveAgentDefinition
} from "./agentRegistry.js";
import type {
  DirectExecutor,
  ExecutorBlockInput,
  ExecutorFeedbackInput
} from "./executorIntegration.js";
import { localReviewExecutor } from "./localReviewIntegration.js";
import { manualExecutor } from "./manualExecutor.js";
import { resolveAgentRunner } from "./runnerRegistry.js";

const directExecutors = {
  manual: manualExecutor,
  "local-review": localReviewExecutor
} as const satisfies Record<"manual" | "local-review", DirectExecutor>;

export const builtinExecutorProfiles: Record<string, ExecutorProfile> = {
  ...directExecutors.manual.builtinProfiles,
  ...directExecutors["local-review"].builtinProfiles,
  ...builtinAgentProfiles()
};

export function isBuiltinExecutorProfileName(name: string): boolean {
  return Object.hasOwn(builtinExecutorProfiles, name);
}

export function isSupportedExecutionIntegration(name: ExecutorIntegrationName): boolean {
  if (name === "manual" || name === "local-review") {
    return true;
  }
  return registeredAgentDefinitions().some((definition) => definition.cli?.integration === name);
}

function directExecutorForProfile(profile: ExecutorProfile): DirectExecutor {
  if (profile.adapter === "manual") {
    return directExecutors.manual;
  }
  if (profile.adapter === "local-review") {
    return directExecutors["local-review"];
  }
  throw new Error(`Agent profile '${profile.agent}' must be routed through AgentRunner.`);
}

export async function runProfileBlock(input: ExecutorBlockInput) {
  const workspace =
    input.executionSnapshot?.workspace ?? (await resolvePackageWorkspace(input.projectRoot));
  return withExecutorResultsWriteLease(workspace, `block:${input.claim.ref}`, () =>
    runProfileBlockWithLease({ ...input, projectRoot: workspace })
  );
}

function runProfileBlockWithLease(input: ExecutorBlockInput) {
  if (input.profile.adapter === "agent") {
    const definition =
      input.profile.runner.transport === "acp"
        ? acpAgentDefinition(input.profile.agent)
        : resolveAgentDefinition(agentFamilySchema.parse(input.profile.agent));
    if ("command" in input.profile) {
      const runtime = input.runtime?.desktopRunId
        ? { ...input.runtime, signal: input.runtime.cliSignal }
        : input.runtime;
      return resolveAgentRunner(input.profile).runBlock(
        { ...input, profile: input.profile, runtime },
        definition
      );
    }
    return resolveAgentRunner(input.profile).runBlock(
      {
        projectRoot: input.projectRoot,
        claim: input.claim,
        prompt: input.prompt,
        executorName: input.executorName,
        profile: input.profile,
        profileSource: input.profileSource,
        executionWaveId: input.executionWaveId,
        executionSnapshot: input.executionSnapshot,
        runtime: input.runtime
      },
      definition
    );
  }
  return directExecutorForProfile(input.profile).runBlock(input);
}

export function runProfileFeedback(input: ExecutorFeedbackInput) {
  return withExecutorResultsWriteLease(input.workspace, `feedback:${input.claim.feedbackId}`, () =>
    runProfileFeedbackWithLease(input)
  );
}

function runProfileFeedbackWithLease(input: ExecutorFeedbackInput) {
  if (input.profile.adapter === "agent") {
    const definition =
      input.profile.runner.transport === "acp"
        ? acpAgentDefinition(input.profile.agent)
        : resolveAgentDefinition(agentFamilySchema.parse(input.profile.agent));
    if ("command" in input.profile) {
      const runtime = input.runtime?.desktopRunId
        ? { ...input.runtime, signal: input.runtime.cliSignal }
        : input.runtime;
      return resolveAgentRunner(input.profile).runFeedback(
        { ...input, profile: input.profile, runtime },
        definition
      );
    }
    return resolveAgentRunner(input.profile).runFeedback(
      {
        projectRoot: input.projectRoot,
        workspace: input.workspace,
        claim: input.claim,
        executorName: input.executorName,
        profile: input.profile,
        profileSource: input.profileSource,
        runtime: input.runtime
      },
      definition
    );
  }
  return directExecutorForProfile(input.profile).runFeedback(input);
}
