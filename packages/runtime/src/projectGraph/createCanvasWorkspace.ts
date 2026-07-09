import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { initialManifest } from "../initWorkspace.js";
import { writeJsonFile } from "../json.js";
import { requireInitializedProjectWorkspace } from "../project.js";
import { createEmptyState } from "../state.js";
import {
  commitCanvasWorkspaceWrite,
  removeCanvasStagingWorkspace,
  stageCanvasWorkspaceWrite
} from "./canvasWorkspaceRecovery.js";
import { canonicalProjectCanvasNode } from "./canonicalWorkspace.js";
import {
  loadProjectGraphForWorkspace,
  projectGraphPath,
  writeProjectGraph
} from "./loadProjectGraph.js";
import { materializeProjectGraph } from "./materializeProjectGraph.js";
import { projectCanvasWorkspace } from "./projectGraphWorkspace.js";
import { projectGraphManifestSchema } from "./schema.js";
import type { ProjectCanvasNode } from "./types.js";

export type CreateCanvasWorkspaceOptions = {
  cwd?: string;
  id?: string;
  title: string;
  activate?: boolean;
  dryRun?: boolean;
};

export type CreateCanvasWorkspaceResult = {
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
};

const fallbackSlugPrefix = "canvas";

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

function baseCanvasId(options: { explicitId?: string; title: string }): string {
  const explicitId = options.explicitId?.trim();
  if (explicitId) {
    assertValidCanvasId(explicitId);
    return explicitId;
  }
  const slug = asciiSlug(options.title);
  return slug ?? `${fallbackSlugPrefix}-${stableCanvasHash(options.title)}`;
}

function assertValidCanvasId(id: string): void {
  projectGraphManifestSchema.parse({
    version: "plan-project/v1",
    canvases: [canonicalProjectCanvasNode({ id, title: "Canvas" })],
    edges: [],
    crossTaskEdges: []
  });
}

async function canvasWorkspaceExists(path: string): Promise<boolean> {
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
    (await canvasWorkspaceExists(input.finalRootForId(candidate)))
  ) {
    suffix += 1;
    candidate = `${input.baseId}-${suffix}`;
    assertValidCanvasId(candidate);
  }
  return candidate;
}

function resultForCanvas(input: {
  canvas: ProjectCanvasNode;
  title: string;
  projectGraphPath: string;
  created: boolean;
  activated: boolean;
  canvasRoot: string;
  packageDir: string;
  manifestPath: string;
  statePath: string;
  resultsDir: string;
}): CreateCanvasWorkspaceResult {
  const nodesDir = join(input.packageDir, "nodes");
  return {
    canvasId: input.canvas.id,
    title: input.title,
    created: input.created,
    activated: input.activated,
    projectGraphPath: input.projectGraphPath,
    canvasRoot: input.canvasRoot,
    packageDir: input.packageDir,
    manifestPath: input.manifestPath,
    taskPromptsDir: nodesDir,
    blockPromptsDir: nodesDir,
    statePath: input.statePath,
    resultsDir: input.resultsDir,
    canvasValidationArgs: ["validate", "--canvas", input.canvas.id, "--json"],
    projectValidationArgs: ["validate", "--json"],
    qualityArgs: ["graph", "quality", "--canvas", input.canvas.id, "--json"]
  };
}

async function activateCanvas(projectRoot: string, canvasId: string): Promise<void> {
  const { writeActiveTaskCanvasSelection } = await import("../desktop/canvasSelectionStore.js");
  await writeActiveTaskCanvasSelection(projectRoot, canvasId);
}

export async function createCanvasWorkspace(
  options: CreateCanvasWorkspaceOptions
): Promise<CreateCanvasWorkspaceResult> {
  const title = trimRequiredTitle(options.title);
  const baseId = baseCanvasId({ explicitId: options.id, title });
  const projectRoot = options.cwd ?? process.cwd();
  let projectWorkspace = await requireInitializedProjectWorkspace(projectRoot);

  if (!options.dryRun) {
    await materializeProjectGraph(projectRoot);
    projectWorkspace = await requireInitializedProjectWorkspace(projectRoot);
  }

  const loaded = await loadProjectGraphForWorkspace(projectWorkspace);
  const existingIds = new Set(loaded.manifest.canvases.map((canvas) => canvas.id));
  const canvasId = await nextAvailableCanvasId({
    baseId,
    existingIds,
    finalRootForId(id) {
      return projectCanvasWorkspace(loaded.workspace, canonicalProjectCanvasNode({ id, title }))
        .workspaceRoot;
    }
  });
  const canvas = canonicalProjectCanvasNode({ id: canvasId, title });
  const canvasWorkspace = projectCanvasWorkspace(loaded.workspace, canvas);
  const graphPath = projectGraphPath(loaded.workspace);
  const dryRun = options.dryRun === true;

  if (dryRun) {
    return resultForCanvas({
      canvas,
      title,
      projectGraphPath: graphPath,
      created: false,
      activated: false,
      canvasRoot: canvasWorkspace.workspaceRoot,
      packageDir: canvasWorkspace.packageDir,
      manifestPath: canvasWorkspace.manifestFile,
      statePath: canvasWorkspace.stateFile,
      resultsDir: canvasWorkspace.resultsDir
    });
  }

  const staged = await stageCanvasWorkspaceWrite(loaded.workspace, {
    canvasId,
    finalRoot: canvasWorkspace.workspaceRoot
  });
  try {
    await mkdir(join(staged.workspace.packageDir, "nodes"), { recursive: true });
    await mkdir(staged.workspace.resultsDir, { recursive: true });
    await writeJsonFile(staged.workspace.manifestFile, initialManifest(title));
    await writeJsonFile(staged.workspace.stateFile, createEmptyState());
    await commitCanvasWorkspaceWrite(loaded.workspace, staged);
  } catch (error) {
    await removeCanvasStagingWorkspace(loaded.workspace, staged.stagingRoot);
    throw error;
  }

  try {
    await writeProjectGraph(loaded.workspace, {
      ...loaded.manifest,
      canvases: [...loaded.manifest.canvases, canvas]
    });
  } catch (error) {
    await rm(canvasWorkspace.workspaceRoot, { recursive: true, force: true });
    throw error;
  }

  if (options.activate === true) {
    await activateCanvas(projectRoot, canvasId);
  }

  return resultForCanvas({
    canvas,
    title,
    projectGraphPath: graphPath,
    created: true,
    activated: options.activate === true,
    canvasRoot: canvasWorkspace.workspaceRoot,
    packageDir: canvasWorkspace.packageDir,
    manifestPath: canvasWorkspace.manifestFile,
    statePath: canvasWorkspace.stateFile,
    resultsDir: canvasWorkspace.resultsDir
  });
}
