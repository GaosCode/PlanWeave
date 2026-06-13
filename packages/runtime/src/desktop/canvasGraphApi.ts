import { constants } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compileProjectGraph, loadProjectGraph, projectCanvasWorkspace } from "../projectGraph/index.js";
import { readProject, resolveProjectWorkspace } from "../project.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { ProjectWorkspace, ValidationIssue } from "../types.js";
import { canvasDiagnostics } from "./canvasDiagnostics.js";
import type {
  DesktopCanvasGraphViewModel,
  DesktopCanvasMapLayout,
  DesktopCanvasMapLayoutNode
} from "./types.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

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
  const canvasId = typeof record.canvasId === "string" && record.canvasId.trim() ? record.canvasId : null;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  if (!canvasId || x === null || y === null) {
    return null;
  }
  return { canvasId, x, y };
}

function normalizeCanvasMapLayout(input: unknown, projectId: string, canvasIds: string[]): DesktopCanvasMapLayout {
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
  const fallbackNodes = defaultCanvasMapLayout(projectId, canvasIds).nodes.filter((node) => !existingCanvasIds.has(node.canvasId));
  return {
    version: "desktop-canvas-map-layout/v1",
    projectId,
    nodes: [...nodes, ...fallbackNodes],
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt : new Date(0).toISOString()
  };
}

function diagnosticsForCanvas(canvasId: string, diagnostics: ValidationIssue[]): ValidationIssue[] {
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.path === canvasId) {
      return true;
    }
    return (
      diagnostic.message.includes(`'${canvasId}'`) ||
      diagnostic.message.includes(`${canvasId}::`) ||
      diagnostic.message.includes(`::${canvasId}`)
    );
  });
}

async function projectTitle(projectRoot: string, fallback: string): Promise<string> {
  return (await readProject(projectRoot))?.name ?? fallback;
}

async function canvasIdsForProject(projectRoot: string): Promise<{ workspace: ProjectWorkspace; projectId: string; canvasIds: string[] }> {
  const loaded = await loadProjectGraph(projectRoot);
  return {
    workspace: loaded.workspace,
    projectId: loaded.workspace.id,
    canvasIds: loaded.manifest.canvases.map((canvas) => canvas.id)
  };
}

export async function getCanvasGraphViewModel(projectRoot: string): Promise<DesktopCanvasGraphViewModel> {
  const loaded = await loadProjectGraph(projectRoot);
  const graph = await compileProjectGraph(loaded);
  const diagnostics = [...graph.diagnostics.errors, ...graph.diagnostics.warnings];
  const canvases = await Promise.all(
    graph.canvasIdsInOrder.map(async (canvasId) => {
      const canvas = graph.canvasesById.get(canvasId);
      if (!canvas) {
        throw new Error(`Project canvas '${canvasId}' does not exist.`);
      }
      const workspace = projectCanvasWorkspace(loaded.workspace, canvas);
      return {
        canvasId: canvas.id,
        title: canvas.title,
        packageDir: canvas.packageDir,
        diagnostics: [...(await canvasDiagnostics(workspace)), ...diagnosticsForCanvas(canvas.id, diagnostics)]
      };
    })
  );
  return {
    projectId: loaded.workspace.id,
    projectTitle: await projectTitle(projectRoot, canvases[0]?.title ?? loaded.workspace.id),
    canvases,
    edges: graph.manifest.edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type })),
    crossTaskEdges: graph.crossTaskEdges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type })),
    diagnostics
  };
}

export async function getCanvasMapLayout(projectRoot: string): Promise<DesktopCanvasMapLayout> {
  const { workspace, projectId, canvasIds } = await canvasIdsForProject(projectRoot);
  const path = canvasMapLayoutPath(workspace);
  if (!(await exists(path))) {
    return defaultCanvasMapLayout(projectId, canvasIds);
  }
  return normalizeCanvasMapLayout(await readJsonFile<unknown>(path), projectId, canvasIds);
}

export async function saveCanvasMapLayout(projectRoot: string, layout: DesktopCanvasMapLayout): Promise<DesktopCanvasMapLayout> {
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
