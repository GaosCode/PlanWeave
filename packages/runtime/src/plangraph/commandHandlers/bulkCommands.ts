import { parseBlockRef } from "../../graph/compileTaskGraph.js";
import {
  buildPlanPackageBlockFieldEditMutation,
  buildPlanPackageExecutionPolicyFieldEditManifest
} from "../../graph/fieldEditMutation.js";
import {
  buildPlanPackageManifestChangeMutation,
  type PlanPackageGraphMutationSideEffect
} from "../../graph/mutation.js";
import type {
  BulkUpdateBlocksCommand,
  BulkUpdateParallelPolicyCommand,
  PlanGraphCommand
} from "../commands.js";
import type { LoadedPlanGraphPackage } from "../packageRepository.js";
import { inverseBlockFieldsCommand } from "./blockCommands.js";
import { isPlanGraphCommandDiagnostic, type PlanGraphCommandHandler } from "./types.js";

function bulkBlockMutation(loaded: LoadedPlanGraphPackage, command: BulkUpdateBlocksCommand) {
  let nextManifest = loaded.manifest;
  const affectedTasks: string[] = [];
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const update of command.updates) {
    const mutation = buildPlanPackageBlockFieldEditMutation(nextManifest, {
      blockRef: update.blockRef,
      ...update.fields
    });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, mutation.taskId);
    sideEffects.push(...mutation.sideEffects);
  }
  return buildPlanPackageManifestChangeMutation(loaded.manifest, nextManifest, {
    affectedTasks,
    sideEffects
  });
}

function bulkParallelPolicyMutation(
  loaded: LoadedPlanGraphPackage,
  command: BulkUpdateParallelPolicyCommand
) {
  if (!command.canvasPolicy && command.blocks.length === 0) {
    throw new Error(
      "bulk_update_parallel_policy requires canvasPolicy or at least one block update."
    );
  }
  let nextManifest = command.canvasPolicy
    ? buildPlanPackageExecutionPolicyFieldEditManifest(loaded.manifest, command.canvasPolicy)
    : loaded.manifest;
  const affectedTasks = command.canvasPolicy ? nextManifest.nodes.map((node) => node.id) : [];
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const update of command.blocks) {
    const mutation = buildPlanPackageBlockFieldEditMutation(nextManifest, {
      blockRef: update.blockRef,
      sharedResources: update.input.sharedResources
    });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, mutation.taskId);
    sideEffects.push(...mutation.sideEffects);
  }
  return buildPlanPackageManifestChangeMutation(loaded.manifest, nextManifest, {
    affectedTasks,
    sideEffects
  });
}

type BulkCommand = BulkUpdateBlocksCommand | BulkUpdateParallelPolicyCommand;

export const bulkCommandHandler: PlanGraphCommandHandler<BulkCommand> = {
  family: "bulk",
  commandTypes: ["bulkUpdateBlocks", "bulkUpdateParallelPolicy"],
  handles(command: PlanGraphCommand): command is BulkCommand {
    return command.type === "bulkUpdateBlocks" || command.type === "bulkUpdateParallelPolicy";
  },
  mutation(loaded, command) {
    return command.type === "bulkUpdateBlocks"
      ? bulkBlockMutation(loaded, command)
      : bulkParallelPolicyMutation(loaded, command);
  },
  inverse(loaded, command) {
    if (command.type === "bulkUpdateParallelPolicy") {
      const canvasPolicy: BulkUpdateParallelPolicyCommand["canvasPolicy"] = {};
      if (command.canvasPolicy?.defaultExecutor !== undefined) {
        canvasPolicy.defaultExecutor = loaded.manifest.execution.defaultExecutor ?? null;
      }
      if (command.canvasPolicy?.parallelEnabled !== undefined) {
        canvasPolicy.parallelEnabled = loaded.manifest.execution.parallel.enabled;
      }
      if (command.canvasPolicy?.maxConcurrent !== undefined) {
        canvasPolicy.maxConcurrent = loaded.manifest.execution.parallel.maxConcurrent;
      }
      const blocks: BulkUpdateParallelPolicyCommand["blocks"] = [];
      for (const update of command.blocks) {
        const inverse = inverseBlockFieldsCommand(loaded, {
          type: "updateBlockFields",
          blockRef: update.blockRef,
          fields: { sharedResources: update.input.sharedResources }
        });
        if (isPlanGraphCommandDiagnostic(inverse)) {
          return inverse;
        }
        blocks.push({
          blockRef: inverse.blockRef,
          input: { sharedResources: inverse.fields.sharedResources }
        });
      }
      return {
        type: "bulkUpdateParallelPolicy",
        canvasPolicy: command.canvasPolicy ? canvasPolicy : undefined,
        blocks
      };
    }
    const updates: BulkUpdateBlocksCommand["updates"] = [];
    for (const update of command.updates) {
      const inverse = inverseBlockFieldsCommand(loaded, {
        type: "updateBlockFields",
        blockRef: update.blockRef,
        fields: update.fields
      });
      if (isPlanGraphCommandDiagnostic(inverse)) {
        return inverse;
      }
      updates.push({ blockRef: inverse.blockRef, fields: inverse.fields });
    }
    return { type: "bulkUpdateBlocks", updates };
  },
  touchedRefs(command, loaded) {
    const tasks: string[] =
      command.type === "bulkUpdateParallelPolicy" && command.canvasPolicy
        ? loaded.manifest.nodes.map((node) => node.id)
        : [];
    const blocks: string[] = [];
    const updates = command.type === "bulkUpdateBlocks" ? command.updates : command.blocks;
    for (const update of updates) {
      tasks.push(parseBlockRef(update.blockRef).taskId);
      blocks.push(update.blockRef);
    }
    return { tasks, blocks };
  }
};
