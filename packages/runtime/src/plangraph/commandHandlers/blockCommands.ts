import { parseBlockRef } from "../../graph/compileTaskGraph.js";
import { buildPlanPackageBlockFieldEditMutation } from "../../graph/fieldEditMutation.js";
import {
  buildPlanPackageManifestChangeMutation,
  buildPlanPackageGraphMutation,
  writePromptSideEffects,
  type PlanPackageGraphMutation
} from "../../graph/mutation.js";
import type { ManifestTaskNode } from "../../types.js";
import type {
  AddBlockCommand,
  BlockComponentSnapshot,
  PlanGraphCommand,
  PlanGraphCommandDiagnostic,
  RemoveBlockCommand,
  RestoreBlockCommand,
  UpdateBlockFieldsCommand,
  UpdateBlockPromptCommand
} from "../commands.js";
import type { LoadedPlanGraphPackage } from "../packageRepository.js";
import {
  blockFromManifest,
  diagnostic,
  promptMarkdown,
  snapshotOrDiagnostic,
  taskFromManifest,
  type PlanGraphCommandHandler
} from "./types.js";

type BlockCommand =
  | UpdateBlockPromptCommand
  | UpdateBlockFieldsCommand
  | AddBlockCommand
  | RemoveBlockCommand
  | RestoreBlockCommand;

function readBlockSnapshot(
  loaded: LoadedPlanGraphPackage,
  blockRef: string
): BlockComponentSnapshot | PlanGraphCommandDiagnostic {
  const current = blockFromManifest(loaded.manifest, blockRef);
  if (!current) {
    return diagnostic("block_missing", `Block '${blockRef}' does not exist.`, blockRef);
  }
  const { blockId } = parseBlockRef(blockRef);
  const insertIndex = current.task.blocks.findIndex((candidate) => candidate.id === blockId);
  const markdown = promptMarkdown(loaded, current.block.prompt);
  if (markdown === undefined) {
    return diagnostic(
      "prompt_missing",
      `Prompt '${current.block.prompt}' is not indexed.`,
      current.block.prompt
    );
  }
  return {
    taskId: current.task.id,
    block: structuredClone(current.block),
    promptMarkdown: markdown,
    insertIndex: insertIndex >= 0 ? insertIndex : null,
    affectedDependsOn: current.task.blocks
      .filter((block) => block.depends_on.includes(blockId))
      .map((block) => ({
        blockRef: `${current.task.id}#${block.id}`,
        dependsOn: [...block.depends_on]
      }))
  };
}

function blockSnapshotMutation(
  loaded: LoadedPlanGraphPackage,
  task: ManifestTaskNode,
  snapshot: BlockComponentSnapshot
): PlanPackageGraphMutation {
  const insertIndex =
    snapshot.insertIndex === null
      ? task.blocks.length
      : Math.max(0, Math.min(snapshot.insertIndex, task.blocks.length));
  const blocksWithRestoredBlock = [
    ...task.blocks.slice(0, insertIndex),
    snapshot.block,
    ...task.blocks.slice(insertIndex)
  ];
  const nextTask: ManifestTaskNode = {
    ...task,
    blocks: blocksWithRestoredBlock.map((block) => {
      const ref = `${task.id}#${block.id}`;
      const affected = snapshot.affectedDependsOn.find((item) => item.blockRef === ref);
      return affected ? { ...block, depends_on: [...affected.dependsOn] } : block;
    })
  };
  return buildPlanPackageManifestChangeMutation(
    loaded.manifest,
    {
      ...loaded.manifest,
      nodes: loaded.manifest.nodes.map((node) =>
        node.type === "task" && node.id === task.id ? nextTask : node
      )
    },
    {
      affectedTasks: [task.id],
      sideEffects: writePromptSideEffects(snapshot.block.prompt, snapshot.promptMarkdown)
    }
  );
}

export const blockCommandHandler: PlanGraphCommandHandler<BlockCommand> = {
  family: "block",
  commandTypes: [
    "updateBlockPrompt",
    "updateBlockFields",
    "addBlock",
    "removeBlock",
    "restoreBlock"
  ],
  handles(command: PlanGraphCommand): command is BlockCommand {
    return (
      command.type === "updateBlockPrompt" ||
      command.type === "updateBlockFields" ||
      command.type === "addBlock" ||
      command.type === "removeBlock" ||
      command.type === "restoreBlock"
    );
  },
  mutation(
    loaded: LoadedPlanGraphPackage,
    command: BlockCommand
  ): PlanPackageGraphMutation | PlanGraphCommandDiagnostic {
    if (command.type === "updateBlockPrompt") {
      return buildPlanPackageBlockFieldEditMutation(loaded.manifest, {
        blockRef: command.blockRef,
        promptMarkdown: command.promptMarkdown
      });
    }
    if (command.type === "updateBlockFields") {
      return buildPlanPackageBlockFieldEditMutation(loaded.manifest, {
        blockRef: command.blockRef,
        title: command.fields.title,
        promptMarkdown: command.fields.promptMarkdown,
        executor: command.fields.executor,
        dependsOn: command.fields.dependsOn,
        parallelSafe: command.fields.parallelSafe,
        exclusive: command.fields.exclusive,
        parallelLocks: command.fields.parallelLocks,
        sharedResources: command.fields.sharedResources,
        reviewRequired: command.fields.reviewRequired,
        maxFeedbackCycles: command.fields.maxFeedbackCycles,
        reviewHook: command.fields.reviewHook
      });
    }
    if (command.type === "addBlock" || command.type === "restoreBlock") {
      const task = taskFromManifest(loaded.manifest, command.snapshot.taskId);
      if (!task) {
        return diagnostic(
          "task_missing",
          `Task '${command.snapshot.taskId}' does not exist.`,
          command.snapshot.taskId
        );
      }
      if (task.blocks.some((block) => block.id === command.snapshot.block.id)) {
        return diagnostic(
          "block_duplicate",
          `Block '${command.snapshot.taskId}#${command.snapshot.block.id}' already exists.`,
          command.snapshot.block.id
        );
      }
      return blockSnapshotMutation(loaded, task, command.snapshot);
    }
    if (!blockFromManifest(loaded.manifest, command.blockRef)) {
      return diagnostic(
        "block_missing",
        `Block '${command.blockRef}' does not exist.`,
        command.blockRef
      );
    }
    return buildPlanPackageGraphMutation(loaded.manifest, {
      kind: "removeBlock",
      blockRef: command.blockRef
    });
  },
  inverse(
    loaded: LoadedPlanGraphPackage,
    command: BlockCommand
  ): PlanGraphCommand | PlanGraphCommandDiagnostic {
    if (command.type === "updateBlockPrompt") {
      const current = blockFromManifest(loaded.manifest, command.blockRef);
      const markdown = current ? promptMarkdown(loaded, current.block.prompt) : undefined;
      return markdown === undefined
        ? diagnostic(
            "prompt_missing",
            `Prompt for block '${command.blockRef}' is not indexed.`,
            command.blockRef
          )
        : {
            type: "updateBlockPrompt",
            blockRef: command.blockRef,
            promptMarkdown: markdown
          };
    }
    if (command.type === "updateBlockFields") {
      const current = blockFromManifest(loaded.manifest, command.blockRef);
      if (!current) {
        return diagnostic(
          "block_missing",
          `Block '${command.blockRef}' does not exist.`,
          command.blockRef
        );
      }
      const fields: UpdateBlockFieldsCommand["fields"] = {};
      if (command.fields.title !== undefined) {
        fields.title = current.block.title;
      }
      if (command.fields.promptMarkdown !== undefined) {
        const markdown = promptMarkdown(loaded, current.block.prompt);
        if (markdown === undefined) {
          return diagnostic(
            "prompt_missing",
            `Prompt for block '${command.blockRef}' is not indexed.`,
            command.blockRef
          );
        }
        fields.promptMarkdown = markdown;
      }
      if (command.fields.executor !== undefined) {
        fields.executor = current.block.executor ?? null;
      }
      if (command.fields.dependsOn !== undefined) {
        fields.dependsOn = [...current.block.depends_on];
      }
      if (current.block.type === "implementation") {
        if (command.fields.parallelSafe !== undefined) {
          fields.parallelSafe = current.block.parallel.safe;
        }
        if (command.fields.exclusive !== undefined) {
          fields.exclusive = (current.block.parallel.locks ?? []).includes("exclusive");
        }
        if (command.fields.parallelLocks !== undefined) {
          fields.parallelLocks = [...current.block.parallel.locks];
        }
        if (command.fields.sharedResources !== undefined) {
          fields.sharedResources = [...(current.block.parallel.sharedResources ?? [])];
        }
      } else {
        if (command.fields.reviewRequired !== undefined) {
          fields.reviewRequired = current.block.review.required;
        }
        if (command.fields.maxFeedbackCycles !== undefined) {
          fields.maxFeedbackCycles = current.block.review.maxFeedbackCycles;
        }
        if (command.fields.reviewHook !== undefined) {
          fields.reviewHook = current.block.review.hook;
        }
      }
      return { type: "updateBlockFields", blockRef: command.blockRef, fields };
    }
    if (command.type === "addBlock" || command.type === "restoreBlock") {
      return {
        type: "removeBlock",
        blockRef: `${command.snapshot.taskId}#${command.snapshot.block.id}`
      };
    }
    return snapshotOrDiagnostic(readBlockSnapshot(loaded, command.blockRef), (snapshot) => ({
      type: "restoreBlock",
      snapshot
    }));
  },
  touchedRefs(
    command: BlockCommand,
    loaded: LoadedPlanGraphPackage
  ): { tasks: string[]; blocks: string[] } {
    if (command.type === "addBlock" || command.type === "restoreBlock") {
      return {
        tasks: [command.snapshot.taskId],
        blocks: [
          `${command.snapshot.taskId}#${command.snapshot.block.id}`,
          ...command.snapshot.affectedDependsOn.map((item) => item.blockRef)
        ]
      };
    }
    if (
      command.type === "updateBlockPrompt" ||
      command.type === "updateBlockFields" ||
      command.type === "removeBlock"
    ) {
      const { taskId, blockId } = parseBlockRef(command.blockRef);
      const task = taskFromManifest(loaded.manifest, taskId);
      const dependentBlocks =
        task?.blocks
          .filter((block) => block.depends_on.includes(blockId))
          .map((block) => `${taskId}#${block.id}`) ?? [];
      return { tasks: [taskId], blocks: [command.blockRef, ...dependentBlocks] };
    }
    return { tasks: [], blocks: [] };
  }
};
