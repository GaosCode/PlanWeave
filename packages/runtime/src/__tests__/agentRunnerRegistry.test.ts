import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AgentAcpBlockInput } from "../autoRun/agentRunner.js";
import { createAcpRunner, type AcpPreflightProbeResult } from "../autoRun/acpRunner.js";
import {
  builtinAgentProfiles,
  registeredAgentDefinitions,
  resolveAgentDefinition
} from "../autoRun/agentRegistry.js";
import { createCodexExecAdapter, listExecutorProfilesForManifest } from "../autoRun/executors.js";
import { registeredAgentRunners, resolveAgentRunner } from "../autoRun/runnerRegistry.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

const acpFixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));

function probeDefinition(scenario: string, capabilities = ["session", "prompt", "cancel"] as const) {
  const base = resolveAgentDefinition("codex");
  return {
    ...base,
    acp: {
      ...base.acp,
      launch: { ...base.acp.launch!, command: process.execPath, args: [acpFixture, scenario] },
      capabilities
    }
  };
}

const CLI_INTEGRATION_PATTERN = /-exec$/;

const blockClaim = {
  kind: "block",
  ref: "T-001#B-001",
  taskId: "T-001",
  blockId: "B-001",
  blockType: "implementation",
  effectiveExecutor: "codex-acp"
} as const;

describe("AgentRunner registries", () => {
  it("keeps agent definitions independent from the two registered runner transports", () => {
    expect(registeredAgentDefinitions().map((definition) => definition.agent)).toEqual([
      "codex",
      "opencode",
      "claude-code",
      "pi"
    ]);
    expect(registeredAgentRunners().map((runner) => runner.transport)).toEqual(["cli", "acp"]);

    for (const definition of registeredAgentDefinitions()) {
      expect(definition.cli?.integration).toMatch(CLI_INTEGRATION_PATTERN);
      expect(definition.acp.launch).toMatchObject({
        command: expect.any(String),
        source: {
          registryId: expect.any(String),
          version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
          url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
          descriptor: expect.any(String)
        }
      });
      expect(definition.acp.capabilities).toEqual([
        "session", "prompt", "cancel", "streaming", "tool-updates"
      ]);
      expect(Object.values(definition.builtinProfiles)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ adapter: "agent", agent: definition.agent })
        ])
      );
    }
  });

  it("owns CLI and ACP built-in profiles in focused agent definitions", () => {
    expect(builtinAgentProfiles()).toMatchObject({
      codex: { agent: "codex", runner: { transport: "cli" }, command: "codex" },
      "codex-acp": { agent: "codex", runner: { transport: "acp" } },
      opencode: { agent: "opencode", runner: { transport: "cli" }, command: "opencode" },
      "opencode-acp": { agent: "opencode", runner: { transport: "acp" } },
      "claude-code": {
        agent: "claude-code",
        runner: { transport: "cli" },
        command: "claude"
      },
      "claude-code-acp": { agent: "claude-code", runner: { transport: "acp" } },
      pi: { agent: "pi", runner: { transport: "cli" }, command: "pi" },
      "pi-acp": { agent: "pi", runner: { transport: "acp" } }
    });
  });

  it("resolves agent and runner independently without CLI fallback", () => {
    const profile = {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    } as const;
    const definition = resolveAgentDefinition(profile.agent);
    const runner = resolveAgentRunner(profile);

    expect(definition.agent).toBe("codex");
    expect(runner.transport).toBe("acp");
    expect(runner.availability(definition)).toEqual({
      supported: true,
      integration: null,
      message: "ACP session integration for agent 'codex' is available."
    });
  });

  it.each([
    ["codex", "codex", "codex-acp"],
    ["opencode", "opencode", "opencode-acp"],
    ["claude-code", "claude-code", "claude-code-acp"],
    ["pi", "pi", "pi-acp"]
  ] as const)("selects explicit CLI and ACP profiles for %s", (agent, cliName, acpName) => {
    const profiles = builtinAgentProfiles();
    expect(profiles[cliName]).toMatchObject({ agent, runner: { transport: "cli" } });
    expect(profiles[acpName]).toMatchObject({ agent, runner: { transport: "acp" } });
    expect(resolveAgentRunner(profiles[cliName]!)).not.toBe(resolveAgentRunner(profiles[acpName]!));
  });

  it.each<{
    label: string;
    probe: AcpPreflightProbeResult | "hang";
    failureCode: string;
  }>([
    {
      label: "requires agent-owned authentication",
      probe: { kind: "auth_required", message: "Sign in with the selected agent." },
      failureCode: "auth_required"
    },
    {
      label: "rejects unsupported capabilities",
      probe: { kind: "ready", authenticated: true, capabilities: [] },
      failureCode: "unsupported_capability"
    },
    {
      label: "denies unsafe headless elicitation",
      probe: { kind: "interaction_required", interaction: "elicitation" },
      failureCode: "unsafe_interaction"
    },
    { label: "bounds initialize", probe: "hang", failureCode: "timeout" }
  ])("ACP preflight $label without CLI fallback", async ({ probe, failureCode }) => {
    const base = resolveAgentDefinition("codex");
    const definition = {
      ...base,
      acp: { launch: { command: "codex-acp", args: [] }, capabilities: ["session"] }
    };
    const runner = createAcpRunner({
      probe: async () => {
        if (probe === "hang") {
          return new Promise<AcpPreflightProbeResult>(() => undefined);
        }
        return probe;
      }
    });
    const result = await runner.preflight({
      profile: {
        adapter: "agent",
        agent: "codex",
        runner: { transport: "acp" }
      },
      definition,
      cwd: "/tmp",
      timeoutMs: 10
    });

    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed", failureCode })])
    );
    expect(result.executionIntegration).toBeNull();
    expect(result.negotiatedCapabilities).toBeNull();
  });

  it("produces negotiated capabilities from the shared Zod authority at the AgentRunner seam", async () => {
    const base = resolveAgentDefinition("codex");
    const definition = {
      ...base,
      acp: {
        launch: { command: "codex-acp", args: [] },
        capabilities: ["session", "prompt"] as const
      }
    };
    const runner = createAcpRunner({
      probe: async () => ({
        kind: "ready",
        authenticated: true,
        capabilities: ["session", "prompt", "event-replay"]
      })
    });
    const result = await runner.preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition,
      cwd: "/tmp",
      timeoutMs: 100
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "acp_capabilities", status: "passed" })
      ])
    );
    expect(result.negotiatedCapabilities).toEqual({
      version: "planweave.runner/v1",
      required: ["session", "prompt"],
      available: ["session", "prompt", "event-replay"],
      negotiated: ["session", "prompt"]
    });
  });

  it("uses the formal default probe for advertised capabilities and missing capability diagnostics", async () => {
    const ready = await createAcpRunner().preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition: probeDefinition("close-capable", ["session", "prompt", "cancel", "session-close"]),
      cwd: "/tmp",
      timeoutMs: 1_000
    });
    expect(ready.negotiatedCapabilities?.available).toEqual(
      expect.arrayContaining(["streaming", "tool-updates", "session-close"])
    );

    const missing = await createAcpRunner().preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition: probeDefinition("success", ["session", "prompt", "cancel", "session-close"]),
      cwd: "/tmp",
      timeoutMs: 1_000
    });
    expect(missing.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ failureCode: "unsupported_capability" })
    ]));
  });

  it("treats advertised authentication methods as capabilities rather than authentication state", async () => {
    const result = await createAcpRunner().preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition: probeDefinition("authenticated-with-auth-methods"),
      cwd: "/tmp",
      timeoutMs: 1_000
    });

    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "acp_authenticated", status: "passed" })
    ]));
    expect(result.negotiatedCapabilities).not.toBeNull();
  });

  it.each([
    ["auth-required", "auth_required", 1_000],
    ["generic-server-error", "initialization_failed", 1_000],
    ["delayed", "timeout", 5]
  ] as const)("maps formal default probe scenario %s to %s", async (scenario, code, timeoutMs) => {
    const result = await createAcpRunner().preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition: probeDefinition(scenario),
      cwd: "/tmp",
      timeoutMs
    });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", failureCode: code })
    ]));
  });

  it("refuses an untrusted default run before creating a process or run record", async () => {
    const { init } = await createTestWorkspace();
    const before = await readdir(init.workspace.resultsDir, { recursive: true });
    await expect(createAcpRunner().runBlock({
      projectRoot: init.workspace,
      claim: blockClaim,
      prompt: "must not spawn",
      executorName: "codex-acp",
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
    }, probeDefinition("artifact-implementation"))).rejects.toThrow("not trusted");
    expect(await readdir(init.workspace.resultsDir, { recursive: true })).toEqual(before);
  });

  it.each([
    { kind: "ready", authenticated: false, capabilities: ["session"] },
    { kind: "ready", capabilities: ["session"] },
    { kind: "ready", authenticated: true, capabilities: ["session", "session"] },
    { kind: "ready", authenticated: true, capabilities: ["unknown"] },
    { kind: "ready", authenticated: true, capabilities: ["session"], extra: true },
    { kind: "unknown", message: "Authorization: Bearer raw-probe-secret" }
  ])("fails closed for an untyped malformed ACP probe result: %j", async (malformed) => {
    const base = resolveAgentDefinition("codex");
    const definition = {
      ...base,
      acp: { launch: { command: "codex-acp", args: [] }, capabilities: ["session"] }
    };
    const runner = createAcpRunner({ probe: async () => malformed as never });
    const result = await runner.preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition,
      cwd: "/tmp",
      timeoutMs: 100
    });
    expect(result.negotiatedCapabilities).toBeNull();
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed" })])
    );
    expect(JSON.stringify(result)).not.toContain("raw-probe-secret");
  });

  it("rejects runner/profile mismatches before invoking an agent dialect", () => {
    const profile = {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    } as const;
    const cli = registeredAgentRunners().find((runner) => runner.transport === "cli");
    if (!cli) {
      throw new Error("Expected the CLI runner to be registered.");
    }
    const input: AgentAcpBlockInput = {
      projectRoot: "/tmp/agent-runner-contract",
      claim: blockClaim,
      prompt: "contract prompt",
      executorName: "codex-acp",
      profile
    };

    // @ts-expect-error Runtime guard protects JavaScript and other untyped boundary callers.
    expect(() => cli.runBlock(input, resolveAgentDefinition("codex"))).toThrow(
      "Agent runner 'cli' received profile adapter 'agent' with transport 'acp'."
    );
  });

  it("keeps package profile precedence and compatibility list output", () => {
    const manifest = manifestTestBuilder()
      .withExecutor("codex", {
        adapter: "agent",
        agent: "opencode",
        runner: { transport: "cli" },
        command: "custom-opencode",
        args: ["run", "-"]
      })
      .build();

    expect(listExecutorProfilesForManifest(manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "codex",
          source: "package",
          adapter: "opencode-exec",
          profileAdapter: "agent",
          executionIntegration: "opencode-exec",
          command: "custom-opencode"
        })
      ])
    );
  });

  it("lists versioned ACP launch metadata and honest static hints", () => {
    const summaries = listExecutorProfilesForManifest(manifestTestBuilder().build());
    expect(summaries.find((summary) => summary.name === "codex-acp")).toMatchObject({
      runnerKind: "acp",
      acpLaunch: {
        command: "codex-acp",
        source: { registryId: "codex-acp", version: "1.1.2" }
      },
      staticCapabilities: ["session", "prompt", "cancel", "streaming", "tool-updates"],
      optionalCapabilities: [
        "permission", "authentication", "image", "embedded-context", "session-close", "history-load"
      ]
    });
  });

  it("preserves legacy factory mismatch checks at the normalized profile boundary", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("custom-opencode", {
        adapter: "agent",
        agent: "opencode",
        runner: { transport: "cli" },
        command: "opencode",
        args: ["run", "-"]
      })
      .build();
    const { root } = await createTestWorkspace(manifest);
    const adapter = createCodexExecAdapter({ projectRoot: root, executorName: "custom-opencode" });

    await expect(
      adapter.runBlock({
        claim: { ...blockClaim, effectiveExecutor: "custom-opencode" },
        prompt: ""
      })
    ).rejects.toThrow(
      "Executor profile 'custom-opencode' uses integration 'opencode-exec', not 'codex-exec'."
    );
  });
});
