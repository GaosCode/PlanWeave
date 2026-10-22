import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import type { ProjectWorkspace } from "../types.js";
import { loadProjectGraphForWorkspace } from "./loadProjectGraph.js";
import { projectCanvasWorkspace } from "./projectGraphWorkspace.js";
import type { DefaultCanvasWorkspacePaths } from "./defaultCanvasWorkspaceMigration.js";

export type DefaultCanvasMigrationStorage = {
  paths: DefaultCanvasWorkspacePaths;
  authority: string;
  identity: string;
  sourceIdentity: string;
  hasDefaultCanvas: boolean;
  canonicalAuthority: boolean;
};

export function migrationStorageTargets(paths: DefaultCanvasWorkspacePaths): string[] {
  return [paths.packageDir, paths.stateFile, paths.resultsDir];
}

function overlaps(left: string, right: string): boolean {
  const rel = relative(resolve(left), resolve(right));
  return !rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertDisjoint(left: string, right: string): void {
  if (overlaps(left, right) || overlaps(right, left)) {
    throw new Error(`Default canvas migration storage overlaps: '${left}' and '${right}'.`);
  }
}

async function storageIdentity(root: string, paths: string[]): Promise<string> {
  try {
    await lstat(root);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return JSON.stringify({ root, missing: true });
    }
    throw error;
  }
  const identities: string[] = [];
  for (const path of paths) {
    await resolvePackagePath(root, relative(root, path), { forWrite: true });
    let current = root;
    for (const segment of relative(root, path).split(sep)) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
          throw new Error(`Default canvas migration cannot copy aliased storage '${current}'.`);
        }
        identities.push(`${current}:${info.dev}:${info.ino}:${info.birthtimeMs}`);
      } catch (error) {
        if (!isNodeFileNotFoundError(error)) throw error;
        identities.push(`${current}:missing`);
        break;
      }
    }
  }
  return JSON.stringify(identities);
}

/** Explicit migration uses the published graph, then the registry, then the traditional root. */
export async function resolveDefaultCanvasMigrationStorage(
  workspace: ProjectWorkspace,
  traditional: DefaultCanvasWorkspacePaths,
  canonical: DefaultCanvasWorkspacePaths
): Promise<DefaultCanvasMigrationStorage> {
  const loaded = await loadProjectGraphForWorkspace(workspace);
  const canvas = loaded.manifest.canvases.find((candidate) => candidate.id === "default");
  // Source and target paths must use the same captured root, including Home aliases.
  const registered = canvas ? projectCanvasWorkspace(workspace, canvas) : null;
  const canonicalTargets = migrationStorageTargets(canonical).map((path) => resolve(path));
  const canonicalDefault =
    registered &&
    migrationStorageTargets(registered).every(
      (path, index) => resolve(path) === canonicalTargets[index]
    );
  const canonicalAuthority = loaded.source !== "legacy_default_canvas" && Boolean(canonicalDefault);
  // Canonical graphs retain diagnostics and explicit recovery for traditional root packages.
  const paths =
    loaded.source === "legacy_default_canvas" || canonicalDefault || !registered
      ? traditional
      : {
          workspaceRoot: dirname(registered.packageDir),
          packageDir: resolve(registered.packageDir),
          stateFile: resolve(registered.stateFile),
          resultsDir: resolve(registered.resultsDir)
        };
  const authority = JSON.stringify({
    source: loaded.source,
    ...(loaded.source === "legacy_default_canvas" ? {} : { manifest: loaded.manifest })
  });
  if (!canvas) {
    return {
      paths,
      authority,
      identity: "",
      sourceIdentity: "",
      hasDefaultCanvas: false,
      canonicalAuthority
    };
  }
  const sourceTargets = migrationStorageTargets(paths);
  for (let index = 0; index < sourceTargets.length; index++) {
    for (const other of sourceTargets.slice(index + 1)) assertDisjoint(sourceTargets[index], other);
    for (const target of canonicalTargets) assertDisjoint(sourceTargets[index], target);
  }
  for (const other of loaded.manifest.canvases) {
    if (other.id === "default") continue;
    const otherPaths = projectCanvasWorkspace(workspace, other);
    for (const target of migrationStorageTargets(otherPaths)) {
      for (const owned of [...sourceTargets, ...canonicalTargets]) assertDisjoint(owned, target);
    }
  }
  return {
    paths,
    authority,
    sourceIdentity: await storageIdentity(workspace.workspaceRoot, sourceTargets),
    identity: await storageIdentity(workspace.workspaceRoot, [
      ...sourceTargets,
      ...canonicalTargets
    ]),
    hasDefaultCanvas: Boolean(canvas),
    canonicalAuthority
  };
}

export function assertSameDefaultCanvasMigrationStorage(
  expected: DefaultCanvasMigrationStorage,
  current: DefaultCanvasMigrationStorage
): void {
  if (expected.authority !== current.authority || expected.identity !== current.identity) {
    throw new Error("Default canvas migration storage changed while acquiring storage locks.");
  }
}
