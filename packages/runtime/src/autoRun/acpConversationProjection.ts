import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

export type AcpConversationItem = {
  sequence: number;
  timestamp: string;
  kind: NormalizedRunnerEvent["body"]["kind"];
  role?: "assistant" | "user";
  content: string;
};

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

export async function writeAcpConversationProjection(runDir: string, events: readonly NormalizedRunnerEvent[]): Promise<void> {
  const items = projectAcpConversation(events);
  const markdown = items.map((item) => `## ${item.role ?? item.kind} · ${item.sequence}\n\n${item.content}`).join("\n\n");
  await Promise.all([
    writeFile(join(runDir, "conversation.json"), `${JSON.stringify({ version: "planweave.conversation/v1", items }, null, 2)}\n`, "utf8"),
    writeFile(join(runDir, "conversation.md"), markdown ? `${markdown}\n` : "", "utf8")
  ]);
}
