import {
  compileProjectGraph,
  loadProjectGraph,
  projectCanvasEdgeKey,
  projectCrossTaskEdgeKey,
  projectGraphPath,
  writeProjectGraph,
  type ProjectCanvasEdge,
  type ProjectCrossTaskEdge,
  type ProjectGraphManifest,
  type ProjectTaskRef
} from "../projectGraph/index.js";
import type { PackageWorkspaceRef } from "../types.js";
import type {
  AppliedPlanGraphCommand,
  PlanGraphAffectedRefs,
  PlanGraphCommand,
  PlanGraphCommandDiagnostic,
  PlanGraphCommandResult,
  ProjectGraphCommand
} from "./commands.js";
import { emptyAffectedRefs } from "./commands.js";
import { sha256Hex, stableJson } from "./hash.js";
import type { PlanGraphCommandDependencies } from "./ports.js";

type ExecuteProjectGraphCommandOptions = {
  projectRoot: PackageWorkspaceRef;
  command: ProjectGraphCommand;
  indexPath?: string;
  recordOperation?: boolean;
};

function diagnostic(code: string, message: string, path?: string): PlanGraphCommandDiagnostic {
  return { code, message, path };
}

function projectRootString(projectRoot: PackageWorkspaceRef): string {
  return typeof projectRoot === "string" ? projectRoot : projectRoot.rootPath;
}

function projectGraphVersion(manifest: ProjectGraphManifest): string {
  return `pgg-${sha256Hex(stableJson(manifest))}`;
}

function projectGraphFingerprint(manifest: ProjectGraphManifest): string {
  return `project-${projectGraphVersion(manifest)}`;
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

function canvasEdge(fromCanvasId: string, toCanvasId: string): ProjectCanvasEdge {
  return { from: fromCanvasId, to: toCanvasId, type: "depends_on" };
}

function crossTaskEdge(from: ProjectTaskRef, to: ProjectTaskRef): ProjectCrossTaskEdge {
  return { from, to, type: "depends_on" };
}

export function isProjectGraphCommand(command: PlanGraphCommand): command is ProjectGraphCommand {
  return (
    command.type === "addCanvasDependency" ||
    command.type === "removeCanvasDependency" ||
    command.type === "addCrossTaskDependency" ||
    command.type === "removeCrossTaskDependency"
  );
}

function inverseForProjectGraphCommand(command: ProjectGraphCommand): ProjectGraphCommand {
  if (command.type === "addCanvasDependency") {
    return {
      type: "removeCanvasDependency",
      fromCanvasId: command.fromCanvasId,
      toCanvasId: command.toCanvasId
    };
  }
  if (command.type === "removeCanvasDependency") {
    return {
      type: "addCanvasDependency",
      fromCanvasId: command.fromCanvasId,
      toCanvasId: command.toCanvasId
    };
  }
  if (command.type === "addCrossTaskDependency") {
    return { type: "removeCrossTaskDependency", from: command.from, to: command.to };
  }
  return { type: "addCrossTaskDependency", from: command.from, to: command.to };
}

function commandAffectedRefs(command: ProjectGraphCommand): PlanGraphAffectedRefs {
  if (command.type === "addCanvasDependency" || command.type === "removeCanvasDependency") {
    return {
      ...emptyAffectedRefs(),
      canvases: [...new Set([command.fromCanvasId, command.toCanvasId])],
      packageFiles: ["project-graph.json"]
    };
  }
  return {
    ...emptyAffectedRefs(),
    canvases: [...new Set([command.from.canvasId, command.to.canvasId])],
    tasks: [
      `${command.from.canvasId}:${command.from.taskId}`,
      `${command.to.canvasId}:${command.to.taskId}`
    ],
    packageFiles: ["project-graph.json"]
  };
}

function nextProjectGraphManifest(
  manifest: ProjectGraphManifest,
  command: ProjectGraphCommand
): { manifest: ProjectGraphManifest; changed: boolean } {
  if (command.type === "addCanvasDependency") {
    const edge = canvasEdge(command.fromCanvasId, command.toCanvasId);
    const key = projectCanvasEdgeKey(edge);
    if (manifest.edges.some((candidate) => projectCanvasEdgeKey(candidate) === key)) {
      return { manifest, changed: false };
    }
    return { manifest: { ...manifest, edges: [...manifest.edges, edge] }, changed: true };
  }
  if (command.type === "removeCanvasDependency") {
    const edge = canvasEdge(command.fromCanvasId, command.toCanvasId);
    const key = projectCanvasEdgeKey(edge);
    const edges = manifest.edges.filter((candidate) => projectCanvasEdgeKey(candidate) !== key);
    return { manifest: { ...manifest, edges }, changed: edges.length !== manifest.edges.length };
  }
  if (command.type === "addCrossTaskDependency") {
    const edge = crossTaskEdge(command.from, command.to);
    const key = projectCrossTaskEdgeKey(edge);
    if (manifest.crossTaskEdges.some((candidate) => projectCrossTaskEdgeKey(candidate) === key)) {
      return { manifest, changed: false };
    }
    return {
      manifest: { ...manifest, crossTaskEdges: [...manifest.crossTaskEdges, edge] },
      changed: true
    };
  }
  const edge = crossTaskEdge(command.from, command.to);
  const key = projectCrossTaskEdgeKey(edge);
  const crossTaskEdges = manifest.crossTaskEdges.filter(
    (candidate) => projectCrossTaskEdgeKey(candidate) !== key
  );
  return {
    manifest: { ...manifest, crossTaskEdges },
    changed: crossTaskEdges.length !== manifest.crossTaskEdges.length
  };
}

function validateBaseVersion(
  currentVersion: string,
  command: ProjectGraphCommand
): PlanGraphCommandDiagnostic | null {
  if (!command.baseGraphVersion || command.baseGraphVersion === currentVersion) {
    return null;
  }
  return diagnostic(
    "graph_version_conflict",
    "Project graph changed after the command base graph version; re-read the graph before applying this structural command.",
    "project-graph.json"
  );
}

export async function executeProjectGraphCommand(
  options: ExecuteProjectGraphCommandOptions,
  dependencies: PlanGraphCommandDependencies
): Promise<PlanGraphCommandResult> {
  const recordOperation = options.recordOperation ?? true;
  const projectRoot = projectRootString(options.projectRoot);
  const loaded = await loadProjectGraph(projectRoot);
  const beforeVersion = projectGraphVersion(loaded.manifest);
  const beforeFingerprint = projectGraphFingerprint(loaded.manifest);
  const baseVersionDiagnostic = validateBaseVersion(beforeVersion, options.command);
  if (baseVersionDiagnostic) {
    return fail({
      command: options.command,
      diagnostics: [baseVersionDiagnostic],
      graphVersion: beforeVersion,
      packageFingerprint: beforeFingerprint
    });
  }

  const inverse = inverseForProjectGraphCommand(options.command);
  const next = nextProjectGraphManifest(loaded.manifest, options.command);
  if (!next.changed) {
    return {
      ok: true,
      workspaceRef: projectRoot,
      graphVersion: beforeVersion,
      packageFingerprint: beforeFingerprint,
      command: options.command,
      inverse,
      affected: emptyAffectedRefs(),
      changedPaths: [],
      diagnostics: []
    };
  }

  const compiled = await compileProjectGraph({
    workspace: loaded.workspace,
    manifest: next.manifest,
    source: "project_graph",
    diagnostics: []
  });
  if (compiled.diagnostics.errors.length > 0) {
    return fail({
      command: options.command,
      diagnostics: compiled.diagnostics.errors,
      graphVersion: beforeVersion,
      packageFingerprint: beforeFingerprint
    });
  }

  await writeProjectGraph(loaded.workspace, next.manifest);
  const afterVersion = projectGraphVersion(next.manifest);
  const affected = commandAffectedRefs(options.command);
  const result: AppliedPlanGraphCommand = {
    ok: true,
    workspaceRef: projectRoot,
    graphVersion: afterVersion,
    packageFingerprint: projectGraphFingerprint(next.manifest),
    command: options.command,
    inverse,
    affected,
    changedPaths: [projectGraphPath(loaded.workspace)],
    diagnostics: []
  };
  const store = await dependencies.createIndexStore({ projectRoot, indexPath: options.indexPath });
  await store.clearProjectionVersions();
  if (recordOperation) {
    result.operationId = await store.log.append({
      workspaceRef: projectRoot,
      graphVersionBefore: beforeVersion,
      graphVersionAfter: afterVersion,
      command: options.command,
      inverse,
      affected
    });
  }
  return result;
}

export async function applyProjectGraphHistoryCommand(
  options: { indexPath?: string },
  dependencies: PlanGraphCommandDependencies,
  command: ProjectGraphCommand,
  expectedGraphVersion: string,
  workspaceRef: PackageWorkspaceRef
): Promise<PlanGraphCommandResult> {
  const projectRoot = projectRootString(workspaceRef);
  const loaded = await loadProjectGraph(projectRoot);
  const currentVersion = projectGraphVersion(loaded.manifest);
  if (currentVersion !== expectedGraphVersion) {
    return fail({
      command,
      diagnostics: [
        diagnostic(
          "graph_version_conflict",
          "Project graph changed after this history entry was recorded; refusing to apply stale undo/redo.",
          "project-graph.json"
        )
      ],
      graphVersion: currentVersion,
      packageFingerprint: projectGraphFingerprint(loaded.manifest)
    });
  }

  let latest: PlanGraphCommandResult | null = null;
  for (const item of [command]) {
    latest = await executeProjectGraphCommand(
      {
        projectRoot,
        command: item,
        indexPath: options.indexPath,
        recordOperation: false
      },
      dependencies
    );
    if (!latest.ok) {
      return latest;
    }
  }
  return (
    latest ??
    fail({
      command,
      diagnostics: [diagnostic("history_empty", "No project graph command to apply.")]
    })
  );
}
