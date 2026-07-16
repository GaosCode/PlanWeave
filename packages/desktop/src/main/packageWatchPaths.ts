import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";

export type TaskCanvasWorkspace = Awaited<ReturnType<typeof resolveTaskCanvasWorkspace>>;

export type PackageWatchRoot = {
  rootPath: string;
  relativeRoot: string;
  coarsePath: string;
  preserveOverlaps?: boolean;
};

export function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

export function normalizePackageWatchPath(path: string): string {
  let normalized = toPosixPath(path).replace(/^\.\/+/, "");
  while (normalized.startsWith("//")) {
    normalized = normalized.slice(1);
  }
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === "/") {
    end -= 1;
  }
  return normalized.slice(0, end);
}

export function shouldNotifyPackagePath(path: string): boolean {
  return (
    path === "package/manifest.json" ||
    path === "policy/project-prompt.md" ||
    /^package\/nodes\/.+\.md$/.test(path)
  );
}

export function isDescendantPath(parentPath: string, childPath: string): boolean {
  const path = relative(resolve(parentPath), resolve(childPath));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

export function watchedRootsForWorkspace(workspace: TaskCanvasWorkspace): PackageWatchRoot[] {
  const roots: PackageWatchRoot[] = [
    {
      rootPath: workspace.packageDir,
      relativeRoot: "package",
      coarsePath: "package/manifest.json"
    },
    {
      rootPath: join(workspace.packageDir, "nodes"),
      relativeRoot: "package/nodes",
      coarsePath: "package/manifest.json"
    },
    {
      rootPath: dirname(workspace.projectPromptFile),
      relativeRoot: "policy",
      coarsePath: "policy/project-prompt.md",
      preserveOverlaps: true
    }
  ];
  return roots.filter(
    (root) =>
      root.preserveOverlaps ||
      !roots.some(
        (candidate) => candidate !== root && isDescendantPath(candidate.rootPath, root.rootPath)
      )
  );
}

export function normalizeWatchEventPath(
  relativeRoot: string,
  coarsePath: string,
  filename: string | Buffer | null
): string {
  if (!filename) {
    return coarsePath;
  }
  return normalizePackageWatchPath(join(relativeRoot, filename.toString()));
}

export function dedupePackageWatchPaths(paths: Iterable<string>): string[] {
  return [
    ...new Set([...paths].map(normalizePackageWatchPath).filter(shouldNotifyPackagePath))
  ].sort();
}

export function absolutePathForRelative(
  workspace: TaskCanvasWorkspace,
  relativePath: string
): string {
  if (relativePath === "package/manifest.json") {
    return workspace.manifestFile;
  }
  if (relativePath === "policy/project-prompt.md") {
    return workspace.projectPromptFile;
  }
  const withoutPrefix = relativePath.startsWith("package/")
    ? relativePath.slice("package/".length)
    : relativePath;
  return join(workspace.packageDir, withoutPrefix);
}
