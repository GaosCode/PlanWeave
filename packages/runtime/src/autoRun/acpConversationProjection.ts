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
  return events.map(projectionItem).filter((item): item is AcpConversationItem => item !== null);
}
