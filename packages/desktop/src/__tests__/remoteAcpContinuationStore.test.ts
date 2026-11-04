import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { describe, expect, it } from "vitest";
import type { AcpConversationEvent } from "@planweave-ai/agent-host-protocol/browser";
import { projectRemoteAcpReplay, projectRemoteAcpTelemetry } from "@planweave-ai/runtime/browser";
import {
  desktopRemoteAcpConversationPageSchema,
  type DesktopRemoteAcpConversationPage
} from "../shared/remoteAcpConversation";
import { RemoteAcpContinuationStore } from "../renderer/task-workspace/remoteAcpContinuationStore";

const timestamp = "2030-01-01T00:00:00.000Z";
type Payload = AcpConversationEvent["payload"];
function event(turnId: string, sequence: number, payload: Payload): AcpConversationEvent {
  return {
    protocolVersion: agentHostProtocolVersion,
    type: "acp_conversation.event",
    operationId: "operation-one",
    executionAttemptId: "attempt-one",
    sessionId: "original-session",
    turnId,
    sequence,
    messageId: `${turnId}-${sequence}`,
    timestamp,
    payload
  };
}
function message(turnId: string, sequence: number, content: string, chunk = false) {
  return event(turnId, sequence, {
    kind: "runner",
    fragment: {
      kind: "runner_body",
      body: {
        kind: "message",
        role: sequence === 1 && turnId === "first" ? "user" : "assistant",
        messageId: chunk ? "reply" : `${turnId}-${sequence}`,
        chunk,
        content,
        redaction: { classes: [], replaced: 0 }
      }
    }
  });
}
function page(turnIds: string[], events: AcpConversationEvent[]): DesktopRemoteAcpConversationPage {
  return desktopRemoteAcpConversationPageSchema.parse({
    execution: { state: "completed", cancel: null, interactions: [] },
    available: true,
    canRestoreTask: false,
    restoredOperationId: null,
    reason: null,
    executionAttemptId: "attempt-one",
    sessionId: "original-session",
    turns: turnIds.map((turnId, index) => ({
      turnId,
      executionAttemptId: "attempt-one",
      sessionId: "original-session",
      status: turnId === "first" ? "running" : "completed",
      createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
      turnOrder: index + 1,
      error: null
    })),
    events,
    cursor: events.length,
    hasMore: false
  });
}
function replay(events: AcpConversationEvent[]) {
  return projectRemoteAcpReplay({
    executionAttemptId: "attempt-one",
    eventProtocolVersion: 2,
    events: events.flatMap((item) =>
      item.payload.kind === "runner"
        ? [
            {
              eventVersion: 2 as const,
              cursor: item.sequence,
              sourceSequence: item.sequence,
              timestamp: item.timestamp,
              fragment: item.payload.fragment
            }
          ]
        : []
    )
  });
}

describe("remote ACP continuation store replay boundaries", () => {
  it("retains the authoritative order for equal-time reverse identifiers across priority and delayed metadata", () => {
    const first = {
      ...page(["z-first"], [message("z-first", 1, "First")]),
      turns: page(["z-first"], []).turns.map((turn) => ({
        ...turn,
        createdAt: timestamp,
        turnOrder: 1
      }))
    };
    const second = {
      ...page(["a-second"], [message("a-second", 1, "Second")]),
      turns: page(["a-second"], []).turns.map((turn) => ({
        ...turn,
        createdAt: timestamp,
        turnOrder: 2
      }))
    };
    const store = new RemoteAcpContinuationStore();
    store.accept(second);
    const merged = store.accept(first);
    expect(merged.page.turns.map((turn) => turn.turnId)).toEqual(["z-first", "a-second"]);
    expect(merged.projection.turns.map((turn) => turn.timeline[0])).toEqual([
      expect.objectContaining({ content: "First" }),
      expect.objectContaining({ content: "Second" })
    ]);
    expect(store.accept(structuredClone(first))).toBe(merged);
    const compacted = store.accept({
      ...first,
      turns: [],
      events: [],
      retention: { compactedTurnIds: ["z-first"] }
    });
    expect(compacted.projection.turns.map((turn) => turn.turnId)).toEqual(["z-first", "a-second"]);
    expect(compacted.projection.turns[0].history).toBe("compacted");
    const refreshed = new RemoteAcpContinuationStore().accept({
      ...first,
      turns: [...second.turns, ...first.turns],
      events: [...first.events, ...second.events]
    });
    expect(refreshed.projection.turns.map((turn) => turn.turnId)).toEqual(["z-first", "a-second"]);
  });

  it("retains terminal events arriving before older metadata without losing later-turn telemetry", () => {
    const store = new RemoteAcpContinuationStore();
    const older = page(["z-first"], []).turns.map((turn) => ({
      ...turn,
      turnOrder: 1,
      status: "running" as const
    }));
    const newer = page(["a-second"], []).turns.map((turn) => ({ ...turn, turnOrder: 2 }));
    const usage = event("a-second", 2, {
      kind: "runner",
      fragment: {
        kind: "engine_evidence",
        evidence: {
          kind: "usage_snapshot",
          usage: {
            semantics: "cumulative_session_total",
            totalTokens: 9,
            inputTokens: 6,
            outputTokens: 3,
            thoughtTokens: null,
            cachedReadTokens: null,
            cachedWriteTokens: null
          }
        }
      }
    });
    store.accept({
      ...page(
        [],
        [
          message("z-first", 1, "Earlier"),
          event("z-first", 2, { kind: "status", status: "completed", error: null }),
          message("a-second", 1, "Latest"),
          usage
        ]
      ),
      turns: newer
    });
    const merged = store.accept({ ...page([], []), turns: older });
    expect(merged.projection.turns.map((turn) => [turn.turnId, turn.status])).toEqual([
      ["z-first", "completed"],
      ["a-second", "completed"]
    ]);
    expect(merged.projection.interactions).toEqual([]);
    expect(merged.projection.telemetry?.cumulativeUsage?.totalTokens).toBe(9);
    expect(merged.projection.turns.map((turn) => turn.timeline[0])).toEqual([
      expect.objectContaining({ content: "Earlier" }),
      expect.objectContaining({ content: "Latest" })
    ]);
    expect(store.accept({ ...page([], []), turns: older })).toBe(merged);
  });

  it("merges paginated mixed turns, replaces an event, and settles a permission without duplicating replay", () => {
    const request = {
      kind: "permission" as const,
      requestId: "permission-one",
      summary: "Read file?",
      deadline: "2030-01-01T01:00:00.000Z",
      options: [{ optionId: "yes", label: "Allow", decision: "approve" as const }]
    };
    const first = [
      message("first", 1, "Question"),
      message("first", 2, "Hel", true),
      message("first", 3, "lo", true),
      event("first", 4, {
        kind: "runner",
        fragment: {
          kind: "runner_body",
          body: {
            kind: "tool_call",
            callId: "read",
            title: "Read file",
            status: "in_progress",
            content: null
          }
        }
      })
    ];
    const second = [
      event("second", 1, {
        kind: "runner",
        fragment: {
          kind: "engine_evidence",
          evidence: { kind: "session_started", sessionId: "original-session", loaded: true }
        }
      }),
      event("second", 2, {
        kind: "runner",
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
      }),
      message("second", 3, "Second reply")
    ];
    const initial = page(["first", "second", "empty"], [first[0], second[0], first[1], second[1]]);
    const store = new RemoteAcpContinuationStore();
    store.accept({ ...initial, hasMore: true });
    const toolUpdate = event("first", 5, {
      kind: "runner",
      fragment: {
        kind: "runner_body",
        body: { kind: "tool_update", callId: "read", status: "completed", content: null }
      }
    });
    const permission = event("first", 6, { kind: "interaction", request });
    const finalPage = {
      ...initial,
      cursor: 9,
      events: [first[1], first[2], first[3], toolUpdate, permission, second[2]]
    };
    const complete = store.accept(finalPage);
    expect(complete.projection.interactions).toEqual([{ turnId: "first", request }]);
    expect(complete.projection.turns[0].timeline).toEqual([
      expect.objectContaining({ kind: "message", role: "user", content: "Question" }),
      expect.objectContaining({ kind: "message", role: "assistant", content: "Hello" }),
      expect.objectContaining({
        kind: "tool",
        callId: "read",
        title: "Read file",
        status: "completed"
      })
    ]);
    expect(complete.projection.turns[1].timeline).toEqual([
      expect.objectContaining({ kind: "message", content: "Second reply" })
    ]);
    expect(complete.projection.turns[2].timeline).toEqual([]);
    expect(complete.projection.telemetry).toMatchObject({
      executionAttemptId: "attempt-one",
      sessionId: "original-session",
      cumulativeUsage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 }
    });
    expect(store.accept(structuredClone(finalPage))).toBe(complete);
    const replaced = message("first", 3, "lo!", true);
    const settled = event("first", 7, {
      kind: "interaction_settled",
      requestId: request.requestId
    });
    const changed = store.accept({ ...finalPage, events: [replaced, settled], cursor: 10 });
    expect(changed.projection.interactions).toEqual([]);
    expect(changed.projection.turns[1]).toBe(complete.projection.turns[1]);
    expect(changed.projection.turns[0].timeline).toEqual([
      expect.objectContaining({ kind: "message", content: "Question" }),
      expect.objectContaining({ kind: "message", content: "Hello!" }),
      expect.objectContaining({ kind: "tool", status: "completed" })
    ]);
    const canonicalFirst = replay([
      first[0],
      first[1],
      replaced,
      first[3],
      toolUpdate,
      permission,
      settled
    ]);
    const canonicalSecond = replay(second);
    expect(changed.projection.turns[0].timeline).toEqual(canonicalFirst.timeline);
    expect(changed.projection.turns[0].projected).toEqual(canonicalFirst.events);
    expect(changed.projection.turns[1].timeline).toEqual(canonicalSecond.timeline);
    expect(changed.projection.telemetry).toEqual(projectRemoteAcpTelemetry(canonicalSecond.events));
  });

  it("retires compacted event payloads and pending interactions before accepting delayed pages", () => {
    const old = message("first", 1, "Discard me");
    const pending = event("first", 2, {
      kind: "interaction",
      request: {
        kind: "elicitation",
        requestId: "question",
        message: "Name?",
        requestedSchema: {},
        deadline: "2030-01-01T01:00:00.000Z"
      }
    });
    let reads = 0;
    const payload = old.payload;
    Object.defineProperty(old, "payload", {
      enumerable: true,
      get: () => {
        reads++;
        return payload;
      }
    });
    const initial = page(["first", "second"], [old, pending, message("second", 1, "Keep me")]);
    const store = new RemoteAcpContinuationStore();
    const before = store.accept({ ...initial, events: [old, pending, initial.events[2]] });
    const retained = before.projection.turns[1];
    reads = 0;
    const compacted = store.accept({
      ...initial,
      events: [],
      retention: { compactedTurnIds: ["first"] }
    });
    expect(compacted.projection.turns[0]).toMatchObject({
      history: "compacted",
      timeline: [],
      projected: []
    });
    expect(compacted.projection.interactions).toEqual([]);
    expect(compacted.projection.turns[1]).toBe(retained);
    expect(reads).toBe(0);
    const late = store.accept({ ...initial, events: [old, pending] });
    expect(late.projection.turns[0]).toMatchObject({
      history: "compacted",
      timeline: [],
      projected: []
    });
    expect(late.projection.interactions).toEqual([]);
    expect(reads).toBe(0);
    const renewed = new RemoteAcpContinuationStore().accept(initial);
    expect(renewed.projection.turns[0].history).toBe("unknown");
    expect(renewed.projection.turns[0].timeline).toEqual([
      expect.objectContaining({ content: "Discard me" })
    ]);
  });

  it.each([
    [1000, 1],
    [1000, 10],
    [10000, 1],
    [10000, 100]
  ])("bounds empty-poll and append payload reads for %i events across %i turns", (eventCount, turnCount) => {
    const turnIds = Array.from({ length: turnCount }, (_, index) => `turn-${index}`);
    const perTurn = eventCount / turnCount;
    const initial = page(
      turnIds,
      turnIds.flatMap((turnId) =>
        Array.from({ length: perTurn }, (_, index) =>
          message(turnId, index + 1, `${turnId}:${index + 1}`)
        )
      )
    );
    const reads = new Map<string, number>();
    for (const item of initial.events) {
      const payload = item.payload;
      Object.defineProperty(item, "payload", {
        enumerable: true,
        get: () => {
          reads.set(item.turnId, (reads.get(item.turnId) ?? 0) + 1);
          return payload;
        }
      });
    }
    const store = new RemoteAcpContinuationStore();
    const before = store.accept(initial);
    reads.clear();
    expect(store.accept({ ...initial, events: [] })).toBe(before);
    expect(store.accept({ ...initial, events: [] })).toBe(before);
    expect([...reads.values()]).toEqual([]);
    const changed = store.accept({
      ...initial,
      events: [message("turn-0", perTurn + 1, "Append")],
      cursor: eventCount + 1
    });
    expect([...reads.entries()]).toEqual([["turn-0", perTurn]]);
    expect(changed.projection.turns[0].timeline).toHaveLength(perTurn + 1);
    expect(changed.projection.turns[0].timeline.at(-1)).toMatchObject({
      kind: "message",
      content: "Append"
    });
    expect(
      changed.projection.turns
        .slice(1)
        .every((turn, index) => turn === before.projection.turns[index + 1])
    ).toBe(true);
    console.info(
      JSON.stringify({
        events: eventCount,
        turns: turnCount,
        emptyPollPayloadReads: 0,
        appendHistoricalPayloadReads: reads.get("turn-0"),
        unaffectedTurnPayloadReads: 0
      })
    );
  });
});
