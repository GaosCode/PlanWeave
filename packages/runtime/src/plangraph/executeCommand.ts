import {
  buildPlanPackageManifestChangeMutation,
  buildPlanPackageGraphMutation,
  writePromptSideEffects,
  type PlanPackageGraphMutation
} from "../graph/mutation.js";
import { buildPlanPackageBlockFieldEditMutation, buildPlanPackageTaskFieldEditMutation } from "../graph/fieldEditMutation.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { defaultPlanGraphCommandDependencies } from "./adapters.js";
import { PlanGraphOperationLogParseError } from "./commandSchema.js";
import { stableJson } from "./hash.js";
import { applyProjectGraphHistoryCommand, executeProjectGraphCommand, isProjectGraphCommand } from "./projectGraphCommand.js";
import type { ManifestBlock, ManifestEdge, ManifestTaskNode, PackageWorkspaceRef, PlanPackageManifest } from "../types.js";
import type {
  AppliedPlanGraphCommand,
  BlockComponentSnapshot,
  PlanGraphAffectedRefs,
  PlanGraphCommand,
  PlanGraphCommandDiagnostic,
  PlanGraphCommandResult,
  TaskComponentSnapshot
} from "./commands.js";
import { emptyAffectedRefs } from "./commands.js";
import type { LoadedPlanGraphPackage } from "./packageRepository.js";
import type { PlanGraphCommandDependencies, PlanGraphOperationLogEntry } from "./ports.js";

export type ExecutePlanGraphCommandOptions = {
  projectRoot: PackageWorkspaceRef;
  command: PlanGraphCommand;
  indexPath?: string;
  recordOperation?: boolean;
  dependencies?: Partial<PlanGraphCommandDependencies>;
};

export type PlanGraphHistoryOptions = {
  projectRoot: PackageWorkspaceRef;
  indexPath?: string;
  dependencies?: Partial<PlanGraphCommandDependencies>;
};

type ResolvedPlanGraphCommandDependencies = PlanGraphCommandDependencies;

function diagnostic(code: string, message: string, path?: string): PlanGraphCommandDiagnostic {
  return { code, message, path };
}

function historyCommandInvalid(error: PlanGraphOperationLogParseError): PlanGraphCommandResult {
  return fail({
    command: { type: "updateLayout", layoutScope: "desktop", layout: null },
    diagnostics: [
      diagnostic(
        "history_command_invalid",
        `Invalid operation_log ${error.fieldName} for operation ${error.operationId}: ${error.issueSummary}.`,
        `operation_log.${error.operationId}.${error.fieldName}`
      )
    ]
  });
}

function fail(options: {
  command: PlanGraphCommand;
  diagnostics: PlanGraphCommandDiagnostic[];
  graphVersion?: string;
  packageFingerprint?: string;
}): PlanGraphCommandResult {
  return {
    ok: false,
    command: options.command,
    graphVersion: options.graphVersion,
    packageFingerprint: options.packageFingerprint,
    affected: emptyAffectedRefs(),
    changedPaths: [],
    diagnostics: options.diagnostics
  };
}

function sameEdge(left: ManifestEdge, right: ManifestEdge): boolean {
  return left.from === right.from && left.to === right.to && left.type === right.type;
}

function taskFromManifest(manifest: PlanPackageManifest, taskId: string): ManifestTaskNode | undefined {
  return manifest.nodes.find((node): node is ManifestTaskNode => node.type === "task" && node.id === taskId);
}

function blockFromManifest(manifest: PlanPackageManifest, blockRef: string): { task: ManifestTaskNode; block: ManifestBlock } | undefined {
  const { taskId, blockId } = parseBlockRef(blockRef);
  const task = taskFromManifest(manifest, taskId);
  const block = task?.blocks.find((candidate) => candidate.id === blockId);
  return task && block ? { task, block } : undefined;
}

function promptMarkdown(loaded: LoadedPlanGraphPackage, packagePath: string): string | undefined {
  return loaded.promptMarkdownByPath.get(packagePath);
}

function readTaskSnapshot(loaded: LoadedPlanGraphPackage, taskId: string): TaskComponentSnapshot | PlanGraphCommandDiagnostic {
  const task = taskFromManifest(loaded.manifest, taskId);
  if (!task) {
    return diagnostic("task_missing", `Task '${taskId}' does not exist.`, taskId);
  }
  const insertIndex = loaded.manifest.nodes.findIndex((node) => node.type === "task" && node.id === taskId);
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
    affectedTaskEdges: loaded.manifest.edges.filter((edge) => edge.from === taskId || edge.to === taskId).map((edge) => structuredClone(edge))
  };
}

function readBlockSnapshot(loaded: LoadedPlanGraphPackage, blockRef: string): BlockComponentSnapshot | PlanGraphCommandDiagnostic {
  const current = blockFromManifest(loaded.manifest, blockRef);
  if (!current) {
    return diagnostic("block_missing", `Block '${blockRef}' does not exist.`, blockRef);
  }
  const { blockId } = parseBlockRef(blockRef);
  const insertIndex = current.task.blocks.findIndex((candidate) => candidate.id === blockId);
  const markdown = promptMarkdown(loaded, current.block.prompt);
  if (markdown === undefined) {
    return diagnostic("prompt_missing", `Prompt '${current.block.prompt}' is not indexed.`, current.block.prompt);
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

function commandPromptHash(loaded: LoadedPlanGraphPackage, command: PlanGraphCommand): string | undefined {
  if (command.type === "updateTaskPrompt" || (command.type === "updateTaskFields" && command.fields.promptMarkdown !== undefined)) {
    return loaded.graph.tasks.get(command.taskId)?.promptRef.contentHash;
  }
  if (command.type === "updateBlockPrompt" || (command.type === "updateBlockFields" && command.fields.promptMarkdown !== undefined)) {
    return loaded.graph.blocks.get(command.blockRef)?.promptRef.contentHash;
  }
  return undefined;
}

function commandBasePromptHash(command: PlanGraphCommand): string | undefined {
  if (command.type === "updateTaskPrompt" || command.type === "updateBlockPrompt") {
    return command.basePromptHash;
  }
  if (command.type === "updateTaskFields" || command.type === "updateBlockFields") {
    return command.fields.basePromptHash;
  }
  return undefined;
}

function commandPromptTarget(command: PlanGraphCommand): string | null {
  if (command.type === "updateTaskPrompt" || (command.type === "updateTaskFields" && command.fields.promptMarkdown !== undefined)) {
    return command.taskId;
  }
  if (command.type === "updateBlockPrompt" || (command.type === "updateBlockFields" && command.fields.promptMarkdown !== undefined)) {
    return command.blockRef;
  }
  return null;
}

function validateBaseVersion(loaded: LoadedPlanGraphPackage, command: PlanGraphCommand): PlanGraphCommandDiagnostic | null {
  if (!command.baseGraphVersion || command.baseGraphVersion === loaded.graph.graphVersion) {
    return null;
  }
  const promptTarget = commandPromptTarget(command);
  if (promptTarget) {
    const currentPromptHash = commandPromptHash(loaded, command);
    const basePromptHash = commandBasePromptHash(command);
    if (basePromptHash && currentPromptHash === basePromptHash) {
      return null;
    }
    return diagnostic(
      "graph_version_conflict",
      "Prompt changed after the command base graph version; refusing to overwrite newer prompt content.",
      promptTarget
    );
  }
  return diagnostic(
    "graph_version_conflict",
    "Plan graph changed after the command base graph version; re-read the graph before applying this structural command."
  );
}

function validateDependencyCommand(manifest: PlanPackageManifest, command: PlanGraphCommand): PlanGraphCommandDiagnostic | null {
  if (command.type !== "addTaskDependency" && command.type !== "removeTaskDependency" && command.type !== "reconnectTaskDependency") {
    return null;
  }
  const fromTaskIds = command.type === "reconnectTaskDependency" ? [command.fromTaskId, command.newFromTaskId ?? command.fromTaskId] : [command.fromTaskId];
  const toTaskIds = command.type === "reconnectTaskDependency" ? [command.oldToTaskId, command.newToTaskId] : [command.toTaskId];
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

function dependencyEdge(fromTaskId: string, toTaskId: string): ManifestEdge {
  return { from: fromTaskId, to: toTaskId, type: "depends_on" };
}

function reconnectDependencyMutation(
  manifest: PlanPackageManifest,
  command: Extract<PlanGraphCommand, { type: "reconnectTaskDependency" }>
): PlanPackageGraphMutation | PlanGraphCommandDiagnostic {
  const oldEdge = dependencyEdge(command.fromTaskId, command.oldToTaskId);
  const newEdge = dependencyEdge(command.newFromTaskId ?? command.fromTaskId, command.newToTaskId);
  if (sameEdge(oldEdge, newEdge)) {
    return buildPlanPackageManifestChangeMutation(manifest, manifest, { affectedTasks: [command.fromTaskId] });
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

function mutationForCommand(loaded: LoadedPlanGraphPackage, command: PlanGraphCommand): PlanPackageGraphMutation | PlanGraphCommandDiagnostic {
  const baseVersionDiagnostic = validateBaseVersion(loaded, command);
  if (baseVersionDiagnostic) {
    return baseVersionDiagnostic;
  }
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
  if (command.type === "reconnectTaskDependency") {
    return reconnectDependencyMutation(loaded.manifest, command);
  }
  if (command.type === "updateTaskPrompt") {
    return buildPlanPackageTaskFieldEditMutation(loaded.manifest, {
      taskId: command.taskId,
      promptMarkdown: command.promptMarkdown
    });
  }
  if (command.type === "updateBlockPrompt") {
    return buildPlanPackageBlockFieldEditMutation(loaded.manifest, {
      blockRef: command.blockRef,
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
  if (command.type === "updateBlockFields") {
    return buildPlanPackageBlockFieldEditMutation(loaded.manifest, {
      blockRef: command.blockRef,
      title: command.fields.title,
      promptMarkdown: command.fields.promptMarkdown,
      executor: command.fields.executor,
      dependsOn: command.fields.dependsOn,
      parallelSafe: command.fields.parallelSafe,
      parallelLocks: command.fields.parallelLocks,
      reviewRequired: command.fields.reviewRequired,
      maxFeedbackCycles: command.fields.maxFeedbackCycles,
      reviewHook: command.fields.reviewHook
    });
  }
  if (command.type === "addTask" || command.type === "restoreTask") {
    if (taskFromManifest(loaded.manifest, command.snapshot.task.id)) {
      return diagnostic("task_duplicate", `Task '${command.snapshot.task.id}' already exists.`, command.snapshot.task.id);
    }
    const addTaskMutation = buildPlanPackageGraphMutation(loaded.manifest, {
      kind: "addTaskNode",
      node: command.snapshot.task,
      taskPromptMarkdown: command.snapshot.taskPromptMarkdown,
      blockPromptMarkdown: command.snapshot.blockPromptMarkdown
    });
    if (command.type !== "restoreTask") {
      return addTaskMutation;
    }
    const insertIndex =
      command.snapshot.insertIndex === null
        ? loaded.manifest.nodes.length
        : Math.max(0, Math.min(command.snapshot.insertIndex, loaded.manifest.nodes.length));
    const existingEdges = new Set(loaded.manifest.edges.map((edge) => `${edge.type}:${edge.from}:${edge.to}`));
    const restoredEdges = command.snapshot.affectedTaskEdges.filter((edge) => !existingEdges.has(`${edge.type}:${edge.from}:${edge.to}`));
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
      { affectedTasks: [...addTaskMutation.affectedTasks, command.snapshot.task.id], sideEffects: addTaskMutation.sideEffects }
    );
  }
  if (command.type === "removeTask") {
    if (!taskFromManifest(loaded.manifest, command.taskId)) {
      return diagnostic("task_missing", `Task '${command.taskId}' does not exist.`, command.taskId);
    }
    return buildPlanPackageGraphMutation(loaded.manifest, {
      kind: "removeNode",
      nodeId: command.taskId,
      removeTaskDirectory: true
    });
  }
  if (command.type === "addBlock" || command.type === "restoreBlock") {
    const task = taskFromManifest(loaded.manifest, command.snapshot.taskId);
    if (!task) {
      return diagnostic("task_missing", `Task '${command.snapshot.taskId}' does not exist.`, command.snapshot.taskId);
    }
    if (task.blocks.some((block) => block.id === command.snapshot.block.id)) {
      return diagnostic("block_duplicate", `Block '${command.snapshot.taskId}#${command.snapshot.block.id}' already exists.`, command.snapshot.block.id);
    }
    if (command.type === "restoreBlock") {
      const insertIndex =
        command.snapshot.insertIndex === null
          ? task.blocks.length
          : Math.max(0, Math.min(command.snapshot.insertIndex, task.blocks.length));
      const blocksWithRestoredBlock = [
        ...task.blocks.slice(0, insertIndex),
        command.snapshot.block,
        ...task.blocks.slice(insertIndex)
      ];
      const nextTask: ManifestTaskNode = {
        ...task,
        blocks: blocksWithRestoredBlock.map((block) => {
          const ref = `${task.id}#${block.id}`;
          const affected = command.snapshot.affectedDependsOn.find((item) => item.blockRef === ref);
          return affected ? { ...block, depends_on: [...affected.dependsOn] } : block;
        })
      };
      return buildPlanPackageManifestChangeMutation(
        loaded.manifest,
        {
          ...loaded.manifest,
          nodes: loaded.manifest.nodes.map((node) => (node.type === "task" && node.id === task.id ? nextTask : node))
        },
        { affectedTasks: [task.id], sideEffects: writePromptSideEffects(command.snapshot.block.prompt, command.snapshot.promptMarkdown) }
      );
    }
    return buildPlanPackageGraphMutation(loaded.manifest, {
      kind: "addBlock",
      taskId: command.snapshot.taskId,
      block: command.snapshot.block,
      promptMarkdown: command.snapshot.promptMarkdown
    });
  }
  if (command.type === "removeBlock") {
    if (!blockFromManifest(loaded.manifest, command.blockRef)) {
      return diagnostic("block_missing", `Block '${command.blockRef}' does not exist.`, command.blockRef);
    }
    return buildPlanPackageGraphMutation(loaded.manifest, { kind: "removeBlock", blockRef: command.blockRef });
  }
  if (command.type === "updateReviewPipeline") {
    const task = taskFromManifest(loaded.manifest, command.taskId);
    if (!task) {
      return diagnostic("task_missing", `Task '${command.taskId}' does not exist.`, command.taskId);
    }
    const reviewPromptPaths = new Set(command.reviewBlocks.map((block) => block.prompt));
    const removedPrompts = task.blocks
      .filter((block) => block.type === "review" && !reviewPromptPaths.has(block.prompt))
      .map((block) => ({ kind: "removePrompt" as const, packagePath: block.prompt }));
    const promptMarkdownByBlockId = new Map(command.promptMarkdownByBlockId.map((item) => [item.blockId, item.markdown]));
    const sideEffects = [
      ...removedPrompts,
      ...command.reviewBlocks.flatMap((block) => writePromptSideEffects(block.prompt, promptMarkdownByBlockId.get(block.id) ?? ""))
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
        nodes: loaded.manifest.nodes.map((node) => (node.type === "task" && node.id === command.taskId ? nextTask : node))
      },
      { affectedTasks: [command.taskId], sideEffects }
    );
  }
  return diagnostic("layout_command_not_handled", "PlanGraph layout commands are defined here but still written by the existing layout API.");
}

function inverseForCommand(loaded: LoadedPlanGraphPackage, command: PlanGraphCommand): PlanGraphCommand | PlanGraphCommand[] | PlanGraphCommandDiagnostic {
  if (command.type === "addTaskDependency") {
    return { type: "removeTaskDependency", fromTaskId: command.fromTaskId, toTaskId: command.toTaskId };
  }
  if (command.type === "removeTaskDependency") {
    return { type: "addTaskDependency", fromTaskId: command.fromTaskId, toTaskId: command.toTaskId };
  }
  if (command.type === "reconnectTaskDependency") {
    return {
      type: "reconnectTaskDependency",
      fromTaskId: command.newFromTaskId ?? command.fromTaskId,
      oldToTaskId: command.newToTaskId,
      newFromTaskId: command.fromTaskId,
      newToTaskId: command.oldToTaskId
    };
  }
  if (command.type === "updateTaskPrompt") {
    const task = taskFromManifest(loaded.manifest, command.taskId);
    const markdown = task ? promptMarkdown(loaded, task.prompt) : undefined;
    return markdown === undefined
      ? diagnostic("prompt_missing", `Prompt for task '${command.taskId}' is not indexed.`, command.taskId)
      : {
          type: "updateTaskPrompt",
          taskId: command.taskId,
          promptMarkdown: markdown
        };
  }
  if (command.type === "updateBlockPrompt") {
    const current = blockFromManifest(loaded.manifest, command.blockRef);
    const markdown = current ? promptMarkdown(loaded, current.block.prompt) : undefined;
    return markdown === undefined
      ? diagnostic("prompt_missing", `Prompt for block '${command.blockRef}' is not indexed.`, command.blockRef)
      : {
          type: "updateBlockPrompt",
          blockRef: command.blockRef,
          promptMarkdown: markdown
        };
  }
  if (command.type === "updateTaskFields") {
    const task = taskFromManifest(loaded.manifest, command.taskId);
    if (!task) {
      return diagnostic("task_missing", `Task '${command.taskId}' does not exist.`, command.taskId);
    }
    const fields: Extract<PlanGraphCommand, { type: "updateTaskFields" }>["fields"] = {};
    if (command.fields.title !== undefined) {
      fields.title = task.title;
    }
    if (command.fields.promptMarkdown !== undefined) {
      const markdown = promptMarkdown(loaded, task.prompt);
      if (markdown === undefined) {
        return diagnostic("prompt_missing", `Prompt for task '${command.taskId}' is not indexed.`, command.taskId);
      }
      fields.promptMarkdown = markdown;
    }
    if (command.fields.executor !== undefined) {
      fields.executor = task.executor ?? null;
    }
    if (command.fields.acceptance !== undefined) {
      fields.acceptance = [...task.acceptance];
    }
    const inverse: PlanGraphCommand = { type: "updateTaskFields", taskId: command.taskId, fields };
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
  if (command.type === "updateBlockFields") {
    const current = blockFromManifest(loaded.manifest, command.blockRef);
    if (!current) {
      return diagnostic("block_missing", `Block '${command.blockRef}' does not exist.`, command.blockRef);
    }
    const fields: Extract<PlanGraphCommand, { type: "updateBlockFields" }>["fields"] = {};
    if (command.fields.title !== undefined) {
      fields.title = current.block.title;
    }
    if (command.fields.promptMarkdown !== undefined) {
      const markdown = promptMarkdown(loaded, current.block.prompt);
      if (markdown === undefined) {
        return diagnostic("prompt_missing", `Prompt for block '${command.blockRef}' is not indexed.`, command.blockRef);
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
      if (command.fields.parallelLocks !== undefined) {
        fields.parallelLocks = [...current.block.parallel.locks];
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
  if (command.type === "addTask" || command.type === "restoreTask") {
    return { type: "removeTask", taskId: command.snapshot.task.id };
  }
  if (command.type === "removeTask") {
    return snapshotOrDiagnostic(readTaskSnapshot(loaded, command.taskId), (snapshot) => ({
      type: "restoreTask",
      snapshot: { ...snapshot, layoutNode: command.layoutNode ?? snapshot.layoutNode ?? null }
    }));
  }
  if (command.type === "addBlock" || command.type === "restoreBlock") {
    return { type: "removeBlock", blockRef: `${command.snapshot.taskId}#${command.snapshot.block.id}` };
  }
  if (command.type === "removeBlock") {
    return snapshotOrDiagnostic(readBlockSnapshot(loaded, command.blockRef), (snapshot) => ({ type: "restoreBlock", snapshot }));
  }
  if (command.type === "updateReviewPipeline") {
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
        return diagnostic("prompt_missing", `Prompt for block '${command.taskId}#${block.id}' is not indexed.`, block.prompt);
      }
      promptMarkdownByBlockId.push({ blockId: block.id, markdown });
    }
    return {
      type: "updateReviewPipeline",
      taskId: command.taskId,
      packageDefaults: { ...loaded.manifest.review },
      reviewBlocks: task.blocks.filter((block) => block.type === "review").map((block) => structuredClone(block)),
      promptMarkdownByBlockId
    };
  }
  return diagnostic("layout_command_not_handled", "PlanGraph layout commands are not undoable here.");
}

function snapshotOrDiagnostic<TSnapshot, TCommand extends PlanGraphCommand>(
  value: TSnapshot | PlanGraphCommandDiagnostic,
  build: (snapshot: TSnapshot) => TCommand
): TCommand | PlanGraphCommandDiagnostic {
  return isPlanGraphCommandDiagnostic(value) ? value : build(value);
}

function isPlanGraphCommandDiagnostic(value: unknown): value is PlanGraphCommandDiagnostic {
  return value !== null && typeof value === "object" && "code" in value && "message" in value;
}

function commandTouchedRefs(command: PlanGraphCommand, loaded: LoadedPlanGraphPackage): { tasks: string[]; blocks: string[] } {
  if (command.type === "addTaskDependency" || command.type === "removeTaskDependency") {
    return { tasks: [command.fromTaskId], blocks: [] };
  }
  if (command.type === "reconnectTaskDependency") {
    return { tasks: [command.fromTaskId, command.newFromTaskId ?? command.fromTaskId], blocks: [] };
  }
  if (command.type === "updateTaskPrompt" || command.type === "updateTaskFields" || command.type === "removeTask") {
    return { tasks: [command.taskId], blocks: [] };
  }
  if (command.type === "updateBlockPrompt" || command.type === "updateBlockFields" || command.type === "removeBlock") {
    const { taskId, blockId } = parseBlockRef(command.blockRef);
    const task = taskFromManifest(loaded.manifest, taskId);
    const dependentBlocks = task?.blocks
      .filter((block) => block.depends_on.includes(blockId))
      .map((block) => `${taskId}#${block.id}`) ?? [];
    return { tasks: [taskId], blocks: [command.blockRef, ...dependentBlocks] };
  }
  if (command.type === "addTask" || command.type === "restoreTask") {
    return { tasks: [command.snapshot.task.id], blocks: command.snapshot.task.blocks.map((block) => `${command.snapshot.task.id}#${block.id}`) };
  }
  if (command.type === "addBlock" || command.type === "restoreBlock") {
    return {
      tasks: [command.snapshot.taskId],
      blocks: [`${command.snapshot.taskId}#${command.snapshot.block.id}`, ...command.snapshot.affectedDependsOn.map((item) => item.blockRef)]
    };
  }
  if (command.type === "updateReviewPipeline") {
    return {
      tasks: [command.taskId],
      blocks: command.reviewBlocks.map((block) => `${command.taskId}#${block.id}`)
    };
  }
  return { tasks: [], blocks: [] };
}

function affectedRefs(command: PlanGraphCommand, mutation: PlanPackageGraphMutation, loaded: LoadedPlanGraphPackage): PlanGraphAffectedRefs {
  const touched = commandTouchedRefs(command, loaded);
  const prompts = mutation.sideEffects
    .filter((sideEffect) => sideEffect.kind === "writePrompt" || sideEffect.kind === "removePrompt")
    .map((sideEffect) => sideEffect.packagePath);
  const manifestFiles = mutationChangesManifest(loaded, mutation) ? ["manifest.json"] : [];
  return {
    canvases: [],
    tasks: [...new Set([...mutation.affectedTasks, ...touched.tasks])],
    blocks: [...new Set(touched.blocks)],
    prompts: [...new Set(prompts)],
    packageFiles: [...new Set([...manifestFiles, ...prompts])]
  };
}

function changedPaths(
  repository: PlanGraphCommandDependencies["repository"],
  loaded: LoadedPlanGraphPackage,
  affected: PlanGraphAffectedRefs
): string[] {
  return affected.packageFiles.map((path) => repository.packageFilePath(loaded, path));
}

function mutationChangesManifest(loaded: LoadedPlanGraphPackage, mutation: PlanPackageGraphMutation): boolean {
  return JSON.stringify(mutation.nextManifest) !== JSON.stringify(loaded.manifest);
}

function isNoopMutation(loaded: LoadedPlanGraphPackage, mutation: PlanPackageGraphMutation): boolean {
  return mutation.sideEffects.length === 0 && !mutationChangesManifest(loaded, mutation);
}

async function indexAppliedMutation(
  store: Awaited<ReturnType<PlanGraphCommandDependencies["createIndexStore"]>>,
  affected: PlanGraphAffectedRefs
) {
  if (affected.packageFiles.includes("manifest.json")) {
    return store.rebuild();
  }
  return store.indexChangedPaths(affected.packageFiles);
}

function isDiagnostic(value: PlanPackageGraphMutation | PlanGraphCommand | PlanGraphCommand[] | PlanGraphCommandDiagnostic): value is PlanGraphCommandDiagnostic {
  return isPlanGraphCommandDiagnostic(value);
}

async function executeLayoutCommand(options: ExecutePlanGraphCommandOptions, dependencies: ResolvedPlanGraphCommandDependencies): Promise<PlanGraphCommandResult> {
  const command = options.command;
  if (command.type !== "updateLayout") {
    throw new Error("executeLayoutCommand requires an updateLayout command.");
  }
  const recordOperation = options.recordOperation ?? true;
  const loaded = await dependencies.repository.load(options.projectRoot);
  let previousLayout: unknown;
  try {
    previousLayout = await dependencies.layoutStore.read(options.projectRoot, command.layoutScope);
  } catch (caught) {
    return fail({
      command,
      diagnostics: [diagnostic("layout_read_failed", caught instanceof Error ? caught.message : String(caught), command.layoutScope)],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  const inverse: PlanGraphCommand = {
    type: "updateLayout",
    layoutScope: command.layoutScope,
    layout: previousLayout
  };
  if (stableJson(previousLayout) === stableJson(command.layout)) {
    return {
      ok: true,
      workspaceRef: loaded.workspace,
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint,
      command,
      inverse,
      affected: emptyAffectedRefs(),
      changedPaths: [],
      diagnostics: []
    };
  }
  try {
    await dependencies.layoutStore.write(options.projectRoot, command.layoutScope, command.layout);
  } catch (caught) {
    return fail({
      command,
      diagnostics: [diagnostic("layout_write_failed", caught instanceof Error ? caught.message : String(caught), command.layoutScope)],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  const store = await dependencies.createIndexStore({ projectRoot: options.projectRoot, indexPath: options.indexPath });
  const affected: PlanGraphAffectedRefs = {
    ...emptyAffectedRefs(),
    packageFiles: command.layoutScope === "desktop" ? ["desktop/layout.json"] : ["desktop/canvases.json"]
  };
  const result: AppliedPlanGraphCommand = {
    ok: true,
    workspaceRef: loaded.workspace,
    graphVersion: loaded.graph.graphVersion,
    packageFingerprint: loaded.graph.packageFingerprint,
    command,
    inverse,
    affected,
    changedPaths: affected.packageFiles,
    diagnostics: []
  };
  if (recordOperation) {
    result.operationId = await store.log.append({
      workspaceRef: loaded.workspace,
      graphVersionBefore: loaded.graph.graphVersion,
      graphVersionAfter: loaded.graph.graphVersion,
      command,
      inverse,
      affected
    });
  }
  return result;
}

export async function executePlanGraphCommand(options: ExecutePlanGraphCommandOptions): Promise<PlanGraphCommandResult> {
  const dependencies = {
    ...defaultPlanGraphCommandDependencies,
    ...options.dependencies
  };
  if (isProjectGraphCommand(options.command)) {
    return executeProjectGraphCommand({
      projectRoot: options.projectRoot,
      command: options.command,
      indexPath: options.indexPath,
      recordOperation: options.recordOperation
    }, dependencies);
  }
  if (options.command.type === "updateLayout") {
    return executeLayoutCommand(options, dependencies);
  }
  const recordOperation = options.recordOperation ?? true;
  const loaded = await dependencies.repository.load(options.projectRoot);
  const inverse = inverseForCommand(loaded, options.command);
  if (isDiagnostic(inverse)) {
    return fail({
      command: options.command,
      diagnostics: [inverse],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  let mutation: ReturnType<typeof mutationForCommand>;
  try {
    mutation = mutationForCommand(loaded, options.command);
  } catch (caught) {
    return fail({
      command: options.command,
      diagnostics: [
        diagnostic(
          "command_validation_failed",
          caught instanceof Error ? caught.message : String(caught)
        )
      ],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  if (isDiagnostic(mutation)) {
    return fail({
      command: options.command,
      diagnostics: [mutation],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  if (isNoopMutation(loaded, mutation)) {
    return {
      ok: true,
      workspaceRef: loaded.workspace,
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint,
      command: options.command,
      inverse,
      affected: emptyAffectedRefs(),
      changedPaths: [],
      diagnostics: []
    };
  }

  const commitDiagnostics = await dependencies.repository.commit({ projectRoot: options.projectRoot, mutation });
  if (commitDiagnostics.length > 0) {
    return fail({
      command: options.command,
      diagnostics: commitDiagnostics,
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }

  const affected = affectedRefs(options.command, mutation, loaded);
  const store = await dependencies.createIndexStore({ projectRoot: options.projectRoot, indexPath: options.indexPath });
  const graph = await indexAppliedMutation(store, affected);
  const result: AppliedPlanGraphCommand = {
    ok: true,
    workspaceRef: loaded.workspace,
    graphVersion: graph.graphVersion,
    packageFingerprint: graph.packageFingerprint,
    command: options.command,
    inverse,
    affected,
    changedPaths: changedPaths(dependencies.repository, loaded, affected),
    diagnostics: []
  };
  if (recordOperation) {
    result.operationId = await store.log.append({
      workspaceRef: loaded.workspace,
      graphVersionBefore: loaded.graph.graphVersion,
      graphVersionAfter: graph.graphVersion,
      command: options.command,
      inverse,
      affected
    });
  }
  return result;
}

async function applyHistoryCommand(
  options: PlanGraphHistoryOptions,
  command: PlanGraphCommand | PlanGraphCommand[],
  expectedGraphVersion: string,
  workspaceRef: PackageWorkspaceRef
): Promise<PlanGraphCommandResult> {
  const dependencies = {
    ...defaultPlanGraphCommandDependencies,
    ...options.dependencies
  };
  if (!Array.isArray(command) && isProjectGraphCommand(command)) {
    return applyProjectGraphHistoryCommand({ indexPath: options.indexPath }, dependencies, command, expectedGraphVersion, workspaceRef);
  }
  const loaded = await dependencies.repository.load(workspaceRef);
  if (loaded.graph.graphVersion !== expectedGraphVersion) {
    return fail({
      command: Array.isArray(command) ? command[0] ?? { type: "updateLayout", layoutScope: "desktop", layout: null } : command,
      diagnostics: [
        diagnostic(
          "graph_version_conflict",
          "Plan graph changed after this history entry was recorded; refusing to apply stale undo/redo."
        )
      ],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  const commands = Array.isArray(command) ? command : [command];
  let latest: PlanGraphCommandResult | null = null;
  for (const item of commands) {
    latest = await executePlanGraphCommand({
      ...options,
      projectRoot: workspaceRef,
      command: commandForHistoryReplay(item),
      recordOperation: false,
      dependencies
    });
    if (!latest.ok) {
      return latest;
    }
  }
  if (!latest) {
    return fail({ command: { type: "updateLayout", layoutScope: "desktop", layout: null }, diagnostics: [diagnostic("history_empty", "No command to apply.")] });
  }
  return latest;
}

function commandForHistoryReplay(command: PlanGraphCommand): PlanGraphCommand {
  const replayCommand = structuredClone(command);
  delete replayCommand.baseGraphVersion;
  if (replayCommand.type === "updateTaskPrompt" || replayCommand.type === "updateBlockPrompt") {
    delete replayCommand.basePromptHash;
  }
  if (replayCommand.type === "updateTaskFields" || replayCommand.type === "updateBlockFields") {
    delete replayCommand.fields.basePromptHash;
  }
  return replayCommand;
}

export async function undoPlanGraphCommand(options: PlanGraphHistoryOptions): Promise<PlanGraphCommandResult> {
  const dependencies = {
    ...defaultPlanGraphCommandDependencies,
    ...options.dependencies
  };
  const store = await dependencies.createIndexStore(options);
  let entry: PlanGraphOperationLogEntry | null;
  try {
    entry = await store.log.latestUndoable();
  } catch (error) {
    if (error instanceof PlanGraphOperationLogParseError) {
      return historyCommandInvalid(error);
    }
    throw error;
  }
  if (!entry) {
    return fail({ command: { type: "updateLayout", layoutScope: "desktop", layout: null }, diagnostics: [diagnostic("history_empty", "No command to undo.")] });
  }
  const result = await applyHistoryCommand(options, entry.inverse, entry.graphVersionAfter, entry.workspaceRef);
  if (result.ok) {
    await store.log.markUndone(entry.id);
  }
  return result;
}

export async function redoPlanGraphCommand(options: PlanGraphHistoryOptions): Promise<PlanGraphCommandResult> {
  const dependencies = {
    ...defaultPlanGraphCommandDependencies,
    ...options.dependencies
  };
  const store = await dependencies.createIndexStore(options);
  let entry: PlanGraphOperationLogEntry | null;
  try {
    entry = await store.log.latestRedoable();
  } catch (error) {
    if (error instanceof PlanGraphOperationLogParseError) {
      return historyCommandInvalid(error);
    }
    throw error;
  }
  if (!entry) {
    return fail({ command: { type: "updateLayout", layoutScope: "desktop", layout: null }, diagnostics: [diagnostic("history_empty", "No command to redo.")] });
  }
  const result = await applyHistoryCommand(options, entry.command, entry.graphVersionBefore, entry.workspaceRef);
  if (result.ok) {
    await store.log.markRedone(entry.id);
  }
  return result;
}
