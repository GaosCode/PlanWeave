import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";
import { isNodeFileNotFoundError, optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import type { FileFingerprint, PlanPackageManifest, ValidationIssue } from "../types.js";
import { toPackagePosixPath } from "./packagePosixPath.js";
import {
  createPackagePathTargetResolver,
  packagePathLinkLocations,
  PackagePathError
} from "./resolvePackagePath.js";

export type PromptOwner = {
  taskId: string;
  ref: string;
  kind: "task" | "block";
  prompt: string;
};

export type PackagePromptTargets = {
  root: string;
  paths: ReadonlyMap<string, string>;
  diagnostics: ValidationIssue[];
  failures: ReadonlyMap<string, PromptReadFailure>;
  linkLocations: ReadonlyMap<string, string[]>;
};

export function promptReferenceKey(prompt: string): string {
  const normalized = normalize(prompt);
  return normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

export function packagePromptOwners(manifest: PlanPackageManifest): Map<string, PromptOwner[]> {
  const owners = new Map<string, PromptOwner[]>();
  const add = (prompt: string, owner: PromptOwner) => {
    const path = toPackagePosixPath(promptReferenceKey(prompt));
    const existing = owners.get(path);
    if (existing) existing.push(owner);
    else owners.set(path, [owner]);
  };
  for (const task of manifest.nodes) {
    add(task.prompt, { taskId: task.id, ref: task.id, kind: "task", prompt: task.prompt });
    for (const block of task.blocks) {
      add(block.prompt, {
        taskId: task.id,
        ref: `${task.id}#${block.id}`,
        kind: "block",
        prompt: block.prompt
      });
    }
  }
  return owners;
}

export function normalizePackageWatchPath(path: string): string {
  return toPackagePosixPath(path)
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

export function isPackageNodesPath(path: string): boolean {
  return path === "nodes" || path.startsWith("nodes/");
}

export function isOrphanPromptWatchPath(path: string): boolean {
  return isPackageNodesPath(path) && path.endsWith(".md");
}

export type PromptReadFailure =
  | { kind: "missing"; path: string }
  | { kind: "read_error"; path: string; error: Error };

function promptReadError(path: string, error: unknown): PromptReadFailure {
  return {
    kind: "read_error",
    path,
    error: error instanceof Error ? error : new Error(String(error))
  };
}

function accessIssue(path: string, error: unknown, reading = false): ValidationIssue {
  if (error instanceof PackagePathError) {
    return { code: error.code, message: error.message, path };
  }
  const reason = error instanceof Error && "code" in error ? error.code : String(error);
  return {
    code: reading ? "prompt_read_failed" : "prompt_access_failed",
    message: reading
      ? `Prompt '${path}' could not be read: ${reason}.`
      : `Prompt file '${path}' could not be checked: ${reason}.`,
    path
  };
}

async function collectOrphanCandidates(
  packageDir: string,
  directory: string,
  candidates: Set<string>,
  diagnostics: ValidationIssue[]
): Promise<void> {
  const path = join(packageDir, directory);
  try {
    if ((await lstat(path)).isSymbolicLink()) return;
    for (const entry of (await optionalReaddir(path, { withFileTypes: true })) ?? []) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory())
        await collectOrphanCandidates(packageDir, child, candidates, diagnostics);
      else if (entry.isFile() && isOrphanPromptWatchPath(child)) candidates.add(child);
    }
  } catch (error) {
    if (isNodeFileNotFoundError(error)) return;
    const issue = accessIssue(directory, error, true);
    diagnostics.push({ ...issue, code: "prompt_directory_read_failed" });
  }
}

export async function resolvePackagePromptTargets(
  packageDir: string,
  referencePaths: Iterable<string>,
  options: {
    includeOrphans?: boolean;
    manifestPaths?: ReadonlyMap<string, string>;
    resolveWatchLinks?: boolean;
  } = {}
): Promise<PackagePromptTargets> {
  let root = packageDir;
  try {
    root = await realpath(packageDir);
  } catch (error) {
    if (!isNodeFileNotFoundError(error)) throw error;
  }
  const resolveTarget = createPackagePathTargetResolver(packageDir, root);
  const paths = new Map<string, string>();
  const diagnostics: ValidationIssue[] = [];
  const failures = new Map<string, PromptReadFailure>();
  const linkLocations = new Map<string, string[]>();
  const candidates = new Set(referencePaths);
  if (options.includeOrphans) await collectOrphanCandidates(root, "nodes", candidates, diagnostics);
  for (const path of candidates) {
    const original = options.manifestPaths?.get(path) ?? path;
    try {
      const target = await resolveTarget(original);
      paths.set(path, target);
      if (options.resolveWatchLinks && join(root, original) !== target) {
        linkLocations.set(path, await packagePathLinkLocations(root, original));
      }
    } catch (error) {
      if (options.resolveWatchLinks && !linkLocations.has(path)) {
        try {
          linkLocations.set(path, await packagePathLinkLocations(root, original));
        } catch (linkError) {
          if (!(linkError instanceof PackagePathError)) {
            diagnostics.push(accessIssue(path, linkError));
          }
        }
      }
      const issue = accessIssue(path, error);
      if (issue.code === "package_path_outside") {
        issue.path = options.manifestPaths?.get(path) ?? path;
      }
      diagnostics.push(issue);
      failures.set(path, promptReadError(path, error));
    }
  }
  return { root, paths, diagnostics, failures, linkLocations };
}

export function originalPromptPaths(
  owners: ReadonlyMap<string, PromptOwner[]>
): Map<string, string> {
  return new Map([...owners].map(([path, references]) => [path, references[0].prompt]));
}

export function promptTargetPaths(
  targets: Pick<PackagePromptTargets, "paths">
): Map<string, string[]> {
  const pathsByTarget = new Map<string, string[]>();
  for (const [path, target] of targets.paths) {
    const paths = pathsByTarget.get(target);
    if (paths) paths.push(path);
    else pathsByTarget.set(target, [path]);
  }
  return pathsByTarget;
}

export function promptWatchAliases(targets: PackagePromptTargets): Map<string, string[]> {
  const aliases = new Map<string, Set<string>>();
  const add = (path: string, logicalPath: string) => {
    const values = aliases.get(path);
    if (values) values.add(logicalPath);
    else aliases.set(path, new Set([logicalPath]));
  };
  for (const [path, target] of targets.paths) {
    add(path, path);
    add(toPackagePosixPath(relative(targets.root, target)), path);
  }
  for (const path of targets.failures.keys()) add(path, path);
  for (const [path, links] of targets.linkLocations) {
    for (const link of links) add(toPackagePosixPath(relative(targets.root, link)), path);
  }
  return new Map([...aliases].map(([path, paths]) => [path, [...paths]]));
}

export async function capturePackagePrompts(
  targets: PackagePromptTargets,
  mode: "content" | "stat",
  referencedPaths: ReadonlyMap<string, PromptOwner[]>,
  options: { includeOrphanFingerprints?: boolean } = {}
): Promise<{
  fingerprints: Record<string, FileFingerprint>;
  markdown: ReadonlyMap<string, string>;
  failures: ReadonlyMap<string, PromptReadFailure>;
  diagnostics: ValidationIssue[];
}> {
  const fingerprints = new Map<string, FileFingerprint>();
  const markdown = new Map<string, string>();
  const diagnostics = [...targets.diagnostics];
  const failures = new Map(targets.failures);
  for (const [target, paths] of promptTargetPaths(targets)) {
    const references = paths.filter((path) => referencedPaths.has(path));
    if (references.length === 0 && !options.includeOrphanFingerprints) continue;
    let metadata: Stats | null;
    try {
      metadata = await optionalStat(target);
    } catch (error) {
      if (references.length === 0) throw error;
      diagnostics.push(...references.map((path) => accessIssue(path, error)));
      for (const path of references) failures.set(path, promptReadError(path, error));
      continue;
    }
    if (!metadata?.isFile()) {
      for (const path of references) {
        const diagnostic = {
          code: metadata ? "prompt_not_file" : "prompt_missing",
          message: metadata
            ? `Prompt file '${path}' is not a regular file.`
            : `Prompt file '${path}' does not exist.`,
          path
        };
        diagnostics.push(diagnostic);
        failures.set(
          path,
          metadata
            ? promptReadError(path, new Error(diagnostic.message))
            : { kind: "missing", path }
        );
      }
      continue;
    }
    try {
      const bytes = mode === "content" ? await readFile(target) : null;
      const hash = bytes
        ? createHash("sha256").update(bytes).digest("hex")
        : `stat:${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}`;
      if (bytes) {
        const content = bytes.toString("utf8");
        for (const path of references) markdown.set(path, content);
      }
      const fingerprint = { path: target, hash, mtimeMs: metadata.mtimeMs };
      for (const path of paths) fingerprints.set(path, fingerprint);
    } catch (error) {
      if (references.length === 0) throw error;
      diagnostics.push(...references.map((path) => accessIssue(path, error, true)));
      for (const path of references) {
        failures.set(
          path,
          isNodeFileNotFoundError(error) ? { kind: "missing", path } : promptReadError(path, error)
        );
      }
    }
  }
  return { fingerprints: Object.fromEntries(fingerprints), markdown, diagnostics, failures };
}
