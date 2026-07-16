import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { optionalStat } from "../fs/optionalFile.js";
import { requireInitializedProjectWorkspace } from "../project.js";
import type { ProjectWorkspace } from "../types.js";
import {
  commitCanvasWorkspaceWrite,
  quarantineCanvasWorkspace,
  removeCanvasStagingWorkspace,
  stageCanvasWorkspaceWrite,
  type StagedCanvasWorkspaceWrite
} from "./canvasWorkspaceRecovery.js";
import {
  populateDuplicatedCanvasWorkspace,
  writeEmptyCanvasWorkspace
} from "./canvasWorkspaceContent.js";
import { canonicalProjectCanvasNode } from "./canonicalWorkspace.js";
import {
  loadProjectGraphForWorkspace,
  projectGraphPath,
  writeProjectGraph
} from "./loadProjectGraph.js";
import { materializeProjectGraphUnlocked } from "./materializeProjectGraph.js";
import { projectCanvasWorkspace } from "./projectGraphWorkspace.js";
import { projectGraphManifestSchema } from "./schema.js";
import type { LoadedProjectGraph, ProjectCanvasNode, ProjectGraphManifest } from "./types.js";

const fallbackSlugPrefix = "canvas";

export type CanvasIdAllocationMode = "slug-from-title" | "random";

export type ProjectCanvasMutationPorts = {
  withLock?<T>(
    projectWorkspaceRoot: string,
    operation: string,
    fn: () => Promise<T>
  ): Promise<T>;
  loadGraph?(workspace: ProjectWorkspace): Promise<LoadedProjectGraph>;
  writeGraph?(
    workspace: ProjectWorkspace,
    manifest: ProjectGraphManifest
  ): Promise<ProjectGraphManifest>;
  stage?(
    projectWorkspace: ProjectWorkspace,
    options: { canvasId: string; finalRoot: string }
  ): Promise<StagedCanvasWorkspaceWrite>;
  commit?(
    projectWorkspace: ProjectWorkspace,
    staged: StagedCanvasWorkspaceWrite
  ): Promise<void>;
  removeStaging?(projectWorkspace: ProjectWorkspace, path: string): Promise<void>;
  quarantine?(
    projectWorkspace: ProjectWorkspace,
    options: { canvasId: string; workspaceRoot: string }
  ): Promise<string | null>;
  removeFinal?(path: string): Promise<void>;
  writeEmpty?(workspace: ProjectWorkspace, title: string): Promise<void>;
  populateDuplicate?(
    sourceWorkspace: ProjectWorkspace,
    targetWorkspace: ProjectWorkspace,
    title: string
  ): Promise<void>;
  activateCanvas?(projectRoot: string, canvasId: string): Promise<void>;
};

export type CreateProjectCanvasInput = {
  projectRoot: string;
  /**
   * Canvas title. When omitted or blank, `defaultTitle` is used under the lock
   * against the freshly loaded graph (Desktop default-name path).
   */
  title?: string | null;
  /**
   * Called under the lock when `title` is blank. Receives titles from the
   * reloaded project graph so concurrent creators do not share a stale index.
   */
  defaultTitle?: (existingTitles: string[]) => string;
  /** Explicit base canvas id (CLI --id). Validated and de-conflicted under the lock. */
  requestedId?: string;
  /**
   * How to allocate an id when `requestedId` is omitted.
   * - `slug-from-title`: CLI-style slug / hash fallback
   * - `random`: Desktop-style `canvas-<uuid8>`
   */
  idMode?: CanvasIdAllocationMode;
  activate?: boolean;
  dryRun?: boolean;
  ports?: ProjectCanvasMutationPorts;
};

export type DuplicateProjectCanvasInput = {
  projectRoot: string;
  sourceCanvasId: string;
  name?: string | null;
  ports?: ProjectCanvasMutationPorts;
};

export type ProjectCanvasMutationResult = {
  canvas: ProjectCanvasNode;
  title: string;
  created: boolean;
  activated: boolean;
  projectGraphPath: string;
  projectWorkspace: ProjectWorkspace;
  canvasWorkspace: ProjectWorkspace;
  /** True when the canvas was newly written; false for dry-run. */
  persisted: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineErrors(primary: unknown, compensation: unknown, context: string): Error {
  return new Error(
    `${context}: ${errorMessage(primary)}; compensation failed: ${errorMessage(compensation)}`
  );
}

function trimRequiredTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("Canvas title must not be empty.");
  }
  return trimmed;
}

function asciiSlug(title: string): string | null {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/g, "")
    .replace(/[^a-z0-9]+$/g, "")
    .replace(/[-_.]{2,}/g, "-");
  return slug || null;
}

function stableCanvasHash(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 8);
}

function assertValidCanvasId(id: string): void {
  projectGraphManifestSchema.parse({
    version: "plan-project/v1",
    canvases: [canonicalProjectCanvasNode({ id, title: "Canvas" })],
    edges: [],
    crossTaskEdges: []
  });
}

function baseCanvasId(options: {
  explicitId?: string;
  title: string;
  idMode: CanvasIdAllocationMode;
}): string {
  const explicitId = options.explicitId?.trim();
  if (explicitId) {
    assertValidCanvasId(explicitId);
    return explicitId;
  }
  if (options.idMode === "random") {
    return `canvas-${randomUUID().slice(0, 8)}`;
  }
  const slug = asciiSlug(options.title);
  return slug ?? `${fallbackSlugPrefix}-${stableCanvasHash(options.title)}`;
}

async function pathExists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

async function nextAvailableCanvasId(input: {
  baseId: string;
  existingIds: Set<string>;
  finalRootForId(id: string): string;
}): Promise<string> {
  let suffix = 1;
  let candidate = input.baseId;
  while (
    input.existingIds.has(candidate) ||
    (await pathExists(input.finalRootForId(candidate)))
  ) {
    suffix += 1;
    candidate = `${input.baseId}-${suffix}`;
    assertValidCanvasId(candidate);
  }
  return candidate;
}

function nextDuplicatedCanvasName(
  existingNames: string[],
  sourceName: string,
  requestedName?: string | null
): string {
  const trimmedRequestedName = requestedName?.trim();
  if (trimmedRequestedName) {
    return trimmedRequestedName;
  }
  const baseName = sourceName.trim() || "任务画布";
  const copyName = `${baseName} copy`;
  const names = new Set(existingNames);
  if (!names.has(copyName)) {
    return copyName;
  }
  let index = 2;
  while (names.has(`${copyName} ${index}`)) {
    index += 1;
  }
  return `${copyName} ${index}`;
}

function resolvePorts(ports: ProjectCanvasMutationPorts = {}): Required<
  Omit<ProjectCanvasMutationPorts, "activateCanvas">
> &
  Pick<ProjectCanvasMutationPorts, "activateCanvas"> {
  return {
    withLock:
      ports.withLock ??
      (async (projectWorkspaceRoot, operation, fn) =>
        withProjectMutationLock(projectWorkspaceRoot, fn, { operation })),
    loadGraph: ports.loadGraph ?? loadProjectGraphForWorkspace,
    writeGraph: ports.writeGraph ?? writeProjectGraph,
    stage: ports.stage ?? stageCanvasWorkspaceWrite,
    commit: ports.commit ?? commitCanvasWorkspaceWrite,
    removeStaging: ports.removeStaging ?? removeCanvasStagingWorkspace,
    quarantine: ports.quarantine ?? quarantineCanvasWorkspace,
    removeFinal:
      ports.removeFinal ??
      (async (path) => {
        await rm(path, { recursive: true, force: true });
      }),
    writeEmpty: ports.writeEmpty ?? writeEmptyCanvasWorkspace,
    populateDuplicate: ports.populateDuplicate ?? populateDuplicatedCanvasWorkspace,
    activateCanvas: ports.activateCanvas
  };
}

async function defaultActivateCanvas(projectRoot: string, canvasId: string): Promise<void> {
  const { writeActiveTaskCanvasSelection } = await import("../desktop/canvasSelectionStore.js");
  await writeActiveTaskCanvasSelection(projectRoot, canvasId);
}

async function cleanupFailedStaging(
  ports: ReturnType<typeof resolvePorts>,
  projectWorkspace: ProjectWorkspace,
  stagingRoot: string,
  error: unknown,
  action: string
): Promise<never> {
  try {
    await ports.removeStaging(projectWorkspace, stagingRoot);
  } catch (cleanupError) {
    throw combineErrors(
      error,
      cleanupError,
      `Task canvas ${action} failed and staging cleanup failed`
    );
  }
  throw error instanceof Error ? error : new Error(errorMessage(error));
}

/**
 * After final canvas directory is visible but graph write failed:
 * try to remove the orphan final directory; if that fails, quarantine it.
 */
async function compensateFailedGraphWrite(
  ports: ReturnType<typeof resolvePorts>,
  projectWorkspace: ProjectWorkspace,
  canvasId: string,
  finalRoot: string,
  graphError: unknown
): Promise<never> {
  try {
    await ports.removeFinal(finalRoot);
  } catch (removeError) {
    try {
      const quarantineRoot = await ports.quarantine(projectWorkspace, {
        canvasId,
        workspaceRoot: finalRoot
      });
      throw new Error(
        `Task canvas '${canvasId}' was committed to disk but project graph write failed: ${errorMessage(graphError)}; final directory remove failed: ${errorMessage(removeError)}; moved to quarantine${quarantineRoot ? ` at '${quarantineRoot}'` : ""}.`
      );
    } catch (quarantineError) {
      if (
        quarantineError instanceof Error &&
        quarantineError.message.includes("project graph write failed")
      ) {
        throw quarantineError;
      }
      throw new Error(
        `Task canvas '${canvasId}' was committed to disk but project graph write failed: ${errorMessage(graphError)}; final directory remove failed: ${errorMessage(removeError)}; quarantine failed: ${errorMessage(quarantineError)}. Manual recovery required.`
      );
    }
  }
  throw graphError instanceof Error ? graphError : new Error(errorMessage(graphError));
}

function mutationResult(input: {
  canvas: ProjectCanvasNode;
  title: string;
  created: boolean;
  activated: boolean;
  projectWorkspace: ProjectWorkspace;
  canvasWorkspace: ProjectWorkspace;
  persisted: boolean;
}): ProjectCanvasMutationResult {
  return {
    canvas: input.canvas,
    title: input.title,
    created: input.created,
    activated: input.activated,
    projectGraphPath: projectGraphPath(input.projectWorkspace),
    projectWorkspace: input.projectWorkspace,
    canvasWorkspace: input.canvasWorkspace,
    persisted: input.persisted
  };
}

function resolveCreateTitle(
  input: CreateProjectCanvasInput,
  existingTitles: string[]
): string {
  const provided = input.title?.trim();
  if (provided) {
    return provided;
  }
  if (input.defaultTitle) {
    return trimRequiredTitle(input.defaultTitle(existingTitles));
  }
  throw new Error("Canvas title must not be empty.");
}

/**
 * Create a project canvas under the project mutation lock.
 *
 * Critical section (single coordinator lane):
 * materialize/authoritative source → fresh graph reload → id allocation →
 * stage/commit → graph write. Callers must not materialize or stage outside this lock.
 */
export async function createProjectCanvas(
  input: CreateProjectCanvasInput
): Promise<ProjectCanvasMutationResult> {
  const idMode = input.idMode ?? "slug-from-title";
  const projectRoot = input.projectRoot;
  const ports = resolvePorts(input.ports);
  const dryRun = input.dryRun === true;
  // Lock label uses requested base when present; otherwise a stable create marker.
  const lockSeed = input.requestedId?.trim() || (idMode === "random" ? "auto" : "slug");
  const lockLabel = `create-canvas:${lockSeed}`;

  const projectWorkspace = await requireInitializedProjectWorkspace(projectRoot);

  if (dryRun) {
    const loaded = await ports.loadGraph(projectWorkspace);
    const title = resolveCreateTitle(
      input,
      loaded.manifest.canvases.map((canvas) => canvas.title)
    );
    const baseId = baseCanvasId({
      explicitId: input.requestedId,
      title,
      idMode
    });
    const existingIds = new Set(loaded.manifest.canvases.map((canvas) => canvas.id));
    const canvasId = await nextAvailableCanvasId({
      baseId,
      existingIds,
      finalRootForId(id) {
        return projectCanvasWorkspace(
          loaded.workspace,
          canonicalProjectCanvasNode({ id, title })
        ).workspaceRoot;
      }
    });
    const canvas = canonicalProjectCanvasNode({ id: canvasId, title });
    const canvasWorkspace = projectCanvasWorkspace(loaded.workspace, canvas);
    return mutationResult({
      canvas,
      title,
      created: false,
      activated: false,
      projectWorkspace: loaded.workspace,
      canvasWorkspace,
      persisted: false
    });
  }

  return ports.withLock(projectWorkspace.workspaceRoot, lockLabel, async () => {
    // Unlocked primitive: outer withLock already owns the project mutation lane.
    // Public materializeProjectGraph also takes the same lock for external callers.
    await materializeProjectGraphUnlocked(projectRoot);
    const lockedWorkspace = await requireInitializedProjectWorkspace(projectRoot);
    const loaded = await ports.loadGraph(lockedWorkspace);
    const title = resolveCreateTitle(
      input,
      loaded.manifest.canvases.map((canvas) => canvas.title)
    );
    const baseId = baseCanvasId({
      explicitId: input.requestedId,
      title,
      idMode
    });
    const existingIds = new Set(loaded.manifest.canvases.map((canvas) => canvas.id));
    const canvasId = await nextAvailableCanvasId({
      baseId,
      existingIds,
      finalRootForId(id) {
        return projectCanvasWorkspace(
          loaded.workspace,
          canonicalProjectCanvasNode({ id, title })
        ).workspaceRoot;
      }
    });
    const canvas = canonicalProjectCanvasNode({ id: canvasId, title });
    const canvasWorkspace = projectCanvasWorkspace(loaded.workspace, canvas);

    const staged = await ports.stage(loaded.workspace, {
      canvasId,
      finalRoot: canvasWorkspace.workspaceRoot
    });
    try {
      await ports.writeEmpty(staged.workspace, title);
      await ports.commit(loaded.workspace, staged);
    } catch (error) {
      await cleanupFailedStaging(ports, loaded.workspace, staged.stagingRoot, error, "create");
    }

    const nextManifest: ProjectGraphManifest = {
      ...loaded.manifest,
      canvases: [...loaded.manifest.canvases, canvas]
    };
    try {
      await ports.writeGraph(loaded.workspace, nextManifest);
    } catch (error) {
      await compensateFailedGraphWrite(
        ports,
        loaded.workspace,
        canvasId,
        canvasWorkspace.workspaceRoot,
        error
      );
    }

    let activated = false;
    if (input.activate === true) {
      const activate = ports.activateCanvas ?? defaultActivateCanvas;
      await activate(projectRoot, canvasId);
      activated = true;
    }

    return mutationResult({
      canvas,
      title,
      created: true,
      activated,
      projectWorkspace: loaded.workspace,
      canvasWorkspace,
      persisted: true
    });
  });
}

/**
 * Duplicate a project canvas under the project mutation lock.
 * Materialize, source validation, target id allocation, copy, commit, and graph write
 * are one critical section — same coordinator lane as create.
 */
export async function duplicateProjectCanvas(
  input: DuplicateProjectCanvasInput
): Promise<ProjectCanvasMutationResult> {
  const projectRoot = input.projectRoot;
  const ports = resolvePorts(input.ports);
  const projectWorkspace = await requireInitializedProjectWorkspace(projectRoot);
  const lockLabel = `duplicate-canvas:${input.sourceCanvasId}`;

  return ports.withLock(projectWorkspace.workspaceRoot, lockLabel, async () => {
    await materializeProjectGraphUnlocked(projectRoot);
    const lockedWorkspace = await requireInitializedProjectWorkspace(projectRoot);
    const loaded = await ports.loadGraph(lockedWorkspace);
    const sourceCanvas = loaded.manifest.canvases.find(
      (candidate) => candidate.id === input.sourceCanvasId
    );
    if (!sourceCanvas) {
      throw new Error(`Project canvas '${input.sourceCanvasId}' does not exist.`);
    }

    const title = nextDuplicatedCanvasName(
      loaded.manifest.canvases.map((canvas) => canvas.title),
      sourceCanvas.title,
      input.name
    );
    const baseId = `canvas-${randomUUID().slice(0, 8)}`;
    const existingIds = new Set(loaded.manifest.canvases.map((canvas) => canvas.id));
    const canvasId = await nextAvailableCanvasId({
      baseId,
      existingIds,
      finalRootForId(id) {
        return projectCanvasWorkspace(
          loaded.workspace,
          canonicalProjectCanvasNode({ id, title })
        ).workspaceRoot;
      }
    });
    const canvas = canonicalProjectCanvasNode({ id: canvasId, title });
    const sourceWorkspace = projectCanvasWorkspace(loaded.workspace, sourceCanvas);
    const canvasWorkspace = projectCanvasWorkspace(loaded.workspace, canvas);

    const staged = await ports.stage(loaded.workspace, {
      canvasId,
      finalRoot: canvasWorkspace.workspaceRoot
    });
    try {
      await ports.populateDuplicate(sourceWorkspace, staged.workspace, title);
      await ports.commit(loaded.workspace, staged);
    } catch (error) {
      await cleanupFailedStaging(ports, loaded.workspace, staged.stagingRoot, error, "duplication");
    }

    const nextManifest: ProjectGraphManifest = {
      ...loaded.manifest,
      canvases: [...loaded.manifest.canvases, canvas]
    };
    try {
      await ports.writeGraph(loaded.workspace, nextManifest);
    } catch (error) {
      await compensateFailedGraphWrite(
        ports,
        loaded.workspace,
        canvasId,
        canvasWorkspace.workspaceRoot,
        error
      );
    }

    return mutationResult({
      canvas,
      title,
      created: true,
      activated: false,
      projectWorkspace: loaded.workspace,
      canvasWorkspace,
      persisted: true
    });
  });
}

/** Map mutation result into the public CLI createCanvasWorkspace DTO shape. */
export function toCreateCanvasWorkspaceResult(
  result: ProjectCanvasMutationResult
): {
  canvasId: string;
  title: string;
  created: boolean;
  activated: boolean;
  projectGraphPath: string;
  canvasRoot: string;
  packageDir: string;
  manifestPath: string;
  taskPromptsDir: string;
  blockPromptsDir: string;
  statePath: string;
  resultsDir: string;
  canvasValidationArgs: string[];
  projectValidationArgs: string[];
  qualityArgs: string[];
} {
  const nodesDir = join(result.canvasWorkspace.packageDir, "nodes");
  return {
    canvasId: result.canvas.id,
    title: result.title,
    created: result.created,
    activated: result.activated,
    projectGraphPath: result.projectGraphPath,
    canvasRoot: result.canvasWorkspace.workspaceRoot,
    packageDir: result.canvasWorkspace.packageDir,
    manifestPath: result.canvasWorkspace.manifestFile,
    taskPromptsDir: nodesDir,
    blockPromptsDir: nodesDir,
    statePath: result.canvasWorkspace.stateFile,
    resultsDir: result.canvasWorkspace.resultsDir,
    canvasValidationArgs: ["validate", "--canvas", result.canvas.id, "--json"],
    projectValidationArgs: ["validate", "--json"],
    qualityArgs: ["graph", "quality", "--canvas", result.canvas.id, "--json"]
  };
}

/** Desktop default title when the caller does not supply a name. */
export function nextDefaultDesktopCanvasTitle(existingTitles: string[]): string {
  const names = new Set(existingTitles);
  let index = existingTitles.length + 1;
  while (names.has(`新任务画布 ${index}`)) {
    index += 1;
  }
  return `新任务画布 ${index}`;
}
