export function acpProfileTestValues(launch: { command: string; args: readonly string[] }) {
  const testEnvironmentNames = ["PLANWEAVE_ACP_TEST_LIFECYCLE_FILE", "PLANWEAVE_T002_TEST_API_KEY"];
  const env = Object.fromEntries([
    ["PATH", process.env.PATH ?? ""],
    ...testEnvironmentNames.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]]
    )
  ]);
  return {
    profileIdentity: {
      profileId: "test-acp",
      fingerprint: "a".repeat(64),
      source: "local-user" as const,
      environmentNames: []
    },
    environment: {
      env,
      availableNames: Object.keys(env)
    },
    launch
  };
}

export function acpProfileResolverTestDouble(options: {
  launch: { command: string; args: readonly string[] };
  requiredCapabilities?: readonly RunnerCapability[];
  optionalCapabilities?: readonly RunnerCapability[];
  environment?: readonly { name: string; required: boolean }[];
}): AcpProfileResolver {
  return {
    async resolve(reference, context) {
      return {
        profileId: reference.profileId ?? "test-acp",
        agentId: reference.agentId,
        displayName: "Test ACP",
        host: context.host,
        launch: options.launch,
        environment: options.environment ?? [],
        shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1_000 },
        capabilities: {
          required: options.requiredCapabilities ?? ["session", "prompt"],
          optional: options.optionalCapabilities ?? []
        },
        connection: { mode: "dedicated" },
        source: "local-user",
        fingerprint: "a".repeat(64)
      };
    }
  };
}
import type { RunnerCapability } from "../../autoRun/runnerContractSchemas.js";
import type { AcpProfileResolver } from "../../acpProfile/resolver.js";
