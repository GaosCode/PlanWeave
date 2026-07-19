import { describe, expect, it } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAcpBlockInput } from "../autoRun/agentRunner.js";
import { createAcpRunner, type AcpPreflightProbeResult } from "../autoRun/acpRunner.js";
import { assertAcpLaunchTrusted } from "../autoRun/acpLaunch.js";
import {
  builtinAgentProfiles,
  registeredAgentDefinitions,
  resolveAgentDefinition
} from "../autoRun/agentRegistry.js";
import { createCodexExecAdapter, listExecutorProfilesForManifest } from "../autoRun/executors.js";
import { registeredAgentRunners, resolveAgentRunner } from "../autoRun/runnerRegistry.js";
import { executorProfileSchema, type AgentFamily } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

const acpFixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const mockAgentInfo = { name: "planweave-acp-mock", version: "1.0.0" } as const;
const notAdvertisedAuthentication = { status: "not_advertised" } as const;

function probeDefinition(
  scenario: string,
  capabilities = ["session", "prompt", "cancel"] as const,
  agent: AgentFamily = "codex"
) {
  const base = resolveAgentDefinition(agent);
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
      "pi",
      "grok"
    ]);
    expect(registeredAgentRunners().map((runner) => runner.transport)).toEqual(["cli", "acp"]);

    for (const definition of registeredAgentDefinitions()) {
      if (definition.cli) {
        expect(definition.cli.integration).toMatch(CLI_INTEGRATION_PATTERN);
      }
      expect(definition.acp.launch).toMatchObject({
        command: expect.any(String),
        source: {
          registryId: expect.any(String),
          version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
          url: expect.stringMatching(/^https:\/\//),
          descriptor: expect.any(String)
        }
      });
      expect(definition.acp.capabilities).toEqual([
        "session",
        "prompt",
        "cancel",
        "streaming",
        "tool-updates"
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
      "pi-acp": { agent: "pi", runner: { transport: "acp" } },
      grok: { agent: "grok", runner: { transport: "cli" }, command: "grok" },
      "grok-acp": { agent: "grok", runner: { transport: "acp" } }
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
    ["pi", "pi", "pi-acp"],
    ["grok", "grok", "grok-acp"]
  ] as const)("selects explicit CLI and ACP profiles for %s", (agent, cliName, acpName) => {
    const profiles = builtinAgentProfiles();
    expect(profiles[cliName]).toMatchObject({ agent, runner: { transport: "cli" } });
    expect(profiles[acpName]).toMatchObject({ agent, runner: { transport: "acp" } });
    expect(resolveAgentRunner(profiles[cliName]!)).not.toBe(resolveAgentRunner(profiles[acpName]!));
  });

  it("registers Grok CLI and ACP profiles at the public schema boundary", () => {
    const definition = resolveAgentDefinition("grok");
    expect(definition.cli?.integration).toBe("grok-exec");
    expect(definition.builtinProfiles).toMatchObject({
      grok: {
        adapter: "agent",
        agent: "grok",
        runner: { transport: "cli" },
        command: "grok",
        args: ["--no-auto-update", "--prompt-file"]
      },
      "grok-acp": { adapter: "agent", agent: "grok", runner: { transport: "acp" } }
    });
    expect(
      executorProfileSchema.parse({
        adapter: "agent",
        agent: "grok",
        runner: { transport: "acp" }
      })
    ).toEqual({ adapter: "agent", agent: "grok", runner: { transport: "acp" } });
    expect(
      executorProfileSchema.parse({
        adapter: "agent",
        agent: "grok",
        runner: { transport: "cli" },
        command: "grok",
        args: ["--no-auto-update", "--prompt-file"]
      })
    ).toEqual({
      adapter: "agent",
      agent: "grok",
      runner: { transport: "cli" },
      command: "grok",
      args: ["--no-auto-update", "--prompt-file"]
    });
  });

  it.each([
    "codex",
    "opencode",
    "claude-code",
    "pi"
  ] as const)("keeps %s on the shared no-auth-methods ACP lifecycle", async (agent) => {
    const result = await createAcpRunner().preflight({
      profile: { adapter: "agent", agent, runner: { transport: "acp" } },
      definition: probeDefinition("success", undefined, agent),
      cwd: "/tmp",
      timeoutMs: 1_000
    });

    expect(result.authentication).toEqual(notAdvertisedAuthentication);
    expect(result.negotiatedCapabilities).not.toBeNull();
  });

  it("applies Grok auth hints through the shared advertised-method lifecycle", async () => {
    const previous = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      const cached = await createAcpRunner().preflight({
        profile: { adapter: "agent", agent: "grok", runner: { transport: "acp" } },
        definition: probeDefinition("grok-auth", undefined, "grok"),
        cwd: "/tmp",
        timeoutMs: 1_000
      });
      expect(cached.authentication).toEqual({
        status: "authenticated",
        methodId: "cached_token"
      });

      process.env.XAI_API_KEY = "test-value-must-not-be-projected";
      const apiKey = await createAcpRunner().preflight({
        profile: { adapter: "agent", agent: "grok", runner: { transport: "acp" } },
        definition: probeDefinition("grok-auth", undefined, "grok"),
        cwd: "/tmp",
        timeoutMs: 1_000
      });
      expect(apiKey.authentication).toEqual({
        status: "authenticated",
        methodId: "xai.api_key"
      });
      expect(JSON.stringify([cached, apiKey])).not.toContain(process.env.XAI_API_KEY);
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previous;
    }
  });

  it("returns action required for interactive grok.com authentication", async () => {
    const result = await createAcpRunner().preflight({
      profile: { adapter: "agent", agent: "grok", runner: { transport: "acp" } },
      definition: probeDefinition("grok-interactive", undefined, "grok"),
      cwd: "/tmp",
      timeoutMs: 1_000
    });

    expect(result.authentication).toEqual({
      status: "action_required",
      reason: "no_safe_method",
      methods: [{ id: "grok.com", name: "Sign in with Grok", type: "agent" }]
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ failureCode: "auth_required" })])
    );
  });

  it.each<{
    label: string;
    probe: AcpPreflightProbeResult | "hang";
    failureCode: string;
  }>([
    {
      label: "requires agent-owned authentication",
      probe: {
        kind: "auth_required",
        message: "Sign in with the selected agent.",
        agentInfo: mockAgentInfo,
        authentication: {
          status: "action_required",
          reason: "no_safe_method",
          methods: [{ id: "login", name: "Login", type: "agent" }]
        },
        capabilities: ["session", "authentication"]
      },
      failureCode: "auth_required"
    },
    {
      label: "rejects unsupported capabilities",
      probe: {
        kind: "ready",
        authentication: notAdvertisedAuthentication,
        agentInfo: mockAgentInfo,
        capabilities: []
      },
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
      probe: async ({ signal }) => {
        if (probe === "hang") {
          return new Promise<AcpPreflightProbeResult>((_resolve, reject) => {
            const rejectAbort = (): void => {
              reject(signal.reason ?? new Error("ACP preflight aborted."));
            };
            if (signal.aborted) {
              rejectAbort();
              return;
            }
            signal.addEventListener("abort", rejectAbort, { once: true });
          });
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
        authentication: notAdvertisedAuthentication,
        agentInfo: mockAgentInfo,
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
    expect(result.agentInfo).toEqual(mockAgentInfo);
  });

  it("returns the ACP session configuration advertised by the probed session", async () => {
    const base = resolveAgentDefinition("codex");
    const definition = {
      ...base,
      acp: {
        launch: { command: "codex-acp", args: [] },
        capabilities: ["session"] as const
      }
    };
    const sessionConfig = {
      modes: {
        currentModeId: "agent",
        availableModes: [
          { id: "read-only", name: "Read only", description: null },
          { id: "agent", name: "Agent", description: null }
        ]
      },
      configOptions: [
        {
          id: "model",
          type: "select" as const,
          name: "Model",
          description: null,
          category: "model",
          currentValue: "gpt-5",
          options: [{ value: "gpt-5", name: "GPT-5", description: null, group: null }]
        }
      ]
    };
    const runner = createAcpRunner({
      probe: async () => ({
        kind: "ready",
        authentication: notAdvertisedAuthentication,
        agentInfo: mockAgentInfo,
        capabilities: ["session"],
        sessionConfig
      })
    });

    const result = await runner.preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition,
      cwd: "/tmp",
      timeoutMs: 100
    });

    expect(result.sessionConfig).toEqual(sessionConfig);
  });

  it("uses the formal default probe for advertised capabilities and missing capability diagnostics", async () => {
    const ready = await createAcpRunner().preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition: probeDefinition("close-capable", [
        "session",
        "prompt",
        "cancel",
        "session-close"
      ]),
      cwd: "/tmp",
      timeoutMs: 1_000
    });
    expect(ready.negotiatedCapabilities?.available).toEqual(
      expect.arrayContaining(["streaming", "tool-updates", "session-close"])
    );
    expect(ready.agentInfo).toEqual(mockAgentInfo);

    const missing = await createAcpRunner().preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition: probeDefinition("success", ["session", "prompt", "cancel", "session-close"]),
      cwd: "/tmp",
      timeoutMs: 1_000
    });
    expect(missing.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ failureCode: "unsupported_capability" })])
    );
  });

  it("projects open SDK agentInfo extensions into the strict internal identity", async () => {
    const result = await createAcpRunner().preflight({
      profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
      definition: probeDefinition("extended-agent-info"),
      cwd: "/tmp",
      timeoutMs: 1_000
    });

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "acp_initialized", status: "passed" })
      ])
    );
    expect(result.agentInfo).toEqual(mockAgentInfo);
    expect(Object.keys(result.agentInfo ?? {})).toEqual(["name", "version"]);
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
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed", failureCode: code })])
    );
  });

  it("refuses an untrusted default run before creating a process or run record", async () => {
    const { init } = await createTestWorkspace();
    const before = await readdir(init.workspace.resultsDir, { recursive: true });
    await expect(
      createAcpRunner().runBlock(
        {
          projectRoot: init.workspace,
          claim: blockClaim,
          prompt: "must not spawn",
          executorName: "codex-acp",
          profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
        },
        probeDefinition("artifact-implementation")
      )
    ).rejects.toThrow("not trusted");
    expect(await readdir(init.workspace.resultsDir, { recursive: true })).toEqual(before);
  });

  it("allows a versioned registry ACP launch for a built-in profile without project trust", async () => {
    const { init } = await createTestWorkspace();
    const definition = probeDefinition("artifact-implementation");

    await expect(
      assertAcpLaunchTrusted({
        projectRoot: init.workspace,
        executorName: "codex-acp",
        definition,
        profileSource: "builtin"
      })
    ).resolves.toEqual(definition.acp.launch);
  });

  it("applies Desktop ACP session defaults only when desktopRunId identifies the origin", async () => {
    const { init } = await createTestWorkspace();
    const settingsFile = join(init.workspace.rootPath, "desktop-settings.json");
    await writeFile(
      settingsFile,
      JSON.stringify({
        agents: {
          codex: {
            acp: {
              modeId: "agent-full-access",
              configOptions: { model: "gpt-5.2-codex", "fast-mode": true }
            }
          }
        }
      })
    );
    const previous = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = settingsFile;
    try {
      await expect(
        createAcpRunner().runBlock(
          {
            projectRoot: init.workspace,
            claim: blockClaim,
            prompt: "desktop ACP execution",
            executorName: "codex-acp",
            profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
            profileSource: "builtin",
            runtime: { desktopRunId: "DESKTOP-001", timeoutMs: 1_000 }
          },
          probeDefinition("artifact-session-config")
        )
      ).resolves.toMatchObject({
        kind: "block",
        exitCode: 0
      });
    } finally {
      if (previous === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
      else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = previous;
    }
  });

  it("does not treat a non-Desktop runSessionId as Desktop settings authority", async () => {
    const { init } = await createTestWorkspace();
    const settingsFile = join(init.workspace.rootPath, "desktop-settings-invalid.json");
    await writeFile(settingsFile, "invalid desktop settings");
    const previous = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = settingsFile;
    try {
      await expect(
        createAcpRunner().runBlock(
          {
            projectRoot: init.workspace,
            claim: blockClaim,
            prompt: "non-Desktop ACP execution",
            executorName: "codex-acp",
            profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
            profileSource: "builtin",
            runtime: { runSessionId: "SESSION-CLI-001", timeoutMs: 1_000 }
          },
          probeDefinition("artifact-implementation")
        )
      ).resolves.toMatchObject({
        kind: "block",
        exitCode: 0
      });
    } finally {
      if (previous === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
      else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = previous;
    }
  });

  it.each([
    { kind: "ready", capabilities: ["session"] },
    {
      kind: "ready",
      agentInfo: null,
      authentication: { status: "action_required", reason: "no_safe_method", methods: [] },
      capabilities: ["session"]
    },
    {
      kind: "ready",
      agentInfo: null,
      authentication: notAdvertisedAuthentication,
      capabilities: ["session", "session"]
    },
    {
      kind: "ready",
      agentInfo: null,
      authentication: notAdvertisedAuthentication,
      capabilities: ["unknown"]
    },
    {
      kind: "ready",
      agentInfo: null,
      authentication: notAdvertisedAuthentication,
      capabilities: ["session"],
      extra: true
    },
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

  it("keeps custom package profiles in compatibility list output", () => {
    const manifest = manifestTestBuilder()
      .withExecutor("custom-opencode", {
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
          name: "custom-opencode",
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
        "permission",
        "authentication",
        "image",
        "embedded-context",
        "session-close",
        "history-load"
      ]
    });
    expect(summaries.find((summary) => summary.name === "grok-acp")).toMatchObject({
      runnerKind: "acp",
      acpLaunch: {
        command: "grok",
        args: ["--no-auto-update", "agent", "stdio"],
        source: {
          registryId: "xai-grok-cli",
          version: "0.2.101",
          url: "https://docs.x.ai/build/cli/headless-scripting"
        }
      }
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
