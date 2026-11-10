import { z } from "zod";
import {
  writePromptSideEffects,
  type PlanPackageGraphMutationSideEffect
} from "../graph/mutation.js";
import { promptIdentity } from "../graph/promptIdentity.js";
import type { UpdateReviewPipelineCommand } from "./commands.js";

export const reviewPipelinePromptWriteSchema = z
  .object({
    blockId: z.string(),
    markdown: z.string(),
    intent: z.literal("restore").optional()
  })
  .strict();

export type ReviewPipelinePromptWrite = z.infer<typeof reviewPipelinePromptWriteSchema>;

export function reviewPipelinePromptSideEffects(
  command: UpdateReviewPipelineCommand
): PlanPackageGraphMutationSideEffect[] {
  const writes = new Map(command.promptMarkdownByBlockId.map((item) => [item.blockId, item]));
  return command.reviewBlocks.flatMap((block) =>
    writePromptSideEffects(block.prompt, writes.get(block.id)?.markdown ?? "").map((effect) =>
      writes.get(block.id)?.intent === "restore" && effect.kind === "writePrompt"
        ? { ...effect, preserveReferenced: true as const }
        : effect
    )
  );
}

export async function reviewPipelineSnapshotCommand(
  snapshot: UpdateReviewPipelineCommand,
  packageDir: string,
  forwardWrites: PlanPackageGraphMutationSideEffect[]
): Promise<UpdateReviewPipelineCommand> {
  const writtenPaths = new Map(
    await Promise.all(
      forwardWrites
        .filter((effect) => effect.kind === "writePrompt")
        .map(
          async (effect) =>
            [(await promptIdentity(packageDir, effect.packagePath)).path, effect.markdown] as const
        )
    )
  );
  const snapshotPaths = new Map(
    await Promise.all(
      snapshot.reviewBlocks.map(
        async (block) => [block.id, (await promptIdentity(packageDir, block.prompt)).path] as const
      )
    )
  );
  return {
    ...snapshot,
    promptMarkdownByBlockId: snapshot.promptMarkdownByBlockId.map((item) => {
      const path = snapshotPaths.get(item.blockId);
      const edited =
        path !== undefined && writtenPaths.has(path) && writtenPaths.get(path) !== item.markdown;
      return edited
        ? { blockId: item.blockId, markdown: item.markdown }
        : { ...item, intent: "restore" };
    })
  };
}
