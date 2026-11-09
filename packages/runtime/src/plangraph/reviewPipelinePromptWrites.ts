import { z } from "zod";
import type { UpdateReviewPipelineCommand } from "./commands.js";

export const reviewPipelinePromptWriteSchema = z
  .object({
    blockId: z.string(),
    markdown: z.string(),
    intent: z.literal("restore").optional()
  })
  .strict();

export type ReviewPipelinePromptWrite = z.infer<typeof reviewPipelinePromptWriteSchema>;

export function reviewPipelineSnapshotCommand(
  snapshot: UpdateReviewPipelineCommand,
  forward: UpdateReviewPipelineCommand
): UpdateReviewPipelineCommand {
  const retainedIds = new Set(forward.reviewBlocks.map((block) => block.id));
  const forwardWrites = new Map(
    forward.promptMarkdownByBlockId.map((item) => [item.blockId, item])
  );
  return {
    ...snapshot,
    promptMarkdownByBlockId: snapshot.promptMarkdownByBlockId.map((item) => {
      if (item.intent === "restore") return item;
      const write = forwardWrites.get(item.blockId);
      const edited =
        retainedIds.has(item.blockId) &&
        write !== undefined &&
        write.intent !== "restore" &&
        write.markdown !== item.markdown;
      return edited ? item : { ...item, intent: "restore" };
    })
  };
}
