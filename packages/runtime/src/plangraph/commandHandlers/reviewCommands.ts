import {
  buildPlanPackageManifestChangeMutation,
  writePromptSideEffects,
  type PlanPackageGraphMutation
} from "../../graph/mutation.js";
import type { ManifestTaskNode } from "../../types.js";
import type {
  PlanGraphCommand,
  PlanGraphCommandDiagnostic,
  UpdateReviewPipelineCommand
} from "../commands.js";
import type { LoadedPlanGraphPackage } from "../packageRepository.js";
import {
  diagnostic,
  promptMarkdown,
  taskFromManifest,
  type PlanGraphCommandHandler
} from "./types.js";

export const reviewCommandHandler: PlanGraphCommandHandler<UpdateReviewPipelineCommand> = {
  family: "review",
  commandTypes: ["updateReviewPipeline"],
  handles(command: PlanGraphCommand): command is UpdateReviewPipelineCommand {
    return command.type === "updateReviewPipeline";
  },
  mutation(
    loaded: LoadedPlanGraphPackage,
    command: UpdateReviewPipelineCommand
  ): PlanPackageGraphMutation | PlanGraphCommandDiagnostic {
    const task = taskFromManifest(loaded.manifest, command.taskId);
    if (!task) {
      return diagnostic("task_missing", `Task '${command.taskId}' does not exist.`, command.taskId);
    }
    const reviewPromptPaths = new Set(command.reviewBlocks.map((block) => block.prompt));
    const removedPrompts = task.blocks
      .filter((block) => block.type === "review" && !reviewPromptPaths.has(block.prompt))
      .map((block) => ({ kind: "removePrompt" as const, packagePath: block.prompt }));
    const promptMarkdownByBlockId = new Map(
      command.promptMarkdownByBlockId.map((item) => [item.blockId, item.markdown])
    );
    const sideEffects = [
      ...removedPrompts,
      ...command.reviewBlocks.flatMap((block) =>
        writePromptSideEffects(block.prompt, promptMarkdownByBlockId.get(block.id) ?? "")
      )
    ];
    const nextTask: ManifestTaskNode = {
      ...task,
      blocks: [...task.blocks.filter((block) => block.type !== "review"), ...command.reviewBlocks]
    };
    return buildPlanPackageManifestChangeMutation(
      loaded.manifest,
      {
        ...loaded.manifest,
        review: { ...command.packageDefaults },
        nodes: loaded.manifest.nodes.map((node) =>
          node.type === "task" && node.id === command.taskId ? nextTask : node
        )
      },
      { affectedTasks: [command.taskId], sideEffects }
    );
  },
  inverse(
    loaded: LoadedPlanGraphPackage,
    command: UpdateReviewPipelineCommand
  ): PlanGraphCommand | PlanGraphCommandDiagnostic {
    const task = taskFromManifest(loaded.manifest, command.taskId);
    if (!task) {
      return diagnostic("task_missing", `Task '${command.taskId}' does not exist.`, command.taskId);
    }
    const promptMarkdownByBlockId: Array<{ blockId: string; markdown: string }> = [];
    for (const block of task.blocks) {
      if (block.type !== "review") {
        continue;
      }
      const markdown = promptMarkdown(loaded, block.prompt);
      if (markdown === undefined) {
        return diagnostic(
          "prompt_missing",
          `Prompt for block '${command.taskId}#${block.id}' is not indexed.`,
          block.prompt
        );
      }
      promptMarkdownByBlockId.push({ blockId: block.id, markdown });
    }
    return {
      type: "updateReviewPipeline",
      taskId: command.taskId,
      packageDefaults: { ...loaded.manifest.review },
      reviewBlocks: task.blocks
        .filter((block) => block.type === "review")
        .map((block) => structuredClone(block)),
      promptMarkdownByBlockId
    };
  },
  touchedRefs(command: UpdateReviewPipelineCommand): { tasks: string[]; blocks: string[] } {
    return {
      tasks: [command.taskId],
      blocks: command.reviewBlocks.map((block) => `${command.taskId}#${block.id}`)
    };
  }
};
