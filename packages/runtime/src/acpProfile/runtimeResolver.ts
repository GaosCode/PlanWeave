import type { AgentExecutorProfile, PackageWorkspaceRef } from "../types.js";
import { isCommandTrusted } from "../taskManager/hookTrustStore.js";
import {
  AgentEnvironmentMissingError,
  resolveCurrentAgentProcessEnvironment
} from "../process/agentProcessEnv.js";
import { AcpProfileStore } from "./store.js";
import {
  CatalogAcpProfileResolver,
  AcpProfileResolutionError,
  ExecutionHostAcpCommandResolver,
  type AcpProfileResolver,
  type ResolvedAcpProfile
} from "./resolver.js";

export type ResolvedAcpExecutionProfile = {
  readonly profile: ResolvedAcpProfile;
  readonly environment: {
    readonly env: Readonly<Record<string, string>>;
    readonly availableNames: readonly string[];
  };
};

export function createRuntimeAcpProfileResolver(
  store: Pick<AcpProfileStore, "read"> = new AcpProfileStore()
): CatalogAcpProfileResolver {
  return new CatalogAcpProfileResolver(
    store,
    new ExecutionHostAcpCommandResolver(),
    async ({ projectRoot, profile, resolvedCommand, fingerprint }) =>
      isCommandTrusted(projectRoot, resolvedCommand, [...profile.launch.args], {
        profileFingerprint: fingerprint
      })
  );
}

export async function resolveAcpExecutionProfile(options: {
  executorProfile: Extract<AgentExecutorProfile, { runner: { transport: "acp" } }>;
  projectRoot: PackageWorkspaceRef;
  executorSource: "builtin" | "package";
  resolver?: AcpProfileResolver;
}): Promise<ResolvedAcpExecutionProfile> {
  const host = options.executorProfile.host ?? { kind: "native" as const };
  const profile = await (options.resolver ?? createRuntimeAcpProfileResolver()).resolve(
    {
      agentId: options.executorProfile.agent,
      ...(options.executorProfile.runner.profileId
        ? { profileId: options.executorProfile.runner.profileId }
        : {})
    },
    {
      projectRoot: options.projectRoot,
      host,
      requireCommandTrust: options.executorSource === "package"
    }
  );
  let environment: ResolvedAcpExecutionProfile["environment"];
  try {
    environment = resolveCurrentAgentProcessEnvironment({ variables: profile.environment });
  } catch (error) {
    if (error instanceof AgentEnvironmentMissingError) {
      throw new AcpProfileResolutionError("profile_environment_missing", error.message, {
        cause: error
      });
    }
    throw error;
  }
  return { profile, environment };
}
