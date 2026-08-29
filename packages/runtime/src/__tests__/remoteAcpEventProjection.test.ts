import { describe, expect, it } from "vitest";
import {
  projectRemoteAcpProjectedTimeline,
  projectRemoteAcpReplay,
  projectRemoteAcpTimeline,
  remoteAcpEventBody
} from "../autoRun/remoteAcpEventProjection.js";

const base = {
  eventVersion: 2 as const,
  cursor: 1,
  sourceSequence: 9,
  timestamp: "2026-08-29T00:00:09.000Z"
};

describe("remote ACP event v2 projection", () => {
  it("keeps v1 summaries while projecting v2 identity, evidence, and replay diagnostics", () => {
    const diagnostics = [
      { code: "remote_acp_event_retention_gap" as const, droppedThroughCursor: 1 },
      { code: "remote_acp_event_contract_degraded" as const }
    ];
    const v1 = projectRemoteAcpReplay({
      eventProtocolVersion: 1,
      executionAttemptId: "attempt-v1",
      diagnostics,
      events: [{ cursor: 1, kind: "agent_message", text: "legacy" }]
    });
    expect(v1).toMatchObject({
      eventProtocolVersion: 1,
      executionAttemptId: "attempt-v1",
      degraded: true,
      diagnostics,
      events: [
        {
          eventProtocolVersion: 1,
          executionAttemptId: "attempt-v1",
          cursor: 1,
          sourceSequence: 1,
          timestamp: "1970-01-01T00:00:00.000Z",
          kind: "agent_message",
          summary: "legacy",
          engineEvidence: null,
          engineTerminal: null
        }
      ]
    });

    const v2 = projectRemoteAcpReplay({
      eventProtocolVersion: 2,
      executionAttemptId: "attempt-v2",
      diagnostics: [{ code: "remote_acp_event_retention_gap", droppedThroughCursor: 1 }],
      events: [
        {
          ...base,
          fragment: {
            kind: "runner_body",
            body: {
              kind: "message",
              role: "assistant",
              messageId: "message-v2",
              chunk: false,
              content: "v2 message",
              redaction: { classes: [], replaced: 0 }
            }
          }
        },
        {
          ...base,
          cursor: 2,
          sourceSequence: 10,
          timestamp: "2026-08-29T00:00:10.000Z",
          fragment: {
            kind: "engine_evidence",
            evidence: {
              kind: "usage_snapshot",
              usage: {
                semantics: "cumulative_session_total",
                totalTokens: 8,
                inputTokens: 5,
                outputTokens: 3,
                thoughtTokens: null,
                cachedReadTokens: null,
                cachedWriteTokens: null
              }
            }
          }
        }
      ]
    });
    expect(v2).toMatchObject({
      eventProtocolVersion: 2,
      executionAttemptId: "attempt-v2",
      degraded: false,
      diagnostics: [{ code: "remote_acp_event_retention_gap", droppedThroughCursor: 1 }],
      events: [
        { kind: "message", summary: "v2 message", sourceSequence: 9, timestamp: base.timestamp },
        {
          kind: "engine_usage_snapshot",
          summary: "Remote cumulative token usage: 8.",
          sourceSequence: 10,
          timestamp: "2026-08-29T00:00:10.000Z",
          engineEvidence: {
            kind: "usage_snapshot",
            usage: {
              semantics: "cumulative_session_total",
              totalTokens: 8,
              inputTokens: 5,
              outputTokens: 3,
              thoughtTokens: null,
              cachedReadTokens: null,
              cachedWriteTokens: null
            }
          }
        }
      ]
    });
    expect(projectRemoteAcpProjectedTimeline(v2.events)).toEqual(v2.timeline);
    expect(v2.timeline).toEqual([
      expect.objectContaining({ content: "v2 message", timestamp: base.timestamp }),
      expect.objectContaining({ content: "Remote cumulative token usage: 8." })
    ]);
  });

  it("keeps Runner bodies exact and treats engine usage/terminal as evidence only", () => {
    const seen = new Set<string>();
    expect(
      remoteAcpEventBody(
        {
          ...base,
          fragment: {
            kind: "runner_body",
            body: {
              kind: "message",
              role: "assistant",
              messageId: "message-1",
              chunk: true,
              content: "hello",
              redaction: { classes: [], replaced: 0 }
            }
          }
        },
        seen
      )
    ).toMatchObject({ kind: "message", content: "hello" });
    expect(
      remoteAcpEventBody(
        {
          ...base,
          fragment: {
            kind: "engine_evidence",
            evidence: {
              kind: "usage_snapshot",
              usage: {
                semantics: "cumulative_session_total",
                totalTokens: 8,
                inputTokens: 5,
                outputTokens: 3,
                thoughtTokens: null,
                cachedReadTokens: null,
                cachedWriteTokens: null
              }
            }
          }
        },
        seen
      )
    ).toMatchObject({ kind: "diagnostic", code: "remote_usage_snapshot" });
    expect(
      remoteAcpEventBody(
        {
          ...base,
          fragment: {
            kind: "engine_terminal",
            terminal: { state: "succeeded", stopReason: "end_turn" }
          }
        },
        seen
      )
    ).toMatchObject({ kind: "diagnostic", code: "remote_engine_terminal" });
  });

  it("uses the real v2 event timestamp for timeline projection", () => {
    const timeline = projectRemoteAcpTimeline([
      {
        ...base,
        fragment: {
          kind: "runner_body",
          body: {
            kind: "message",
            role: "assistant",
            messageId: null,
            chunk: false,
            content: "timestamped",
            redaction: { classes: [], replaced: 0 }
          }
        }
      }
    ]);
    expect(timeline[0]).toMatchObject({ timestamp: base.timestamp });
  });
});
