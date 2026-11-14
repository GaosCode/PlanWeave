import { resolveResultsPath } from "../taskManager/resultPaths.js";
import { writeFile } from "node:fs/promises";
import { projectAcpConversation } from "./acpConversationProjection.js";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

export async function writeAcpConversationProjection(
  runDir: string,
  events: readonly NormalizedRunnerEvent[]
): Promise<void> {
  const items = projectAcpConversation(events);
  const markdown = items
    .map((item) => `## ${item.role ?? item.kind} · ${item.sequence}\n\n${item.content}`)
    .join("\n\n");
  await Promise.all([
    writeFile(
      await resolveResultsPath(runDir, "conversation.json"),
      `${JSON.stringify({ version: "planweave.conversation/v1", items }, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      await resolveResultsPath(runDir, "conversation.md"),
      markdown ? `${markdown}\n` : "",
      "utf8"
    )
  ]);
}
