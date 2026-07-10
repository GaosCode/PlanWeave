import type { Command } from "commander";
import { constants } from "node:fs";
import { access, realpath, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  exportCanvasPackageFiles,
  getActiveTaskCanvasId,
  listTaskCanvases,
  replacePackageFiles,
  resolveTaskCanvasWorkspace
} from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliCanvasId, type CanvasCommandOptions } from "../cliWorkspace.js";
import { resolveCliProjectRoot } from "../projectRoot.js";

type PackageExportOptions = {
  target?: string;
  force?: boolean;
  json?: boolean;
} & CanvasCommandOptions;

type ExportTargetProtection = {
  label: string;
  path: string;
  mode: "ancestor_only" | "overlap";
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function canonicalPathFrom(current: string, missingSegments: string[]): Promise<string> {
  try {
    return resolve(await realpath(current), ...missingSegments);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw error;
    }
    return canonicalPathFrom(parent, [basename(current), ...missingSegments]);
  }
}

function canonicalPath(path: string): Promise<string> {
  return canonicalPathFrom(resolve(path), []);
}

function isSamePathOrAncestor(ancestor: string, descendant: string): boolean {
  const relativeRoot = relative(ancestor, descendant);
  return (
    relativeRoot === "" ||
    (!isAbsolute(relativeRoot) && relativeRoot !== ".." && !relativeRoot.startsWith(`..${sep}`))
  );
}

function targetViolatesProtection(
  canonicalTarget: string,
  protection: ExportTargetProtection & { canonicalPath: string }
): boolean {
  if (isSamePathOrAncestor(canonicalTarget, protection.canonicalPath)) {
    return true;
  }
  return (
    protection.mode === "overlap" && isSamePathOrAncestor(protection.canonicalPath, canonicalTarget)
  );
}

async function assertSafeExportTarget(
  target: string,
  protections: ExportTargetProtection[]
): Promise<void> {
  const canonicalTarget = await canonicalPath(target);
  const canonicalProtections = await Promise.all(
    protections.map(async (protection) => ({
      ...protection,
      canonicalPath: await canonicalPath(protection.path)
    }))
  );
  const matchedProtection = canonicalProtections.find((protection) =>
    targetViolatesProtection(canonicalTarget, protection)
  );
  if (!matchedProtection) {
    return;
  }
  if (matchedProtection.mode === "overlap") {
    throw new Error(
      `Export target '${target}' must not overlap the protected ${matchedProtection.label} ('${matchedProtection.path}'). Choose a dedicated export directory.`
    );
  }
  throw new Error(
    `Export target '${target}' must not be the ${matchedProtection.label} or an ancestor of it ('${matchedProtection.path}'). Choose a dedicated export directory.`
  );
}

async function assertExportTarget(target: string, force: boolean): Promise<void> {
  if (!(await pathExists(target))) {
    return;
  }
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOTDIR") {
      throw new Error(`Export target '${target}' exists and is not a directory.`);
    }
    throw error;
  }
  if (entries.length > 0 && !force) {
    throw new Error(`Export target '${target}' is not empty. Pass --force to overwrite.`);
  }
}

function requiredTarget(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error("--target is required.");
  }
  return value.trim();
}

function formatExportHuman(result: {
  target: string;
  canvasId: string;
  fileCount: number;
}): string {
  return [
    `Package export: ok`,
    `canvas: ${result.canvasId}`,
    `target: ${result.target}`,
    `files: ${result.fileCount}`
  ].join("\n");
}

export function registerPackageExportSubcommand(packageCommand: Command): void {
  addCanvasOption(
    packageCommand
      .command("export")
      .description("Export a canvas Plan Package to a directory")
      .requiredOption("--target <dir>", "destination directory for the exported package files")
      .option("--force", "overwrite a non-empty target directory")
      .option("--json", "print machine-readable output")
  ).action(async (options: PackageExportOptions) => {
    const target = requiredTarget(options.target);
    const resolvedTarget = resolve(target);
    const projectRoot = await resolveCliProjectRoot();
    const requestedCanvasId = resolveCliCanvasId(options);
    const activeCanvasId = await getActiveTaskCanvasId(projectRoot);
    const canvases = await listTaskCanvases(projectRoot);
    const selectedCanvasId =
      requestedCanvasId ?? activeCanvasId ?? canvases[0]?.canvasId ?? "default";
    const workspace = await resolveTaskCanvasWorkspace(projectRoot, selectedCanvasId);
    const protections: ExportTargetProtection[] = [
      { label: "project root", path: workspace.rootPath, mode: "ancestor_only" },
      {
        label: "PlanWeave project workspace root",
        path: dirname(workspace.projectFile),
        mode: "ancestor_only"
      },
      {
        label: "task canvas workspace root",
        path: workspace.workspaceRoot,
        mode: "ancestor_only"
      },
      { label: "package directory", path: workspace.packageDir, mode: "overlap" },
      { label: "results directory", path: workspace.resultsDir, mode: "overlap" }
    ];
    if (workspace.sourceRoot && workspace.sourceRoot !== workspace.rootPath) {
      protections.push({
        label: "project source root",
        path: workspace.sourceRoot,
        mode: "ancestor_only"
      });
    }
    await assertSafeExportTarget(resolvedTarget, protections);
    const files = await exportCanvasPackageFiles(workspace);
    await assertExportTarget(resolvedTarget, options.force === true);
    await replacePackageFiles(resolvedTarget, files);
    const result = {
      ok: true as const,
      target,
      canvasId: selectedCanvasId,
      fileCount: files.length
    };
    console.log(options.json ? JSON.stringify(result, null, 2) : formatExportHuman(result));
  });
}
