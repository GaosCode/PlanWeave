import type { PlanPackageGraphMutation } from "../graph/mutation.js";
import { defaultPlanGraphCommandDependencies } from "./adapters.js";
import { PlanGraphOperationLogParseError } from "./commandSchema.js";
import { handlerForCommand, type PlanGraphCommandHandler } from "./commandHandlers/index.js";
import { diagnostic, isPlanGraphCommandDiagnostic } from "./commandHandlers/types.js";
import { stableJson } from "./hash.js";
import {
  applyProjectGraphHistoryCommand,
  executeProjectGraphCommand,
  isProjectGraphCommand
} from "./projectGraphCommand.js";
import type { PackageWorkspaceRef } from "../types.js";
import type {
  AppliedPlanGraphCommand,
  PlanGraphAffectedRefs,
  PlanGraphCommand,
  PlanGraphCommandDiagnostic,
  PlanGraphCommandResult
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

function commandPromptHash(
  loaded: LoadedPlanGraphPackage,
  command: PlanGraphCommand
): string | undefined {
  if (
    command.type === "updateTaskPrompt" ||
    (command.type === "updateTaskFields" && command.fields.promptMarkdown !== undefined)
  ) {
    return loaded.graph.tasks.get(command.taskId)?.promptRef.contentHash;
  }
  if (
    command.type === "updateBlockPrompt" ||
    (command.type === "updateBlockFields" && command.fields.promptMarkdown !== undefined)
  ) {
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
  if (
    command.type === "updateTaskPrompt" ||
    (command.type === "updateTaskFields" && command.fields.promptMarkdown !== undefined)
  ) {
    return command.taskId;
  }
  if (
    command.type === "updateBlockPrompt" ||
    (command.type === "updateBlockFields" && command.fields.promptMarkdown !== undefined)
  ) {
    return command.blockRef;
  }
  return null;
}

function validateBaseVersion(
  loaded: LoadedPlanGraphPackage,
  command: PlanGraphCommand
): PlanGraphCommandDiagnostic | null {
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

function affectedRefs(
  command: PlanGraphCommand,
  mutation: PlanPackageGraphMutation,
  loaded: LoadedPlanGraphPackage,
  handler: PlanGraphCommandHandler
): PlanGraphAffectedRefs {
  const touched = handler.touchedRefs(command, loaded);
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

function mutationChangesManifest(
  loaded: LoadedPlanGraphPackage,
  mutation: PlanPackageGraphMutation
): boolean {
  return JSON.stringify(mutation.nextManifest) !== JSON.stringify(loaded.manifest);
}

function isNoopMutation(
  loaded: LoadedPlanGraphPackage,
  mutation: PlanPackageGraphMutation
): boolean {
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

function isDiagnostic(
  value:
    | PlanPackageGraphMutation
    | PlanGraphCommand
    | PlanGraphCommand[]
    | PlanGraphCommandDiagnostic
): value is PlanGraphCommandDiagnostic {
  return isPlanGraphCommandDiagnostic(value);
}

async function executeLayoutCommand(
  options: ExecutePlanGraphCommandOptions,
  dependencies: ResolvedPlanGraphCommandDependencies
): Promise<PlanGraphCommandResult> {
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
      diagnostics: [
        diagnostic(
          "layout_read_failed",
          caught instanceof Error ? caught.message : String(caught),
          command.layoutScope
        )
      ],
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
      diagnostics: [
        diagnostic(
          "layout_write_failed",
          caught instanceof Error ? caught.message : String(caught),
          command.layoutScope
        )
      ],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  const store = await dependencies.createIndexStore({
    projectRoot: options.projectRoot,
    indexPath: options.indexPath
  });
  const affected: PlanGraphAffectedRefs = {
    ...emptyAffectedRefs(),
    packageFiles:
      command.layoutScope === "desktop" ? ["desktop/layout.json"] : ["desktop/canvases.json"]
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

export async function executePlanGraphCommand(
  options: ExecutePlanGraphCommandOptions
): Promise<PlanGraphCommandResult> {
  const dependencies = {
    ...defaultPlanGraphCommandDependencies,
    ...options.dependencies
  };
  if (isProjectGraphCommand(options.command)) {
    return executeProjectGraphCommand(
      {
        projectRoot: options.projectRoot,
        command: options.command,
        indexPath: options.indexPath,
        recordOperation: options.recordOperation
      },
      dependencies
    );
  }
  if (options.command.type === "updateLayout") {
    return executeLayoutCommand(options, dependencies);
  }
  const recordOperation = options.recordOperation ?? true;
  const loaded = await dependencies.repository.load(options.projectRoot);
  const handler = handlerForCommand(options.command);
  if (!handler) {
    return fail({
      command: options.command,
      diagnostics: [
        diagnostic(
          "command_not_handled",
          `PlanGraph command '${options.command.type}' is not handled.`
        )
      ],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  const inverse = handler.inverse(loaded, options.command);
  if (isDiagnostic(inverse)) {
    return fail({
      command: options.command,
      diagnostics: [inverse],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  const baseVersionDiagnostic = validateBaseVersion(loaded, options.command);
  if (baseVersionDiagnostic) {
    return fail({
      command: options.command,
      diagnostics: [baseVersionDiagnostic],
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }
  let mutation: ReturnType<PlanGraphCommandHandler["mutation"]>;
  try {
    mutation = handler.mutation(loaded, options.command);
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

  const commitDiagnostics = await dependencies.repository.commit({
    projectRoot: options.projectRoot,
    mutation
  });
  if (commitDiagnostics.length > 0) {
    return fail({
      command: options.command,
      diagnostics: commitDiagnostics,
      graphVersion: loaded.graph.graphVersion,
      packageFingerprint: loaded.graph.packageFingerprint
    });
  }

  const affected = affectedRefs(options.command, mutation, loaded, handler);
  const store = await dependencies.createIndexStore({
    projectRoot: options.projectRoot,
    indexPath: options.indexPath
  });
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
    return applyProjectGraphHistoryCommand(
      { indexPath: options.indexPath },
      dependencies,
      command,
      expectedGraphVersion,
      workspaceRef
    );
  }
  const loaded = await dependencies.repository.load(workspaceRef);
  if (loaded.graph.graphVersion !== expectedGraphVersion) {
    return fail({
      command: Array.isArray(command)
        ? (command[0] ?? { type: "updateLayout", layoutScope: "desktop", layout: null })
        : command,
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
    return fail({
      command: { type: "updateLayout", layoutScope: "desktop", layout: null },
      diagnostics: [diagnostic("history_empty", "No command to apply.")]
    });
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

export async function undoPlanGraphCommand(
  options: PlanGraphHistoryOptions
): Promise<PlanGraphCommandResult> {
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
    return fail({
      command: { type: "updateLayout", layoutScope: "desktop", layout: null },
      diagnostics: [diagnostic("history_empty", "No command to undo.")]
    });
  }
  const result = await applyHistoryCommand(
    options,
    entry.inverse,
    entry.graphVersionAfter,
    entry.workspaceRef
  );
  if (result.ok) {
    await store.log.markUndone(entry.id);
  }
  return result;
}

export async function redoPlanGraphCommand(
  options: PlanGraphHistoryOptions
): Promise<PlanGraphCommandResult> {
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
    return fail({
      command: { type: "updateLayout", layoutScope: "desktop", layout: null },
      diagnostics: [diagnostic("history_empty", "No command to redo.")]
    });
  }
  const result = await applyHistoryCommand(
    options,
    entry.command,
    entry.graphVersionBefore,
    entry.workspaceRef
  );
  if (result.ok) {
    await store.log.markRedone(entry.id);
  }
  return result;
}
