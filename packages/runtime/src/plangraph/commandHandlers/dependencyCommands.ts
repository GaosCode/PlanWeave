import {
  buildPlanPackageManifestChangeMutation,
  buildPlanPackageGraphMutation,
  type PlanPackageGraphMutation
} from "../../graph/mutation.js";
import type { ManifestEdge, PlanPackageManifest } from "../../types.js";
import type {
  AddTaskDependencyCommand,
  PlanGraphCommand,
  PlanGraphCommandDiagnostic,
  ReconnectTaskDependencyCommand,
  RemoveTaskDependencyCommand
} from "../commands.js";
import type { LoadedPlanGraphPackage } from "../packageRepository.js";
import { diagnostic, taskFromManifest, type PlanGraphCommandHandler } from "./types.js";

type DependencyCommand =
  | AddTaskDependencyCommand
  | RemoveTaskDependencyCommand
  | ReconnectTaskDependencyCommand;

function sameEdge(left: ManifestEdge, right: ManifestEdge): boolean {
  return left.from === right.from && left.to === right.to && left.type === right.type;
}

function dependencyEdge(fromTaskId: string, toTaskId: string): ManifestEdge {
  return { from: fromTaskId, to: toTaskId, type: "depends_on" };
}

function validateDependencyCommand(
  manifest: PlanPackageManifest,
  command: DependencyCommand
): PlanGraphCommandDiagnostic | null {
  const fromTaskIds =
    command.type === "reconnectTaskDependency"
      ? [command.fromTaskId, command.newFromTaskId ?? command.fromTaskId]
      : [command.fromTaskId];
  const toTaskIds =
    command.type === "reconnectTaskDependency"
      ? [command.oldToTaskId, command.newToTaskId]
      : [command.toTaskId];
  for (const fromTaskId of fromTaskIds) {
    if (!taskFromManifest(manifest, fromTaskId)) {
      return diagnostic("task_missing", `Task '${fromTaskId}' does not exist.`, fromTaskId);
    }
  }
  for (const toTaskId of toTaskIds) {
    if (!taskFromManifest(manifest, toTaskId)) {
      return diagnostic("task_missing", `Task '${toTaskId}' does not exist.`, toTaskId);
    }
  }
  return null;
}

function reconnectDependencyMutation(
  manifest: PlanPackageManifest,
  command: ReconnectTaskDependencyCommand
): PlanPackageGraphMutation | PlanGraphCommandDiagnostic {
  const oldEdge = dependencyEdge(command.fromTaskId, command.oldToTaskId);
  const newEdge = dependencyEdge(command.newFromTaskId ?? command.fromTaskId, command.newToTaskId);
  if (sameEdge(oldEdge, newEdge)) {
    return buildPlanPackageManifestChangeMutation(manifest, manifest, {
      affectedTasks: [command.fromTaskId]
    });
  }
  if (!manifest.edges.some((edge) => sameEdge(edge, oldEdge))) {
    return diagnostic("edge_missing", "Task dependency edge does not exist.", "edges");
  }
  if (manifest.edges.some((edge) => sameEdge(edge, newEdge))) {
    return diagnostic("edge_duplicate", "Task dependency edge already exists.", "edges");
  }
  return buildPlanPackageManifestChangeMutation(manifest, {
    ...manifest,
    edges: [...manifest.edges.filter((edge) => !sameEdge(edge, oldEdge)), newEdge]
  });
}

export const dependencyCommandHandler: PlanGraphCommandHandler<DependencyCommand> = {
  family: "dependency",
  commandTypes: ["addTaskDependency", "removeTaskDependency", "reconnectTaskDependency"],
  handles(command: PlanGraphCommand): command is DependencyCommand {
    return (
      command.type === "addTaskDependency" ||
      command.type === "removeTaskDependency" ||
      command.type === "reconnectTaskDependency"
    );
  },
  mutation(
    loaded: LoadedPlanGraphPackage,
    command: DependencyCommand
  ): PlanPackageGraphMutation | PlanGraphCommandDiagnostic {
    const dependencyDiagnostic = validateDependencyCommand(loaded.manifest, command);
    if (dependencyDiagnostic) {
      return dependencyDiagnostic;
    }
    if (command.type === "addTaskDependency") {
      const edge = dependencyEdge(command.fromTaskId, command.toTaskId);
      if (loaded.manifest.edges.some((candidate) => sameEdge(candidate, edge))) {
        return diagnostic("edge_duplicate", "Task dependency edge already exists.", "edges");
      }
      return buildPlanPackageGraphMutation(loaded.manifest, { kind: "addEdge", edge });
    }
    if (command.type === "removeTaskDependency") {
      const edge = dependencyEdge(command.fromTaskId, command.toTaskId);
      if (!loaded.manifest.edges.some((candidate) => sameEdge(candidate, edge))) {
        return diagnostic("edge_missing", "Task dependency edge does not exist.", "edges");
      }
      return buildPlanPackageGraphMutation(loaded.manifest, { kind: "removeEdge", edge });
    }
    return reconnectDependencyMutation(loaded.manifest, command);
  },
  inverse(_loaded: LoadedPlanGraphPackage, command: DependencyCommand): PlanGraphCommand {
    if (command.type === "addTaskDependency") {
      return {
        type: "removeTaskDependency",
        fromTaskId: command.fromTaskId,
        toTaskId: command.toTaskId
      };
    }
    if (command.type === "removeTaskDependency") {
      return {
        type: "addTaskDependency",
        fromTaskId: command.fromTaskId,
        toTaskId: command.toTaskId
      };
    }
    return {
      type: "reconnectTaskDependency",
      fromTaskId: command.newFromTaskId ?? command.fromTaskId,
      oldToTaskId: command.newToTaskId,
      newFromTaskId: command.fromTaskId,
      newToTaskId: command.oldToTaskId
    };
  },
  touchedRefs(command: DependencyCommand): { tasks: string[]; blocks: string[] } {
    if (command.type === "addTaskDependency" || command.type === "removeTaskDependency") {
      return { tasks: [command.fromTaskId], blocks: [] };
    }
    return { tasks: [command.fromTaskId, command.newFromTaskId ?? command.fromTaskId], blocks: [] };
  }
};
