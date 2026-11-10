import { readFile } from "node:fs/promises";
import {
  writePromptSideEffects,
  type PlanPackageGraphMutation,
  type PlanPackageGraphMutationSideEffect
} from "../graph/mutation.js";
import { promptIdentity } from "../graph/promptIdentity.js";
import type { ReviewPipelinePromptFileRestore } from "./reviewPipelinePromptSchema.js";
import type { UpdateReviewPipelineCommand } from "./commands.js";

export function reviewPipelinePromptSideEffects(
  command: UpdateReviewPipelineCommand
): PlanPackageGraphMutationSideEffect[] {
  const writes = new Map(command.promptMarkdownByBlockId.map((item) => [item.blockId, item]));
  return [
    ...command.reviewBlocks.flatMap((block) =>
      writePromptSideEffects(block.prompt, writes.get(block.id)?.markdown ?? "").map((effect) =>
        writes.get(block.id)?.intent === "restore" && effect.kind === "writePrompt"
          ? { ...effect, preserveReferenced: true as const }
          : effect
      )
    ),
    ...(command.promptFileRestores ?? []).flatMap((file) =>
      writePromptSideEffects(file.packagePath, file.markdown)
    )
  ];
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

export async function prepareReviewPipelineMutation(
  command: UpdateReviewPipelineCommand,
  mutation: PlanPackageGraphMutation,
  packageDir: string
): Promise<PlanPackageGraphMutation> {
  if (!command.promptFileRestores?.length) return mutation;
  const retainedFiles = new Set(
    await Promise.all(
      command.promptFileRestores.map(
        async (file) => (await promptIdentity(packageDir, file.packagePath)).path
      )
    )
  );
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const effect of mutation.sideEffects) {
    if (
      effect.kind === "removePrompt" &&
      retainedFiles.has((await promptIdentity(packageDir, effect.packagePath)).path)
    )
      continue;
    sideEffects.push(effect);
  }
  return { ...mutation, sideEffects };
}

export async function prepareReviewPipelineInverse(
  snapshot: UpdateReviewPipelineCommand,
  packageDir: string,
  forwardWrites: PlanPackageGraphMutationSideEffect[]
): Promise<UpdateReviewPipelineCommand> {
  const pipeline = await reviewPipelineSnapshotCommand(snapshot, packageDir, forwardWrites);
  const captured = new Set(
    await Promise.all(
      snapshot.reviewBlocks.map(
        async (block) => (await promptIdentity(packageDir, block.prompt)).path
      )
    )
  );
  const promptFileRestores: ReviewPipelinePromptFileRestore[] = [];
  for (const effect of forwardWrites) {
    if (effect.kind !== "writePrompt") continue;
    const identity = await promptIdentity(packageDir, effect.packagePath);
    if (!identity.exists || captured.has(identity.path)) continue;
    promptFileRestores.push({
      packagePath: effect.packagePath,
      markdown: await readFile(identity.path, "utf8")
    });
    captured.add(identity.path);
  }
  return promptFileRestores.length === 0 ? pipeline : { ...pipeline, promptFileRestores };
}
