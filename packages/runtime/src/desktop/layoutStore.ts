import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import type { PackageWorkspaceRef, PlanPackageManifest, ProjectWorkspace } from "../types.js";
import type { PlanGraphLayoutStore } from "../plangraph/ports.js";
import type { DesktopLayout, DesktopLayoutNode } from "./types.js";
import { readActiveTaskCanvasSelection, writeActiveTaskCanvasSelection } from "./canvasSelectionStore.js";

export function defaultDesktopLayout(projectId: string): DesktopLayout {
  return {
    version: "desktop-layout/v1",
    projectId,
    nodes: [],
    updatedAt: new Date(0).toISOString()
  };
}

function layoutPathForWorkspace(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "desktop", "layout.json");
}

async function layoutPath(projectRoot: PackageWorkspaceRef): Promise<string> {
  return layoutPathForWorkspace(await resolvePackageWorkspace(projectRoot));
}

function manifestNodeIds(manifest: PlanPackageManifest): Set<string> {
  return new Set(manifest.nodes.map((node) => node.id));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeLayoutNode(value: unknown): DesktopLayoutNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const nodeId = typeof record.nodeId === "string" && record.nodeId.trim() ? record.nodeId : null;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  if (!nodeId || x === null || y === null) {
    return null;
  }
  return { nodeId, x, y };
}

function normalizeLegacyLayoutNode(nodeId: string, value: unknown): DesktopLayoutNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const position = record.position;
  if (!position || typeof position !== "object" || Array.isArray(position)) {
    return null;
  }
  const coordinates = position as Record<string, unknown>;
  const x = finiteNumber(coordinates.x);
  const y = finiteNumber(coordinates.y);
  if (!nodeId.trim() || x === null || y === null) {
    return null;
  }
  return { nodeId, x, y };
}

function normalizeLayout(input: unknown, projectId: string): DesktopLayout {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return defaultDesktopLayout(projectId);
  }
  const raw = input as Record<string, unknown>;
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt : new Date(0).toISOString();
  if (Array.isArray(raw.nodes)) {
    return {
      version: "desktop-layout/v1",
      projectId,
      nodes: raw.nodes.flatMap((node) => {
        const normalized = normalizeLayoutNode(node);
        return normalized ? [normalized] : [];
      }),
      updatedAt
    };
  }
  if (raw.nodes && typeof raw.nodes === "object" && !Array.isArray(raw.nodes)) {
    return {
      version: "desktop-layout/v1",
      projectId,
      nodes: Object.entries(raw.nodes).flatMap(([nodeId, node]) => {
        const normalized = normalizeLegacyLayoutNode(nodeId, node);
        return normalized ? [normalized] : [];
      }),
      updatedAt
    };
  }
  return defaultDesktopLayout(projectId);
}

function filterLayoutNodes(layout: DesktopLayout, manifest: PlanPackageManifest): DesktopLayout {
  const nodeIds = manifestNodeIds(manifest);
  return {
    ...layout,
    nodes: layout.nodes.filter((node) => nodeIds.has(node.nodeId))
  };
}

export async function getDesktopLayoutDirect(projectRoot: PackageWorkspaceRef): Promise<DesktopLayout> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  return getDesktopLayoutForPackage(workspace, manifest);
}

export async function getDesktopLayoutForPackage(workspace: ProjectWorkspace, manifest: PlanPackageManifest): Promise<DesktopLayout> {
  const path = layoutPathForWorkspace(workspace);
  if (!(await optionalStat(path))) {
    return defaultDesktopLayout(workspace.id);
  }
  return filterLayoutNodes(normalizeLayout(await readJsonFile<unknown>(path), workspace.id), manifest);
}

export async function saveDesktopLayoutDirect(projectRoot: PackageWorkspaceRef, layout: DesktopLayout): Promise<DesktopLayout> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const next = filterLayoutNodes({
    ...layout,
    version: "desktop-layout/v1",
    projectId: workspace.id,
    updatedAt: new Date().toISOString()
  }, manifest);
  const path = layoutPathForWorkspace(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, next);
  return next;
}

export async function resetDesktopLayoutDirect(projectRoot: PackageWorkspaceRef): Promise<DesktopLayout> {
  const workspace = await resolvePackageWorkspace(projectRoot);
  await rm(await layoutPath(projectRoot), { force: true });
  return defaultDesktopLayout(workspace.id);
}

export const desktopLayoutCommandStore: PlanGraphLayoutStore = {
  async read(projectRoot, layoutScope) {
    if (layoutScope === "canvas") {
      const projectWorkspace = typeof projectRoot === "string" ? projectRoot : projectRoot.rootPath;
      return readActiveTaskCanvasSelection(projectWorkspace);
    }
    if (layoutScope !== "desktop") {
      throw new Error(`Unsupported PlanGraph layout scope '${layoutScope}'.`);
    }
    return getDesktopLayoutDirect(projectRoot);
  },
  async write(projectRoot, layoutScope, layout) {
    if (layoutScope === "canvas") {
      const projectWorkspace = typeof projectRoot === "string" ? projectRoot : projectRoot.rootPath;
      const activeCanvasId = layout && typeof layout === "object" && !Array.isArray(layout) ? (layout as Record<string, unknown>).activeCanvasId : null;
      if (typeof activeCanvasId !== "string" || !activeCanvasId.trim()) {
        throw new Error("Active canvas selection requires activeCanvasId.");
      }
      return writeActiveTaskCanvasSelection(projectWorkspace, activeCanvasId);
    }
    if (layoutScope !== "desktop") {
      throw new Error(`Unsupported PlanGraph layout scope '${layoutScope}'.`);
    }
    return saveDesktopLayoutDirect(projectRoot, layout as DesktopLayout);
  }
};
