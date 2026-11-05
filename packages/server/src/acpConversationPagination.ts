import {
  acpConversationPaginatedPageSchema,
  acpConversationOrderedPageSchema,
  acpConversationLegacyPageSchema,
  type AcpConversationOrderedPage,
  type AcpConversationPageVersion
} from "@planweave-ai/agent-host-protocol";
import { ACP_CONVERSATION_RESPONSE_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";

type Turn = AcpConversationOrderedPage["turns"][number];
type EventRow = { cursor: number; event: AcpConversationOrderedPage["events"][number] };

function acpConversationWireTurn(turn: Turn, version: AcpConversationPageVersion) {
  if (version === 3) return turn;
  const { turnOrder: _order, ...unsequenced } = turn;
  return unsequenced;
}

export function acpConversationWirePage(
  page: AcpConversationOrderedPage,
  version: AcpConversationPageVersion
) {
  if (version === 3) return page;
  const unsequenced = {
    ...page,
    turns: page.turns.map((turn) => acpConversationWireTurn(turn, version))
  };
  if (version === 2) return acpConversationPaginatedPageSchema.parse(unsequenced);
  const { turnCursor: _cursor, hasMoreTurns: _hasMore, ...legacy } = unsequenced;
  return acpConversationLegacyPageSchema.parse(legacy);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function acpConversationPageByteCounter(
  page: AcpConversationOrderedPage,
  version: AcpConversationPageVersion
) {
  let bytes = jsonBytes(acpConversationWirePage({ ...page, turns: [], events: [] }, version));
  for (const [index, turn] of page.turns.entries())
    bytes += jsonBytes(acpConversationWireTurn(turn, version)) + (index > 0 ? 1 : 0);
  for (const [index, event] of page.events.entries())
    bytes += jsonBytes(event) + (index > 0 ? 1 : 0);
  return {
    fits: () => bytes <= ACP_CONVERSATION_RESPONSE_MAX_BYTES,
    setMetadata<Key extends "turnCursor" | "hasMoreTurns" | "cursor" | "hasMore">(
      key: Key,
      value: AcpConversationOrderedPage[Key]
    ) {
      const previous = page[key];
      page[key] = value;
      if (previous === value || (version === 1 && (key === "turnCursor" || key === "hasMoreTurns")))
        return;
      bytes += jsonBytes(value) - jsonBytes(previous);
    },
    addTurn(turn: Turn) {
      const added =
        jsonBytes(acpConversationWireTurn(turn, version)) + (page.turns.length > 1 ? 1 : 0);
      bytes += added;
      return added;
    },
    addEvent(event: EventRow["event"]) {
      const added = jsonBytes(event) + (page.events.length > 1 ? 1 : 0);
      bytes += added;
      return added;
    },
    remove(removed: number) {
      bytes -= removed;
    }
  };
}

export function paginateAcpConversation(
  page: AcpConversationOrderedPage,
  turns: Turn[],
  rows: EventRow[],
  afterTurnId: string | null,
  priorityTurnId?: string,
  version: AcpConversationPageVersion = 2
): AcpConversationOrderedPage {
  const start =
    afterTurnId === null ? 0 : turns.findIndex((turn) => turn.turnId === afterTurnId) + 1;
  if (afterTurnId !== null && start === 0) throw new Error("acp_conversation_turn_cursor_invalid");
  page.turnCursor = afterTurnId;
  page.hasMoreTurns = start < turns.length;
  page.hasMore = page.hasMoreTurns || rows.length > 0;
  if (afterTurnId !== null) delete page.retention;
  const counter = acpConversationPageByteCounter(page, version);
  if (!counter.fits())
    throw new Error(
      version === 1
        ? "acp_conversation_client_upgrade_required"
        : "acp_conversation_metadata_too_large"
    );
  if (afterTurnId === null) {
    const priority =
      turns.find((turn) => turn.turnId === priorityTurnId) ??
      turns.find((turn) => turn.status === "queued" || turn.status === "running");
    if (priority) {
      page.turns.push(priority);
      counter.addTurn(priority);
    }
  }
  let next = start;
  for (; next < turns.length; next++) {
    const turn = turns[next]!;
    const prior = page.turnCursor;
    const included = page.turns.some((item) => item.turnId === turn.turnId);
    if (!included) page.turns.push(turn);
    const added = included ? 0 : counter.addTurn(turn);
    counter.setMetadata("turnCursor", turn.turnId);
    counter.setMetadata("hasMoreTurns", next + 1 < turns.length);
    counter.setMetadata("hasMore", page.hasMoreTurns || rows.length > 0);
    if (counter.fits()) continue;
    if (!included) {
      page.turns.pop();
      counter.remove(added);
    }
    counter.setMetadata("turnCursor", prior);
    counter.setMetadata("hasMoreTurns", true);
    counter.setMetadata("hasMore", true);
    break;
  }
  if (version === 1 && page.hasMoreTurns)
    throw new Error("acp_conversation_client_upgrade_required");
  for (const row of rows.slice(0, 128)) {
    const prior = page.cursor;
    page.events.push(row.event);
    const added = counter.addEvent(row.event);
    counter.setMetadata("cursor", row.cursor);
    counter.setMetadata("hasMore", page.hasMoreTurns || page.events.length < rows.length);
    if (counter.fits()) continue;
    page.events.pop();
    counter.remove(added);
    counter.setMetadata("cursor", prior);
    counter.setMetadata("hasMore", true);
    break;
  }
  if (page.hasMore && !page.events.length && (version === 1 || page.turnCursor === afterTurnId))
    throw new Error(
      version === 1
        ? "acp_conversation_client_upgrade_required"
        : "acp_conversation_page_item_too_large"
    );
  if (jsonBytes(acpConversationWirePage(page, version)) > ACP_CONVERSATION_RESPONSE_MAX_BYTES)
    throw new Error("acp_conversation_page_item_too_large");
  return acpConversationOrderedPageSchema.parse(page);
}
