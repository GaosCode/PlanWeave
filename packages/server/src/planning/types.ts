export type Room = { id: string; projectId: string; name: string; createdAt: string; archivedAt: string | null };
export type MessageKind = "text" | "system";
export type Message = { id: string; roomId: string; authorUserId: string; body: string; kind: MessageKind; createdAt: string; supersedesMessageId: string | null };

export function isMessageKind(value: unknown): value is MessageKind {
  return value === "text" || value === "system";
}
