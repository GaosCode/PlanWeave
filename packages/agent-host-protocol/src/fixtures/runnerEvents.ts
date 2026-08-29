import { runnerBodyFragmentSchema, type RunnerBodyFragment } from "../runnerEvents.js";

const redaction = { classes: [], replaced: 0 };
const examples: unknown[] = [
  { kind: "lifecycle", state: "running", message: "running" },
  { kind: "output", stream: "stdout", content: "output", redaction },
  {
    kind: "message",
    role: "assistant",
    messageId: null,
    chunk: true,
    content: "message",
    redaction
  },
  { kind: "tool_call", callId: "call-1", status: "pending", title: "tool", content: null },
  { kind: "tool_update", callId: "call-1", status: "completed", content: null },
  { kind: "plan_update", content: "plan", redaction },
  { kind: "usage_update", usedTokens: 1, contextWindowTokens: 2, cost: null },
  {
    kind: "session_configuration_snapshot",
    phase: "initial",
    configuration: { modes: null, configOptions: [] }
  },
  { kind: "session_mode_update", currentModeId: "code" },
  { kind: "session_config_options_update", configOptions: [] },
  { kind: "terminal_output", terminalId: "terminal-1", content: "terminal", redaction },
  {
    kind: "interaction",
    interaction: {
      version: "planweave.runner/v1",
      interactionId: "interaction-1",
      requestId: "request-1",
      kind: "permission",
      requestedAt: "2026-08-29T00:00:00.000Z",
      summary: "approve",
      status: "approved",
      actionable: false,
      nonActionableReason: "persisted_history"
    }
  },
  {
    kind: "interaction_result",
    requestId: "request-1",
    interactionId: "interaction-1",
    interactionKind: "permission",
    outcome: "approved",
    message: "approved"
  },
  { kind: "diagnostic", code: "protocol_error", message: "diagnostic" }
];

export const exampleRunnerBodyFragments: readonly RunnerBodyFragment[] = examples.map((body) =>
  runnerBodyFragmentSchema.parse(body)
);
