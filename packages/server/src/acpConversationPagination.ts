import {
  acpConversationPageSchema,
  acpConversationLegacyPageSchema,
  type AcpConversationPage,
  type AcpConversationPageVersion
} from "@planweave-ai/agent-host-protocol";
import { ACP_CONVERSATION_RESPONSE_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";

type Turn = AcpConversationPage["turns"][number];
type EventRow = { cursor: number; event: AcpConversationPage["events"][number] };

export function acpConversationWirePage(
  page: AcpConversationPage,
  version: AcpConversationPageVersion
) {
  if (version === 2) return page;
  const { turnCursor: _cursor, hasMoreTurns: _hasMore, ...legacy } = page;
  return acpConversationLegacyPageSchema.parse(legacy);
}

export function paginateAcpConversation(
  page: AcpConversationPage,
  turns: Turn[],
  rows: EventRow[],
  afterTurnId: string | null,
  priorityTurnId?: string,
  version: AcpConversationPageVersion = 2
): AcpConversationPage {
  const start =
    afterTurnId === null ? 0 : turns.findIndex((turn) => turn.turnId === afterTurnId) + 1;
  if (afterTurnId !== null && start === 0) throw new Error("acp_conversation_turn_cursor_invalid");
  const fits = () =>
    Buffer.byteLength(JSON.stringify(acpConversationWirePage(page, version))) <=
    ACP_CONVERSATION_RESPONSE_MAX_BYTES;
  page.turnCursor = afterTurnId;
  page.hasMoreTurns = start < turns.length;
  page.hasMore = page.hasMoreTurns || rows.length > 0;
  if (afterTurnId !== null) delete page.retention;
  if (!fits())
    throw new Error(
      version === 1
        ? "acp_conversation_client_upgrade_required"
        : "acp_conversation_metadata_too_large"
    );
  if (afterTurnId === null) {
    const priority =
      turns.find((turn) => turn.turnId === priorityTurnId) ??
      turns.find((turn) => turn.status === "queued" || turn.status === "running");
    if (priority) page.turns.push(priority);
  }
  let next = start;
  for (; next < turns.length; next++) {
    const turn = turns[next]!;
    const prior = page.turnCursor;
    const included = page.turns.some((item) => item.turnId === turn.turnId);
    if (!included) page.turns.push(turn);
    page.turnCursor = turn.turnId;
    page.hasMoreTurns = next + 1 < turns.length;
    page.hasMore = page.hasMoreTurns || rows.length > 0;
    if (fits()) continue;
    if (!included) page.turns.pop();
    page.turnCursor = prior;
    page.hasMoreTurns = true;
    page.hasMore = true;
    break;
  }
  if (version === 1 && page.hasMoreTurns)
    throw new Error("acp_conversation_client_upgrade_required");
  for (const row of rows.slice(0, 128)) {
    const prior = page.cursor;
    page.events.push(row.event);
    page.cursor = row.cursor;
    page.hasMore = page.hasMoreTurns || page.events.length < rows.length;
    if (fits()) continue;
    page.events.pop();
    page.cursor = prior;
    page.hasMore = true;
    break;
  }
  if (page.hasMore && !page.events.length && (version === 1 || page.turnCursor === afterTurnId))
    throw new Error(
      version === 1
        ? "acp_conversation_client_upgrade_required"
        : "acp_conversation_page_item_too_large"
    );
  if (!fits()) throw new Error("acp_conversation_page_item_too_large");
  return acpConversationPageSchema.parse(page);
}
