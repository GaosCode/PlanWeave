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
  const [jsonPath, markdownPath] = await Promise.all([
    resolveResultsPath(runDir, "conversation.json"),
    resolveResultsPath(runDir, "conversation.md")
  ]);
  await Promise.all([
    writeFile(
      jsonPath,
      `${JSON.stringify({ version: "planweave.conversation/v1", items }, null, 2)}\n`,
      "utf8"
    ),
    writeFile(markdownPath, markdown ? `${markdown}\n` : "", "utf8")
  ]);
}
