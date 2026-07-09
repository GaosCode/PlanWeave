import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { readProject, resolveProjectWorkspace } from "../project.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";
import { readDesktopProjectProjection } from "./graph/projectProjectionModel.js";
import { buildCanvasMapProjection } from "../plangraph/projections/index.js";
import { sha256Hex, stableJson } from "../plangraph/hash.js";
import type {
  DesktopCanvasGraphViewModel,
  DesktopCanvasMapLayout,
  DesktopCanvasMapLayoutNode
} from "./types.js";

function canvasMapLayoutPath(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
}

function defaultCanvasMapLayout(projectId: string, canvasIds: string[]): DesktopCanvasMapLayout {
  return {
    version: "desktop-canvas-map-layout/v1",
    projectId,
    nodes: canvasIds.map((canvasId, index) => ({
      canvasId,
      x: 80 + (index % 3) * 380,
      y: 80 + Math.floor(index / 3) * 220
    })),
    updatedAt: new Date(0).toISOString()
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCanvasMapLayoutNode(value: unknown): DesktopCanvasMapLayoutNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const canvasId =
    typeof record.canvasId === "string" && record.canvasId.trim() ? record.canvasId : null;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  if (!canvasId || x === null || y === null) {
    return null;
  }
  return { canvasId, x, y };
}

function normalizeCanvasMapLayout(
  input: unknown,
  projectId: string,
  canvasIds: string[]
): DesktopCanvasMapLayout {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return defaultCanvasMapLayout(projectId, canvasIds);
  }
  const raw = input as Record<string, unknown>;
  const canvasIdSet = new Set(canvasIds);
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes
        .flatMap((node) => {
          const normalized = normalizeCanvasMapLayoutNode(node);
          return normalized ? [normalized] : [];
        })
        .filter((node) => canvasIdSet.has(node.canvasId))
    : [];
  const existingCanvasIds = new Set(nodes.map((node) => node.canvasId));
  const fallbackNodes = defaultCanvasMapLayout(projectId, canvasIds).nodes.filter(
    (node) => !existingCanvasIds.has(node.canvasId)
  );
  return {
    version: "desktop-canvas-map-layout/v1",
    projectId,
    nodes: [...nodes, ...fallbackNodes],
    updatedAt:
      typeof raw.updatedAt === "string" && raw.updatedAt.trim()
        ? raw.updatedAt
        : new Date(0).toISOString()
  };
}

async function projectTitle(projectRoot: string, fallback: string): Promise<string> {
  return (await readProject(projectRoot))?.name ?? fallback;
}

function projectTodoGraphVersion(
  todoContext: Awaited<ReturnType<typeof readDesktopProjectProjection>>["todoContext"]
): string {
  return sha256Hex(
    stableJson({
      projectGraph: todoContext.aggregation.graph.manifest,
      orderedCanvasIds: todoContext.aggregation.orderedCanvasIds,
      canvases: todoContext.aggregation.orderedCanvasIds.map((canvasId) => {
        const snapshot = todoContext.snapshotsByCanvas.get(canvasId);
        return {
          canvasId,
          graphVersion: snapshot?.graphVersion ?? null,
          failed: Boolean(snapshot?.error)
        };
      })
    })
  );
}

async function canvasIdsForProject(
  projectRoot: string
): Promise<{ workspace: ProjectWorkspace; projectId: string; canvasIds: string[] }> {
  const { todoContext } = await readDesktopProjectProjection(projectRoot);
  const { loaded, graph } = todoContext.aggregation;
  return {
    workspace: loaded.workspace,
    projectId: loaded.workspace.id,
    canvasIds: graph.canvasIdsInOrder
  };
}

export async function getCanvasGraphViewModel(
  projectRoot: string
): Promise<DesktopCanvasGraphViewModel> {
  const { todoContext } = await readDesktopProjectProjection(projectRoot);
  const { loaded } = todoContext.aggregation;
  const firstCanvasId = todoContext.aggregation.graph.canvasIdsInOrder[0];
  const titleFallback = firstCanvasId
    ? (todoContext.aggregation.canvasesById.get(firstCanvasId)?.canvasName ?? loaded.workspace.id)
    : loaded.workspace.id;
  return buildCanvasMapProjection({
    graphVersion: projectTodoGraphVersion(todoContext),
    context: todoContext,
    projectId: loaded.workspace.id,
    projectTitle: await projectTitle(projectRoot, titleFallback)
  }).viewModel;
}

export async function getCanvasMapLayout(projectRoot: string): Promise<DesktopCanvasMapLayout> {
  const { workspace, projectId, canvasIds } = await canvasIdsForProject(projectRoot);
  const path = canvasMapLayoutPath(workspace);
  if (!(await optionalStat(path))) {
    return defaultCanvasMapLayout(projectId, canvasIds);
  }
  return normalizeCanvasMapLayout(await readJsonFile<unknown>(path), projectId, canvasIds);
}

export async function saveCanvasMapLayout(
  projectRoot: string,
  layout: DesktopCanvasMapLayout
): Promise<DesktopCanvasMapLayout> {
  const { workspace, projectId, canvasIds } = await canvasIdsForProject(projectRoot);
  const canvasIdSet = new Set(canvasIds);
  const next: DesktopCanvasMapLayout = {
    version: "desktop-canvas-map-layout/v1",
    projectId,
    nodes: layout.nodes.filter((node) => canvasIdSet.has(node.canvasId)),
    updatedAt: new Date().toISOString()
  };
  const path = canvasMapLayoutPath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, next);
  return next;
}

export async function resetCanvasMapLayout(projectRoot: string): Promise<DesktopCanvasMapLayout> {
  const workspace = await resolveProjectWorkspace(projectRoot);
  await rm(canvasMapLayoutPath(workspace), { force: true });
  const { projectId, canvasIds } = await canvasIdsForProject(projectRoot);
  return defaultCanvasMapLayout(projectId, canvasIds);
}
