import type { Command } from "commander";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
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
    const projectRoot = await resolveCliProjectRoot();
    const requestedCanvasId = resolveCliCanvasId(options);
    const activeCanvasId = await getActiveTaskCanvasId(projectRoot);
    const canvases = await listTaskCanvases(projectRoot);
    const selectedCanvasId =
      requestedCanvasId ?? activeCanvasId ?? canvases[0]?.canvasId ?? "default";
    const workspace = await resolveTaskCanvasWorkspace(projectRoot, selectedCanvasId);
    const files = await exportCanvasPackageFiles(workspace);
    await assertExportTarget(target, options.force === true);
    await replacePackageFiles(target, files);
    const result = {
      ok: true as const,
      target,
      canvasId: selectedCanvasId,
      fileCount: files.length
    };
    console.log(options.json ? JSON.stringify(result, null, 2) : formatExportHuman(result));
  });
}
