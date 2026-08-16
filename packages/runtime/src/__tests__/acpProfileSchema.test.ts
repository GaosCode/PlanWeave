import { describe, expect, it } from "vitest";
import {
  acpProfileCatalogSchema,
  acpProfileDescriptorSchema,
  acpShutdownPolicyFromLegacyGraceMs,
  acpShutdownPolicySchema,
  agentEnvironmentContractSchema
} from "../acpProfile/schema.js";

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    version: "planweave.acp-profile/v1",
    id: "custom-acp",
    agentId: "custom-agent",
    displayName: "Custom Agent",
    host: { kind: "native" },
    launch: { command: "/opt/custom/bin/custom-acp", args: ["serve"] },
    environment: [{ name: "CUSTOM_API_KEY", required: true }],
    sessionDefaults: { modeId: null, configOptions: {} },
    shutdown: { eofDrainMs: 100, terminateGraceMs: 200, cleanupDeadlineMs: 1_000 },
    capabilities: { required: ["session", "prompt"], optional: ["cancel"] },
    connection: { mode: "dedicated" },
    ...overrides
  };
}

describe("ACP profile schemas", () => {
  it("parses a strict versioned dedicated descriptor and WSL host identity", () => {
    expect(acpProfileDescriptorSchema.parse(descriptor())).toMatchObject({
      version: "planweave.acp-profile/v1",
      connection: { mode: "dedicated" }
    });
    expect(
      acpProfileDescriptorSchema.parse(
        descriptor({ host: { kind: "wsl", distribution: "Ubuntu-24.04" } })
      ).host
    ).toEqual({ kind: "wsl", distribution: "Ubuntu-24.04" });
    expect(acpProfileDescriptorSchema.parse(descriptor({ id: "Custom-ACP" })).id).toBe(
      "custom-acp"
    );
    expect(() =>
      acpProfileDescriptorSchema.parse(
        descriptor({ host: { kind: "wsl", distribution: "Ubuntu\0injected" } })
      )
    ).toThrow("NUL");
  });

  it("rejects shared-project before the F0/F2 gate and rejects persisted secret values", () => {
    expect(() =>
      acpProfileDescriptorSchema.parse(descriptor({ connection: { mode: "shared-project" } }))
    ).toThrow();
    const credentialProfiles = [
      ...["--api-key", "--api-key-value", "--auth-token-raw", "--client-secret-data"].map((flag) =>
        descriptor({
          launch: { command: "/opt/custom/bin/custom-acp", args: [`${flag}=token-marker`] }
        })
      ),
      ...["OPENAI_API_KEY", "OPENAI_API_KEY_VALUE", "AUTH_TOKEN_RAW", "CLIENT_SECRET_DATA"].map(
        (key) =>
          descriptor({
            sessionDefaults: { modeId: null, configOptions: { [key]: "token-marker" } }
          })
      )
    ];
    for (const profile of credentialProfiles) {
      try {
        acpProfileDescriptorSchema.parse(profile);
        throw new Error("credential-like profile unexpectedly parsed");
      } catch (error) {
        expect(String(error)).toContain("credentials");
        expect(String(error)).not.toContain("token-marker");
      }
    }
    expect(() =>
      acpProfileDescriptorSchema.parse({
        ...descriptor(),
        environment: [{ name: "CUSTOM_API_KEY", required: true, value: "secret" }]
      })
    ).toThrow();
    expect(
      acpProfileDescriptorSchema.parse(
        descriptor({
          launch: {
            command: "/opt/custom/bin/custom-acp",
            args: ["--max-tokens=2048", "--tokenBudget=4096"]
          },
          sessionDefaults: {
            modeId: null,
            configOptions: { maxTokens: "2048", tokenBudget: "4096" }
          }
        })
      )
    ).toBeDefined();
  });

  it("rejects invalid launch, environment, capability, and catalog identities", () => {
    expect(() =>
      acpProfileDescriptorSchema.parse(
        descriptor({ launch: { command: "bad\0command", args: [] } })
      )
    ).toThrow();
    for (const name of [
      "PATH",
      "NODE_OPTIONS",
      "NODE_PATH",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "PYTHONPATH",
      "PYTHONHOME",
      "RUBYOPT",
      "RUBYLIB",
      "PERL5OPT",
      "PERL5LIB",
      "JAVA_TOOL_OPTIONS",
      "JDK_JAVA_OPTIONS",
      "DOTNET_STARTUP_HOOKS"
    ]) {
      expect(() =>
        acpProfileDescriptorSchema.parse({
          ...descriptor(),
          environment: [{ name, required: false }]
        })
      ).toThrow();
    }
    expect(() =>
      acpProfileDescriptorSchema.parse({
        ...descriptor(),
        capabilities: { required: ["session"], optional: ["session"] }
      })
    ).toThrow();
    expect(() =>
      acpProfileCatalogSchema.parse({
        version: "planweave.acp-profile-catalog/v1",
        revision: 0,
        profiles: [descriptor(), descriptor({ id: "CUSTOM-ACP" })]
      })
    ).toThrow();
  });

  it("enforces bounded shutdown stages and provides a legacy compatibility adapter", () => {
    expect(acpShutdownPolicyFromLegacyGraceMs()).toEqual({
      eofDrainMs: 100,
      terminateGraceMs: 100,
      cleanupDeadlineMs: 1_000
    });
    expect(() =>
      acpShutdownPolicySchema.parse({
        eofDrainMs: 600,
        terminateGraceMs: 600,
        cleanupDeadlineMs: 1_000
      })
    ).toThrow("cover");
    expect(() => acpShutdownPolicyFromLegacyGraceMs(0)).toThrow();
  });

  it("keeps the environment contract name-only and unique", () => {
    expect(
      agentEnvironmentContractSchema.parse({
        variables: [
          { name: "CUSTOM_API_KEY", required: true },
          { name: "OPTIONAL_FLAG", required: false }
        ]
      })
    ).toBeDefined();
    expect(() =>
      agentEnvironmentContractSchema.parse({
        variables: [
          { name: "CUSTOM_API_KEY", required: true },
          { name: "CUSTOM_API_KEY", required: false }
        ]
      })
    ).toThrow("unique");
  });
});
