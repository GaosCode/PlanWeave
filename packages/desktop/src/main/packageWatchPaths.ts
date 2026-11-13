import { dirname } from "node:path";
import {
  isOrphanPromptWatchPath,
  normalizePackageWatchPath,
  type ProjectWorkspace
} from "@planweave-ai/runtime";

export type TaskCanvasWorkspace = ProjectWorkspace;

export type PackageWatchRoot = {
  rootPath: string;
  scope: "package" | "policy";
};

export function watchedRootsForWorkspace(workspace: TaskCanvasWorkspace): PackageWatchRoot[] {
  return [
    { rootPath: workspace.packageDir, scope: "package" },
    { rootPath: dirname(workspace.projectPromptFile), scope: "policy" }
  ];
}

export function packageWatchEventPaths(
  scope: PackageWatchRoot["scope"],
  filename: string | Buffer | null,
  aliases: ReadonlyMap<string, string[]>
): string[] {
  const path = normalizePackageWatchPath(filename?.toString() ?? "");
  if (scope === "policy") {
    return !path || path === "project-prompt.md" ? ["policy/project-prompt.md"] : [];
  }
  if (!path || path === "manifest.json") return ["package/manifest.json"];
  const prompts = new Set(aliases.get(path));
  if (isOrphanPromptWatchPath(path)) prompts.add(path);
  return [...prompts].map((prompt) => `package/${prompt}`);
}

export function watchAliasAncestors(
  aliases: ReadonlyMap<string, string[]>
): Map<string, Set<string>> {
  const ancestors = new Map<string, Set<string>>();
  for (const [path, prompts] of aliases) {
    for (
      let directory = dirname(path);
      directory !== "." && dirname(directory) !== directory;
      directory = dirname(directory)
    ) {
      const key = normalizePackageWatchPath(directory);
      const set = ancestors.get(key) ?? new Set<string>();
      for (const prompt of prompts) set.add(prompt);
      ancestors.set(key, set);
    }
  }
  return ancestors;
}
