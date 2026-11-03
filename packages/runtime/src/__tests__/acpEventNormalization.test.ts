import { describe, expect, it } from "vitest";
import {
  createAcpSessionNotificationNormalizer,
  normalizeAcpSessionNotification
} from "../autoRun/acpEventNormalization.js";
import { projectAcpContextUsage } from "../autoRun/acpUsageProjection.js";

describe("ACP event normalization", () => {
  it("coalesces thought chunks without their contents and restarts activity after visible output", () => {
    const normalize = createAcpSessionNotificationNormalizer();
    const thought = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk" as const,
        content: { type: "text" as const, text: "private reasoning that must not be published" }
      }
    };
    const activity = normalize(thought);
    expect(activity).toEqual({ kind: "activity", activity: "thinking" });
    expect(JSON.stringify(activity)).not.toContain("private reasoning");
    for (let i = 0; i < 100; i += 1) expect(normalize(thought)).toBeNull();
    normalize({
      sessionId: "session-1",
      update: { sessionUpdate: "usage_update", used: 10, size: 100 }
    });
    expect(normalize(thought)).toBeNull();
    normalize({
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } }
    });
    expect(normalize(thought)).toEqual(activity);
    expect(normalize({ ...thought, sessionId: "session-2" })).toEqual(activity);
  });

  it("preserves message, tool, plan, and usage semantics while redacting", () => {
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-1",
          content: { type: "text", text: "Authorization: Bearer abc.def.ghi" }
        }
      })
    ).toMatchObject({
      kind: "message",
      role: "assistant",
      messageId: "message-1",
      content: "[REDACTED:CREDENTIAL]"
    });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read",
          kind: "read",
          status: "in_progress",
          rawInput: { path: "README.md" },
          rawOutput: "initial"
        }
      })
    ).toMatchObject({
      kind: "tool_call",
      callId: "tool-1",
      title: "Read",
      toolKind: "read",
      status: "in_progress",
      rawInput: { content: '{"path":"README.md"}' },
      rawOutput: { content: "initial" }
    });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "message-2",
          content: { type: "text", text: "hello" }
        }
      })
    ).toMatchObject({ kind: "message", role: "user", messageId: "message-2" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          title: "Read complete",
          kind: "read",
          status: "completed",
          content: null,
          rawOutput: { bytes: 42 }
        }
      })
    ).toMatchObject({
      kind: "tool_update",
      callId: "tool-1",
      title: "Read complete",
      toolKind: "read",
      status: "completed",
      content: null,
      rawOutput: { content: '{"bytes":42}' }
    });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "finish", priority: "high", status: "in_progress" }]
        }
      })
    ).toMatchObject({ kind: "plan_update" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan_update",
          plan: { type: "markdown", planId: "plan-1", content: "# Plan" }
        }
      })
    ).toMatchObject({ kind: "plan_update" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan_removed",
          planId: "private-plan-id"
        }
      })
    ).toMatchObject({ kind: "plan_update", content: "Plan removed." });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "usage_update",
          used: 10,
          size: 100
        }
      })
    ).toMatchObject({ kind: "usage_update", usedTokens: 10, contextWindowTokens: 100 });
  });

  it("accepts usage updates that omit the context window and classifies their cost unit", () => {
    const normalize = (
      used: number,
      size: number,
      cost: { amount: number; currency: string } | null
    ) =>
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", used, size, ...(cost ? { cost } : {}) }
      });

    const zeroWindow = normalize(10, 0, null);
    expect(zeroWindow).toMatchObject({
      kind: "usage_update",
      usedTokens: 10,
      contextWindowTokens: 0
    });
    expect(
      projectAcpContextUsage([
        { sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", body: zeroWindow! }
      ])
    ).toMatchObject({ usedTokens: 10, contextWindowTokens: 0, cost: null });

    const credits = normalize(10, 100, { amount: 1, currency: "" });
    expect(
      projectAcpContextUsage([
        { sequence: 2, timestamp: "2026-01-01T00:00:01.000Z", body: credits! }
      ])
    ).toMatchObject({
      usedTokens: 10,
      contextWindowTokens: 100,
      cost: { amount: 1, currency: null, unit: "credits" }
    });

    const unformattable = normalize(10, 100, { amount: 2, currency: "US" });
    expect(
      projectAcpContextUsage([
        { sequence: 3, timestamp: "2026-01-01T00:00:02.000Z", body: unformattable! }
      ])
    ).toMatchObject({ cost: { amount: 2, currency: null, unit: "unknown" } });
  });

  it("ignores provider-only status while preserving authoritative configuration updates", () => {
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_info_update",
          _meta: { codex: { threadStatus: { type: "active", activeFlags: [] } } }
        }
      })
    ).toBeNull();
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "thought-1",
          content: { type: "text", text: "private reasoning" }
        }
      })
    ).toEqual({ kind: "activity", activity: "thinking" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "x".repeat(1_024),
          content: { type: "image", data: "private-image", mimeType: "image/png" }
        }
      })
    ).toEqual({ kind: "activity", activity: "thinking" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: []
        }
      })
    ).toBeNull();
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "code"
        }
      })
    ).toEqual({ kind: "session_mode_update", currentModeId: "code" });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: []
        }
      })
    ).toEqual({ kind: "session_config_options_update", configOptions: [] });
    expect(
      normalizeAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "provider_future_update"
        }
      })
    ).toMatchObject({ kind: "diagnostic", code: "corrupt_line" });
  });
});
