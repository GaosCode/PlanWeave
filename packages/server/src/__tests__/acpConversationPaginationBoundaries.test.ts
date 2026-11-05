import {
  acpConversationEventSchema,
  acpConversationOrderedPageSchema,
  acpConversationOrderedTurnSchema,
  agentHostProtocolVersion,
  type AcpConversationOrderedPage,
  type AcpConversationPageVersion
} from "@planweave-ai/agent-host-protocol";
import { ACP_CONVERSATION_RESPONSE_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import { describe, expect, it } from "vitest";
import { acpConversationWirePage, paginateAcpConversation } from "../acpConversationPagination.js";

const timestamp = "2030-01-01T00:00:00.000Z";
const escaped = '中文🙂"\\\n\t\u0001';
const versions = [1, 2, 3] as const;
type Turn = AcpConversationOrderedPage["turns"][number];
type Event = AcpConversationOrderedPage["events"][number];

function metadata(cursor = 0): AcpConversationOrderedPage {
  return acpConversationOrderedPageSchema.parse({
    available: true,
    reason: null,
    executionAttemptId: "attempt",
    sessionId: "session",
    turns: [],
    events: [],
    cursor,
    hasMore: false,
    retention: { compactedTurnIds: [`compacted-${escaped}`] }
  });
}

function turn(index: number, error = escaped): Turn {
  return acpConversationOrderedTurnSchema.parse({
    turnId: `turn-${index}-${escaped}`,
    turnOrder: index + 1,
    executionAttemptId: "attempt",
    sessionId: "session",
    status: "failed",
    createdAt: timestamp,
    error
  });
}

function event(index: number, description = escaped): Event {
  return acpConversationEventSchema.parse({
    protocolVersion: agentHostProtocolVersion,
    type: "acp_conversation.event",
    operationId: "operation",
    turnId: `turn-${index}-${escaped}`,
    executionAttemptId: "attempt",
    sessionId: "session",
    messageId: `message-${index}`,
    sequence: index + 1,
    timestamp,
    payload: {
      kind: "interaction",
      request: {
        kind: "elicitation",
        requestId: `request-${index}`,
        message: escaped,
        requestedSchema: { description },
        deadline: "2030-01-01T00:01:00.000Z"
      }
    }
  });
}

function expectedWire(page: AcpConversationOrderedPage, version: AcpConversationPageVersion) {
  return {
    available: page.available,
    canRestoreTask: page.canRestoreTask,
    restoredOperationId: page.restoredOperationId,
    reason: page.reason,
    executionAttemptId: page.executionAttemptId,
    sessionId: page.sessionId,
    turns: page.turns.map((value) => ({
      turnId: value.turnId,
      executionAttemptId: value.executionAttemptId,
      sessionId: value.sessionId,
      status: value.status,
      createdAt: value.createdAt,
      error: value.error,
      ...(version === 3 ? { turnOrder: value.turnOrder } : {})
    })),
    events: page.events,
    cursor: page.cursor,
    hasMore: page.hasMore,
    ...(version === 1 ? {} : { turnCursor: page.turnCursor, hasMoreTurns: page.hasMoreTurns }),
    ...(page.retention ? { retention: page.retention } : {})
  };
}

function wireBytes(page: AcpConversationOrderedPage, version: AcpConversationPageVersion) {
  return Buffer.byteLength(JSON.stringify(expectedWire(page, version)));
}

describe("ACP conversation UTF-8 pagination boundaries", () => {
  it.each(versions)("preserves complete v%i wire fields and priority overlap order", (version) => {
    const turns = [turn(0), turn(1), turn(2)];
    const rows = [event(0), event(1)].map((value, index) => ({ cursor: index + 9, event: value }));
    const expected = {
      ...metadata(8),
      turns: [turns[1]!, turns[0]!, turns[2]!],
      events: rows.map((row) => row.event),
      cursor: 10,
      turnCursor: turns[2]!.turnId,
      hasMoreTurns: false,
      hasMore: false
    };
    const page = paginateAcpConversation(metadata(8), turns, rows, null, turns[1]!.turnId, version);
    expect(JSON.stringify(acpConversationWirePage(page, version))).toBe(
      JSON.stringify(expectedWire(expected, version))
    );
  });

  it.each(
    versions.flatMap((version) => [-1, 0, 1].map((delta) => ({ version, delta })))
  )("applies v$version event budget at limit $delta with cursor 9 to 10", ({ version, delta }) => {
    const empty = event(0, escaped);
    const target = {
      ...metadata(9),
      events: [empty],
      cursor: 10
    };
    const room = ACP_CONVERSATION_RESPONSE_MAX_BYTES - wireBytes(target, version);
    const exact = event(0, escaped + "x".repeat(room + delta));
    expect(wireBytes({ ...target, events: [exact] }, version)).toBe(
      ACP_CONVERSATION_RESPONSE_MAX_BYTES + delta
    );
    const read = () =>
      paginateAcpConversation(
        metadata(9),
        [],
        [{ cursor: 10, event: exact }],
        null,
        undefined,
        version
      );
    if (delta > 0) {
      expect(read).toThrow(
        version === 1
          ? "acp_conversation_client_upgrade_required"
          : "acp_conversation_page_item_too_large"
      );
    } else {
      const page = read();
      expect(page).toEqual({ ...target, events: [exact] });
      expect(Buffer.byteLength(JSON.stringify(acpConversationWirePage(page, version)))).toBe(
        ACP_CONVERSATION_RESPONSE_MAX_BYTES + delta
      );
    }
  });

  it.each(
    versions.flatMap((version) => [-1, 0, 1].map((delta) => ({ version, delta })))
  )("applies v$version turn budget at limit $delta and rolls back escaped metadata", ({
    version,
    delta
  }) => {
    const first = Array.from({ length: 10 }, (_, index) => turn(index, "\u0001".repeat(64 * 1024)));
    const empty = turn(10, escaped);
    const target = {
      ...metadata(),
      turns: [...first, empty],
      turnCursor: empty.turnId
    };
    const room = ACP_CONVERSATION_RESPONSE_MAX_BYTES - wireBytes(target, version) + delta;
    const tail = turn(10, escaped + "\u0001".repeat(Math.floor(room / 6)) + "x".repeat(room % 6));
    expect(wireBytes({ ...target, turns: [...first, tail] }, version)).toBe(
      ACP_CONVERSATION_RESPONSE_MAX_BYTES + delta
    );
    const read = () =>
      paginateAcpConversation(metadata(), [...first, tail], [], null, undefined, version);
    if (version === 1 && delta > 0) {
      expect(read).toThrow("acp_conversation_client_upgrade_required");
      return;
    }
    const page = read();
    expect(page).toEqual(
      delta > 0
        ? {
            ...metadata(),
            turns: first,
            turnCursor: first[9]!.turnId,
            hasMore: true,
            hasMoreTurns: true
          }
        : { ...target, turns: [...first, tail] }
    );
    expect(
      Buffer.byteLength(JSON.stringify(acpConversationWirePage(page, version)))
    ).toBeLessThanOrEqual(ACP_CONVERSATION_RESPONSE_MAX_BYTES);
    if (delta > 0) {
      const resumed = paginateAcpConversation(
        metadata(),
        [...first, tail],
        [],
        page.turnCursor,
        undefined,
        version
      );
      expect(resumed).toEqual({
        ...metadata(),
        retention: undefined,
        turns: [tail],
        turnCursor: tail.turnId
      });
      expect(Object.hasOwn(resumed, "retention")).toBe(false);
    }
  });

  it.each(
    versions
  )("returns stable v%i empty and continuation pages and rejects missing turn cursors", (version) => {
    const empty = paginateAcpConversation(metadata(10), [], [], null, undefined, version);
    expect(empty).toEqual(metadata(10));
    const turns = [turn(0)];
    const continued = paginateAcpConversation(
      metadata(10),
      turns,
      [],
      turns[0]!.turnId,
      undefined,
      version
    );
    expect(continued).toEqual({
      ...metadata(10),
      retention: undefined,
      turnCursor: turns[0]!.turnId
    });
    expect(Object.hasOwn(continued, "retention")).toBe(false);
    expect(() =>
      paginateAcpConversation(metadata(), turns, [], "missing", undefined, version)
    ).toThrow("acp_conversation_turn_cursor_invalid");
  });

  it.each([
    2, 3
  ] as const)("traverses v%i turns and mixed events without loss or duplicate overlap", (version) => {
    const turns = Array.from({ length: 24 }, (_, index) => turn(index, "\u0001".repeat(64 * 1024)));
    const rows = Array.from({ length: 132 }, (_, index) => ({
      cursor: index + 1,
      event:
        index % 2
          ? event(index)
          : acpConversationEventSchema.parse({
              ...event(index),
              payload: { kind: "status", status: "completed", error: null }
            })
    }));
    let cursor = 0;
    let turnCursor: string | null = null;
    const receivedTurns: Turn[] = [];
    const receivedEvents: Event[] = [];
    const pages: AcpConversationOrderedPage[] = [];
    do {
      const page = paginateAcpConversation(
        metadata(cursor),
        turns,
        rows.filter((row) => row.cursor > cursor),
        turnCursor,
        turns[2]!.turnId,
        version
      );
      expect(page.cursor > cursor || page.turnCursor !== turnCursor || !page.hasMore).toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify(acpConversationWirePage(page, version)))
      ).toBeLessThanOrEqual(ACP_CONVERSATION_RESPONSE_MAX_BYTES);
      if (pages.length) expect(Object.hasOwn(page, "retention")).toBe(false);
      pages.push(page);
      receivedTurns.push(...page.turns);
      receivedEvents.push(...page.events);
      cursor = page.cursor;
      turnCursor = page.turnCursor;
      expect(pages.length).toBeLessThan(10);
    } while (pages.at(-1)!.hasMore);
    expect(pages.length).toBeGreaterThan(1);
    expect(receivedTurns.map((value) => value.turnId)).toEqual([
      turns[2]!.turnId,
      turns[0]!.turnId,
      turns[1]!.turnId,
      ...turns.slice(3).map((value) => value.turnId)
    ]);
    expect(new Set(receivedTurns.map((value) => value.turnId)).size).toBe(turns.length);
    expect(receivedEvents).toEqual(rows.map((row) => row.event));
    expect(new Set(receivedEvents.map((value) => value.messageId)).size).toBe(rows.length);
    expect({ cursor, turnCursor, hasMore: pages.at(-1)!.hasMore }).toEqual({
      cursor: 132,
      turnCursor: turns.at(-1)!.turnId,
      hasMore: false
    });
  });
});
