import {
  buildPlanPackageManifestChangeMutation,
  buildPlanPackageGraphMutation,
  type PlanPackageGraphMutation
} from "../../graph/mutation.js";
import { buildPlanPackageTaskFieldEditMutation } from "../../graph/fieldEditMutation.js";
import type {
  AddTaskCommand,
  PlanGraphCommand,
  PlanGraphCommandDiagnostic,
  RemoveTaskCommand,
  RestoreTaskCommand,
  TaskComponentSnapshot,
  UpdateTaskFieldsCommand,
  UpdateTaskPromptCommand
} from "../commands.js";
import type { LoadedPlanGraphPackage } from "../packageRepository.js";
import {
  diagnostic,
  promptMarkdown,
  snapshotOrDiagnostic,
  taskFromManifest,
  type PlanGraphCommandHandler
} from "./types.js";

type TaskCommand =
  | UpdateTaskPromptCommand
  | UpdateTaskFieldsCommand
  | AddTaskCommand
  | RemoveTaskCommand
  | RestoreTaskCommand;

function readTaskSnapshot(
  loaded: LoadedPlanGraphPackage,
  taskId: string
): TaskComponentSnapshot | PlanGraphCommandDiagnostic {
  const task = taskFromManifest(loaded.manifest, taskId);
  if (!task) {
    return diagnostic("task_missing", `Task '${taskId}' does not exist.`, taskId);
  }
  const insertIndex = loaded.manifest.nodes.findIndex(
    (node) => node.type === "task" && node.id === taskId
  );
  const taskPromptMarkdown = promptMarkdown(loaded, task.prompt);
  if (taskPromptMarkdown === undefined) {
    return diagnostic("prompt_missing", `Prompt '${task.prompt}' is not indexed.`, task.prompt);
  }
  const blockPromptMarkdown: Array<{ blockId: string; markdown: string }> = [];
  for (const block of task.blocks) {
    const markdown = promptMarkdown(loaded, block.prompt);
    if (markdown === undefined) {
      return diagnostic("prompt_missing", `Prompt '${block.prompt}' is not indexed.`, block.prompt);
    }
    blockPromptMarkdown.push({ blockId: block.id, markdown });
  }
  return {
    task: structuredClone(task),
    taskPromptMarkdown,
    blockPromptMarkdown,
    insertIndex: insertIndex >= 0 ? insertIndex : null,
    affectedTaskEdges: loaded.manifest.edges
      .filter((edge) => edge.from === taskId || edge.to === taskId)
      .map((edge) => structuredClone(edge))
  };
}

function restoreTaskMutation(
  loaded: LoadedPlanGraphPackage,
  command: RestoreTaskCommand
): PlanPackageGraphMutation {
  const addTaskMutation = buildPlanPackageGraphMutation(loaded.manifest, {
    kind: "addTaskNode",
    node: command.snapshot.task,
    taskPromptMarkdown: command.snapshot.taskPromptMarkdown,
    blockPromptMarkdown: command.snapshot.blockPromptMarkdown
  });
  const insertIndex =
    command.snapshot.insertIndex === null
      ? loaded.manifest.nodes.length
      : Math.max(0, Math.min(command.snapshot.insertIndex, loaded.manifest.nodes.length));
  const existingEdges = new Set(
    loaded.manifest.edges.map((edge) => `${edge.type}:${edge.from}:${edge.to}`)
  );
  const restoredEdges = command.snapshot.affectedTaskEdges.filter(
    (edge) => !existingEdges.has(`${edge.type}:${edge.from}:${edge.to}`)
  );
  return buildPlanPackageManifestChangeMutation(
    loaded.manifest,
    {
      ...loaded.manifest,
      nodes: [
        ...loaded.manifest.nodes.slice(0, insertIndex),
        command.snapshot.task,
        ...loaded.manifest.nodes.slice(insertIndex)
      ],
      edges: [...loaded.manifest.edges, ...restoredEdges]
    },
    {
      affectedTasks: [...addTaskMutation.affectedTasks, command.snapshot.task.id],
      sideEffects: addTaskMutation.sideEffects
    }
  );
}

export const taskCommandHandler: PlanGraphCommandHandler<TaskCommand> = {
  family: "task",
  commandTypes: ["updateTaskPrompt", "updateTaskFields", "addTask", "removeTask", "restoreTask"],
  handles(command: PlanGraphCommand): command is TaskCommand {
    return (
      command.type === "updateTaskPrompt" ||
      command.type === "updateTaskFields" ||
      command.type === "addTask" ||
      command.type === "removeTask" ||
      command.type === "restoreTask"
    );
  },
  mutation(
    loaded: LoadedPlanGraphPackage,
    command: TaskCommand
  ): PlanPackageGraphMutation | PlanGraphCommandDiagnostic {
    if (command.type === "updateTaskPrompt") {
      return buildPlanPackageTaskFieldEditMutation(loaded.manifest, {
        taskId: command.taskId,
        promptMarkdown: command.promptMarkdown
      });
    }
    if (command.type === "updateTaskFields") {
      return buildPlanPackageTaskFieldEditMutation(loaded.manifest, {
        taskId: command.taskId,
        title: command.fields.title,
        promptMarkdown: command.fields.promptMarkdown,
        executor: command.fields.executor,
        acceptance: command.fields.acceptance
      });
    }
    if (command.type === "addTask" || command.type === "restoreTask") {
      if (taskFromManifest(loaded.manifest, command.snapshot.task.id)) {
        return diagnostic(
          "task_duplicate",
          `Task '${command.snapshot.task.id}' already exists.`,
          command.snapshot.task.id
        );
      }
      if (command.type === "restoreTask") {
        return restoreTaskMutation(loaded, command);
      }
      return buildPlanPackageGraphMutation(loaded.manifest, {
        kind: "addTaskNode",
        node: command.snapshot.task,
        taskPromptMarkdown: command.snapshot.taskPromptMarkdown,
        blockPromptMarkdown: command.snapshot.blockPromptMarkdown
      });
    }
    if (!taskFromManifest(loaded.manifest, command.taskId)) {
      return diagnostic("task_missing", `Task '${command.taskId}' does not exist.`, command.taskId);
    }
    return buildPlanPackageGraphMutation(loaded.manifest, {
      kind: "removeNode",
      nodeId: command.taskId,
      removeTaskDirectory: true
    });
  },
  inverse(
    loaded: LoadedPlanGraphPackage,
    command: TaskCommand
  ): PlanGraphCommand | PlanGraphCommand[] | PlanGraphCommandDiagnostic {
    if (command.type === "updateTaskPrompt") {
      const task = taskFromManifest(loaded.manifest, command.taskId);
      const markdown = task ? promptMarkdown(loaded, task.prompt) : undefined;
      return markdown === undefined
        ? diagnostic(
            "prompt_missing",
            `Prompt for task '${command.taskId}' is not indexed.`,
            command.taskId
          )
        : {
            type: "updateTaskPrompt",
            taskId: command.taskId,
            promptMarkdown: markdown
          };
    }
    if (command.type === "updateTaskFields") {
      const task = taskFromManifest(loaded.manifest, command.taskId);
      if (!task) {
        return diagnostic(
          "task_missing",
          `Task '${command.taskId}' does not exist.`,
          command.taskId
        );
      }
      const fields: UpdateTaskFieldsCommand["fields"] = {};
      if (command.fields.title !== undefined) {
        fields.title = task.title;
      }
      if (command.fields.promptMarkdown !== undefined) {
        const markdown = promptMarkdown(loaded, task.prompt);
        if (markdown === undefined) {
          return diagnostic(
            "prompt_missing",
            `Prompt for task '${command.taskId}' is not indexed.`,
            command.taskId
          );
        }
        fields.promptMarkdown = markdown;
      }
      if (command.fields.executor !== undefined) {
        fields.executor = task.executor ?? null;
      }
      if (command.fields.acceptance !== undefined) {
        fields.acceptance = [...task.acceptance];
      }
      const inverse: PlanGraphCommand = {
        type: "updateTaskFields",
        taskId: command.taskId,
        fields
      };
      if (command.fields.executor === undefined) {
        return inverse;
      }
      const blockExecutorRestores = task.blocks
        .filter((block) => block.executor !== undefined)
        .map(
          (block): PlanGraphCommand => ({
            type: "updateBlockFields",
            blockRef: `${task.id}#${block.id}`,
            fields: { executor: block.executor ?? null }
          })
        );
      return blockExecutorRestores.length === 0 ? inverse : [inverse, ...blockExecutorRestores];
    }
    if (command.type === "addTask" || command.type === "restoreTask") {
      return { type: "removeTask", taskId: command.snapshot.task.id };
    }
    return snapshotOrDiagnostic(readTaskSnapshot(loaded, command.taskId), (snapshot) => ({
      type: "restoreTask",
      snapshot: { ...snapshot, layoutNode: command.layoutNode ?? snapshot.layoutNode ?? null }
    }));
  },
  touchedRefs(command: TaskCommand): { tasks: string[]; blocks: string[] } {
    if (command.type === "addTask" || command.type === "restoreTask") {
      return {
        tasks: [command.snapshot.task.id],
        blocks: command.snapshot.task.blocks.map(
          (block) => `${command.snapshot.task.id}#${block.id}`
        )
      };
    }
    if (
      command.type === "removeTask" ||
      command.type === "updateTaskPrompt" ||
      command.type === "updateTaskFields"
    ) {
      return { tasks: [command.taskId], blocks: [] };
    }
    return { tasks: [], blocks: [] };
  }
};
