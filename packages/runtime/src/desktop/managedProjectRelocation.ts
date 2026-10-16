import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { writeJsonFile } from "../json.js";
import { projectGraphPath, writeProjectGraph } from "../projectGraph/loadProjectGraph.js";
import { projectGraphFromLegacyRegistry } from "../projectGraph/migration.js";
import { projectCanvasWorkspace } from "../projectGraph/projectGraphWorkspace.js";
import type { LoadedProjectGraph, ProjectCanvasNode } from "../projectGraph/types.js";
import type { ProjectWorkspace } from "../types.js";
import { normalizeRegistry } from "./canvasRegistry.js";

type CanvasStoragePaths = Pick<ProjectCanvasNode, "packageDir" | "stateFile" | "resultsDir">;

/** Plan both storage identities before any project relocation can mutate disk. */
export async function prepareManagedProjectRelocation(
  previous: ProjectWorkspace,
  next: ProjectWorkspace,
  graph: LoadedProjectGraph
) {
  const registryFile = join(previous.workspaceRoot, "desktop", "canvases.json");
  const graphFile = projectGraphPath(previous);
  const graphBytes = (await optionalStat(graphFile)) ? await readFile(graphFile) : null;
  const registryBytes = (await optionalStat(registryFile)) ? await readFile(registryFile) : null;
  const registry = registryBytes
    ? normalizeRegistry(JSON.parse(registryBytes.toString("utf8")))
    : null;
  function relocateStorage<T extends CanvasStoragePaths>(storage: T): T {
    const relocate = (path: string) =>
      isAbsolute(path) ? join(next.workspaceRoot, relative(previous.workspaceRoot, path)) : path;
    return {
      ...storage,
      packageDir: relocate(storage.packageDir),
      stateFile: relocate(storage.stateFile),
      resultsDir: relocate(storage.resultsDir)
    };
  }
  const previousCanvases = [
    ...graph.manifest.canvases,
    ...(registry ? projectGraphFromLegacyRegistry(registry).canvases : [])
  ];
  // Validate against the old owner before rebasing, then against the new owner.
  const storageWorkspaces = previousCanvases.flatMap((canvas) => [
    projectCanvasWorkspace(previous, canvas),
    projectCanvasWorkspace(next, relocateStorage(canvas))
  ]);
  const nextGraph = {
    ...graph.manifest,
    canvases: graph.manifest.canvases.map(relocateStorage)
  };
  const nextRegistry = registry
    ? { ...registry, canvases: registry.canvases.map(relocateStorage) }
    : null;
  return {
    storageWorkspaces,
    metadataPaths: [
      graphFile,
      projectGraphPath(next),
      registryFile,
      join(next.workspaceRoot, "desktop", "canvases.json")
    ],
    async persist() {
      if (graphBytes) await writeProjectGraph(next, nextGraph);
      if (nextRegistry) {
        await writeJsonFile(join(next.workspaceRoot, "desktop", "canvases.json"), nextRegistry);
      }
    },
    async restore() {
      if (graphBytes) await writeFile(graphFile, graphBytes);
      else await rm(graphFile, { force: true });
      if (registryBytes) await writeFile(registryFile, registryBytes);
    }
  };
}
