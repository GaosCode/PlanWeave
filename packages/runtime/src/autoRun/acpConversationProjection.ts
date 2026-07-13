import { z } from "zod";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

export const acpConversationItemSchema = z
  .object({
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    kind: z.enum([
      "message",
      "tool_call",
      "tool_update",
      "plan_update",
      "terminal_output",
      "output"
    ]),
    role: z.enum(["assistant", "user"]).optional(),
    content: z.string()
  })
  .strict();
export type AcpConversationItem = z.infer<typeof acpConversationItemSchema>;

function projectionItem(event: NormalizedRunnerEvent): AcpConversationItem | null {
  const body = event.body;
  if (body.kind === "message") return { sequence: event.sequence, timestamp: event.timestamp, kind: body.kind, role: body.role, content: body.content };
  if (body.kind === "tool_call") return { sequence: event.sequence, timestamp: event.timestamp, kind: body.kind, content: `${body.title}${body.content ? `\n${body.content.content}` : ""}` };
  if (body.kind === "tool_update") return { sequence: event.sequence, timestamp: event.timestamp, kind: body.kind, content: body.content?.content ?? body.status ?? "updated" };
  if (body.kind === "plan_update" || body.kind === "terminal_output" || body.kind === "output") return { sequence: event.sequence, timestamp: event.timestamp, kind: body.kind, content: body.content };
  return null;
}

export function projectAcpConversation(events: readonly NormalizedRunnerEvent[]): AcpConversationItem[] {
  const items: AcpConversationItem[] = [];
  let activeMessage: {
    index: number;
    role: "assistant" | "user";
    messageId: string | null;
  } | null = null;

  for (const event of events) {
    const item = projectionItem(event);
    if (item === null) continue;
    if (event.body.kind !== "message") {
      items.push(item);
      activeMessage = null;
      continue;
    }

    if (activeMessage !== null &&
      activeMessage.role === event.body.role &&
      ((activeMessage.messageId === null && event.body.messageId === null) ||
        (activeMessage.messageId !== null && activeMessage.messageId === event.body.messageId)) &&
      event.body.chunk) {
      const previous = items[activeMessage.index];
      if (!previous) throw new Error("ACP conversation message projection index is invalid.");
      items[activeMessage.index] = { ...previous, content: previous.content + item.content };
      continue;
    }

    items.push(item);
    activeMessage = event.body.chunk
      ? {
          index: items.length - 1,
          role: event.body.role,
          messageId: event.body.messageId
        }
      : null;
  }

  return items;
}
