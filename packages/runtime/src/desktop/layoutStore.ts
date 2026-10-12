import { withImportTransactionReadAdmission } from "../package/importTransactionLock.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import {
  assertNoPendingImportTransactionRemoval,
  assertNoPendingImportTransactionWrite
} from "../package/importTransaction.js";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import type { PackageWorkspaceRef, PlanPackageManifest, ProjectWorkspace } from "../types.js";
import type { PlanGraphLayoutStore } from "../plangraph/ports.js";
import type { DesktopLayout, DesktopLayoutNode } from "./types.js";
import {
  readActiveTaskCanvasSelection,
  readActiveTaskCanvasSelectionForWorkspace,
  writeActiveTaskCanvasSelection,
  writeActiveTaskCanvasSelectionForWorkspace
} from "./canvasSelectionStore.js";

export function defaultDesktopLayout(projectId: string): DesktopLayout {
  return {
    version: "desktop-layout/v1",
    projectId,
    nodes: [],
    updatedAt: new Date(0).toISOString()
  };
}

export function layoutPathForWorkspace(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "desktop", "layout.json");
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
  const updatedAt =
    typeof raw.updatedAt === "string" && raw.updatedAt.trim()
      ? raw.updatedAt
      : new Date(0).toISOString();
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

/** Validate a logical content-version layout against an already validated package. */
export function parseDesktopLayoutForPackage(
  input: unknown,
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest,
  options: { authorityProjectId?: string } = {}
): DesktopLayout {
  const expectedProjectId = options.authorityProjectId ?? workspace.id;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input as Record<string, unknown>).projectId !== expectedProjectId
  ) {
    throw new Error("content_version_layout_invalid");
  }
  const normalized = normalizeLayout(input, workspace.id);
  if (normalized.version !== "desktop-layout/v1" || normalized.projectId !== workspace.id) {
    throw new Error("content_version_layout_invalid");
  }
  return filterLayoutNodes(normalized, manifest);
}

function filterLayoutNodes(layout: DesktopLayout, manifest: PlanPackageManifest): DesktopLayout {
  const nodeIds = manifestNodeIds(manifest);
  return {
    ...layout,
    nodes: layout.nodes.filter((node) => nodeIds.has(node.nodeId))
  };
}

export async function getDesktopLayoutDirect(
  projectRoot: PackageWorkspaceRef
): Promise<DesktopLayout> {
  const workspace = await resolvePackageWorkspace(projectRoot);
  return withPackageFileConsistency(
    [workspace.packageDir, layoutPathForWorkspace(workspace)],
    async () => {
      const { manifest } = await loadPackage(workspace);
      return getDesktopLayoutForPackage(workspace, manifest);
    }
  );
}

export async function getDesktopLayoutForPackage(
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest
): Promise<DesktopLayout> {
  const path = layoutPathForWorkspace(workspace);
  return withPackageFileConsistency([workspace.packageDir, path], async () => {
    if (!(await optionalStat(path))) {
      return defaultDesktopLayout(workspace.id);
    }
    return filterLayoutNodes(
      normalizeLayout(await readJsonFile<unknown>(path), workspace.id),
      manifest
    );
  });
}

export async function saveDesktopLayoutDirect(
  projectRoot: PackageWorkspaceRef,
  layout: DesktopLayout,
  options: { updatedAt?: string } = {}
): Promise<DesktopLayout> {
  const workspace = await resolvePackageWorkspace(projectRoot);
  return withPackageFileConsistency(
    [workspace.packageDir, layoutPathForWorkspace(workspace)],
    async () => {
      return withImportTransactionReadAdmission(
        [dirname(workspace.projectFile)],
        [layoutPathForWorkspace(workspace)],
        async () => {
          await assertNoPendingImportTransactionWrite({
            workspaceRoot: dirname(workspace.projectFile),
            target: layoutPathForWorkspace(workspace)
          });
          const { manifest } = await loadPackage(workspace);
          const next = filterLayoutNodes(
            {
              ...layout,
              version: "desktop-layout/v1",
              projectId: workspace.id,
              updatedAt: options.updatedAt ?? new Date().toISOString()
            },
            manifest
          );
          const path = layoutPathForWorkspace(workspace);
          await mkdir(dirname(path), { recursive: true });
          await writeJsonFile(path, next);
          return next;
        }
      );
    }
  );
}

export async function resetDesktopLayoutDirect(
  projectRoot: PackageWorkspaceRef
): Promise<DesktopLayout> {
  const workspace = await resolvePackageWorkspace(projectRoot);
  return withPackageFileConsistency(
    [workspace.packageDir, layoutPathForWorkspace(workspace)],
    async () => {
      return withImportTransactionReadAdmission(
        [dirname(workspace.projectFile)],
        [layoutPathForWorkspace(workspace)],
        async () => {
          await assertNoPendingImportTransactionRemoval({
            workspaceRoot: dirname(workspace.projectFile),
            target: layoutPathForWorkspace(workspace)
          });
          await rm(layoutPathForWorkspace(workspace), { force: true });
          return defaultDesktopLayout(workspace.id);
        }
      );
    }
  );
}

export const desktopLayoutCommandStore: PlanGraphLayoutStore = {
  async read(projectRoot, layoutScope) {
    if (layoutScope === "canvas") {
      return typeof projectRoot === "string"
        ? readActiveTaskCanvasSelection(projectRoot)
        : readActiveTaskCanvasSelectionForWorkspace(projectRoot);
    }
    if (layoutScope !== "desktop") {
      throw new Error(`Unsupported PlanGraph layout scope '${layoutScope}'.`);
    }
    return getDesktopLayoutDirect(projectRoot);
  },
  async write(projectRoot, layoutScope, layout) {
    if (layoutScope === "canvas") {
      const activeCanvasId =
        layout && typeof layout === "object" && !Array.isArray(layout)
          ? (layout as Record<string, unknown>).activeCanvasId
          : null;
      if (typeof activeCanvasId !== "string" || !activeCanvasId.trim()) {
        throw new Error("Active canvas selection requires activeCanvasId.");
      }
      return typeof projectRoot === "string"
        ? writeActiveTaskCanvasSelection(projectRoot, activeCanvasId)
        : writeActiveTaskCanvasSelectionForWorkspace(projectRoot, activeCanvasId);
    }
    if (layoutScope !== "desktop") {
      throw new Error(`Unsupported PlanGraph layout scope '${layoutScope}'.`);
    }
    return saveDesktopLayoutDirect(projectRoot, layout as DesktopLayout);
  }
};
