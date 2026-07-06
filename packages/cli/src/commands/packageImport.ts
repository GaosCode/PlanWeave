import type { Command } from "commander";
import { applyPackageDraftImport, previewPackageDraftImport } from "@planweave-ai/runtime";
import { addCanvasOption, type CanvasCommandOptions } from "../cliWorkspace.js";
import { resolveCliProjectRoot } from "../projectRoot.js";

type PackageImportOptions = {
  from?: string;
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
} & CanvasCommandOptions;

function requiredFrom(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error("--from is required.");
  }
  return value.trim();
}

function formatImportHuman(result: Awaited<ReturnType<typeof previewPackageDraftImport>> & { applied?: boolean }): string {
  return [
    `Package import: ${result.ok ? "ok" : "failed"}`,
    `mode: ${result.mode ?? "unknown"}`,
    `applied: ${result.applied === true ? "yes" : "no"}`,
    `target canvas: ${result.target.canvasId ?? "project"}`,
    `files: ${result.summary.fileCount}, added ${result.summary.added}, changed ${result.summary.changed}, removed ${result.summary.removed}, unchanged ${result.summary.unchanged}`,
    `validation errors: ${result.validation.summary.errorCount}, warnings: ${result.validation.summary.warningCount}`
  ].join("\n");
}

export function registerPackageImportCommand(program: Command): void {
  const packageCommand = program.command("package").description("Import PlanWeave package drafts");

  addCanvasOption(packageCommand
    .command("import")
    .description("Preview or apply a package draft import transaction")
    .requiredOption("--from <draftRoot>", "draft package root")
    .option("--dry-run", "preview import without writing files")
    .option("--apply", "apply import transaction")
    .option("--json", "print machine-readable output"))
    .action(async (options: PackageImportOptions) => {
      if (options.apply && options.dryRun) {
        throw new Error("--apply cannot be combined with --dry-run.");
      }
      const input = {
        draftRoot: requiredFrom(options.from),
        projectRoot: await resolveCliProjectRoot(),
        canvasId: options.canvas
      };
      const result = options.apply ? await applyPackageDraftImport(input) : await previewPackageDraftImport(input);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatImportHuman(result));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
}
