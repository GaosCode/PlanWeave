import { describe, expect, it } from "vitest";
import {
  acpSessionConfigurationSchema,
  projectAcpActualSessionConfiguration
} from "../autoRun/acpSessionConfiguration.js";
import {
  encodeNormalizedRunnerEvent,
  normalizedRunnerEventSchema,
  type NormalizedRunnerEvent
} from "../autoRun/normalizedEventContract.js";
import { runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";

const identity = runnerRunIdentitySchema.parse({
  projectId: "project-1",
  canvasId: "default",
  taskId: "T-001",
  blockId: "B-001",
  claimRef: "T-001#B-001",
  runId: "RUN-001",
  runOwner: "executor",
  runSessionId: null,
  desktopRunId: null,
  executorRunId: "RUN-001"
});

function selectOption(options: {
  id: string;
  category: string | null;
  currentValue: string;
  values?: string[];
}) {
  return {
    id: options.id,
    type: "select" as const,
    name: options.id,
    description: null,
    category: options.category,
    currentValue: options.currentValue,
    options: (options.values ?? [options.currentValue]).map((value) => ({
      value,
      name: value,
      description: null,
      group: null
    }))
  };
}

function configuration(options: {
  mode?: string | null;
  configOptions: ReturnType<typeof selectOption>[];
}) {
  return acpSessionConfigurationSchema.parse({
    modes:
      options.mode === undefined || options.mode === null
        ? null
        : {
            currentModeId: options.mode,
            availableModes: [
              { id: options.mode, name: options.mode, description: null },
              { id: "agent", name: "agent", description: null }
            ]
          },
    configOptions: options.configOptions
  });
}

function event(
  sequence: number,
  body: NormalizedRunnerEvent["body"],
  sessionId = "session-1"
): NormalizedRunnerEvent {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp: `2026-07-13T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    identity,
    runner: {
      version: "planweave.runner/v1",
      runnerKind: "acp",
      agentId: "codex"
    },
    correlation: { sessionId },
    body
  });
}

describe("ACP actual session configuration", () => {
  it.each([
    {
      agent: "Codex",
      modelId: "model",
      reasoningId: "reasoning_effort",
      mode: "agent",
      model: "gpt-5.2-codex",
      reasoning: "high"
    },
    {
      agent: "OpenCode",
      modelId: "model",
      reasoningId: "effort",
      mode: "build",
      model: "openai/gpt-5",
      reasoning: "low"
    },
    {
      agent: "Pi",
      modelId: "model",
      reasoningId: "thought_level",
      mode: "high",
      model: "anthropic/claude-sonnet-4",
      reasoning: "high"
    }
  ])("projects $agent by ACP category instead of agent-specific ids", (fixture) => {
    const result = projectAcpActualSessionConfiguration([
      event(1, {
        kind: "session_configuration_snapshot",
        phase: "initial",
        configuration: configuration({
          mode: fixture.mode,
          configOptions: [
            selectOption({
              id: fixture.modelId,
              category: "model",
              currentValue: fixture.model
            }),
            selectOption({
              id: fixture.reasoningId,
              category: "thought_level",
              currentValue: fixture.reasoning
            })
          ]
        })
      })
    ]);

    expect(result).toMatchObject({
      available: true,
      fields: {
        model: { available: true, value: fixture.model },
        reasoning: { available: true, value: fixture.reasoning },
        mode: { available: true, value: fixture.mode },
        permission: { available: false, value: null }
      }
    });
  });

  it("strictly merges defaults and live full-option/mode updates by sequence", () => {
    const initial = configuration({
      mode: "read-only",
      configOptions: [
        selectOption({ id: "model", category: "model", currentValue: "initial" })
      ]
    });
    const defaultsApplied = configuration({
      mode: "agent",
      configOptions: [
        selectOption({ id: "model", category: "model", currentValue: "configured" })
      ]
    });
    const result = projectAcpActualSessionConfiguration([
      event(1, {
        kind: "session_configuration_snapshot",
        phase: "initial",
        configuration: initial
      }),
      event(2, {
        kind: "session_configuration_snapshot",
        phase: "defaults_applied",
        configuration: defaultsApplied
      }),
      event(3, {
        kind: "session_config_options_update",
        configOptions: [
          selectOption({ id: "model", category: "model", currentValue: "live" }),
          selectOption({ id: "effort", category: "thought_level", currentValue: "xhigh" })
        ]
      }),
      event(4, { kind: "session_mode_update", currentModeId: "agent-full-access" })
    ]);

    expect(result).toMatchObject({
      available: true,
      sequence: 4,
      observedAt: "2026-07-13T00:00:04.000Z",
      sessionId: "session-1",
      protocol: {
        modes: { currentModeId: "agent-full-access" }
      },
      fields: {
        model: { available: true, value: "live" },
        reasoning: { available: true, value: "xhigh" },
        mode: { available: true, value: "agent-full-access" }
      }
    });
  });

  it("does not infer fields from missing categories and rejects duplicate/conflicting authority", () => {
    const missing = projectAcpActualSessionConfiguration([
      event(1, {
        kind: "session_configuration_snapshot",
        phase: "initial",
        configuration: configuration({
          configOptions: [selectOption({ id: "model", category: null, currentValue: "gpt" })]
        })
      })
    ]);
    expect(missing).toMatchObject({
      available: true,
      fields: { model: { available: false }, reasoning: { available: false } }
    });

    const duplicate = projectAcpActualSessionConfiguration([
      event(1, {
        kind: "session_configuration_snapshot",
        phase: "initial",
        configuration: configuration({
          configOptions: [
            selectOption({ id: "first", category: "model", currentValue: "a" }),
            selectOption({ id: "second", category: "model", currentValue: "b" })
          ]
        })
      })
    ]);
    expect(duplicate).toMatchObject({
      available: true,
      fields: { model: { available: false } }
    });

    const conflict = projectAcpActualSessionConfiguration([
      event(1, {
        kind: "session_configuration_snapshot",
        phase: "initial",
        configuration: configuration({
          mode: "read-only",
          configOptions: [
            selectOption({ id: "mode", category: "mode", currentValue: "agent" })
          ]
        })
      })
    ]);
    expect(conflict).toMatchObject({
      available: true,
      fields: { mode: { available: false } }
    });
  });

  it("returns authoritative unavailable for missing, out-of-order, and cross-session evidence", () => {
    expect(projectAcpActualSessionConfiguration([])).toEqual({
      available: false,
      reason: "No authoritative ACP session configuration snapshot was recorded for this run."
    });
    expect(
      projectAcpActualSessionConfiguration([
        event(1, { kind: "session_config_options_update", configOptions: [] })
      ])
    ).toMatchObject({ available: false });
    expect(
      projectAcpActualSessionConfiguration([
        event(1, {
          kind: "session_configuration_snapshot",
          phase: "initial",
          configuration: configuration({ configOptions: [] })
        }),
        event(2, { kind: "session_config_options_update", configOptions: [] }, "session-2")
      ])
    ).toMatchObject({ available: false });
  });

  it("rejects configuration events without an ACP session correlation", () => {
    expect(() =>
      normalizedRunnerEventSchema.parse({
        version: "planweave.runner-event/v1",
        sequence: 1,
        timestamp: "2026-07-13T00:00:01.000Z",
        identity,
        runner: {
          version: "planweave.runner/v1",
          runnerKind: "acp",
          agentId: "codex"
        },
        body: {
          kind: "session_configuration_snapshot",
          phase: "initial",
          configuration: configuration({ configOptions: [] })
        }
      })
    ).toThrow("sessionId correlation");
  });

  it("enforces the normalized event line limit for advertised configuration", () => {
    const oversized = event(1, {
      kind: "session_configuration_snapshot",
      phase: "initial",
      configuration: configuration({
        configOptions: Array.from({ length: 70 }, (_, index) =>
          selectOption({
            id: `model-${index}`,
            category: "model",
            currentValue: "x".repeat(4_000)
          })
        )
      })
    });
    expect(() => encodeNormalizedRunnerEvent(oversized)).toThrow("UTF-8 line limit");
  });
});
