import type { Command } from "commander";
import { validatePackageDraft } from "@planweave-ai/runtime";

type PackageDraftOptions = {
  draftRoot?: string;
  json?: boolean;
};

function requiredDraftRoot(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error("--draft-root is required.");
  }
  return value.trim();
}

function formatDraftValidationHuman(result: Awaited<ReturnType<typeof validatePackageDraft>>): string {
  const lines = [
    `Package draft: ${result.ok ? "ok" : "failed"}`,
    `mode: ${result.mode ?? "unknown"}`,
    `schema errors: ${result.validation.summary.errorCount}, warnings: ${result.validation.summary.warningCount}`
  ];
  for (const canvas of result.canvases) {
    lines.push(
      `canvas ${canvas.canvasId ?? "single"}: files ${canvas.fileCount}, validation errors ${canvas.validation.summary.errorCount}, quality errors ${canvas.graphQuality?.summary.errorCount ?? 0}`
    );
  }
  return lines.join("\n");
}

export function registerPackageDraftCommand(program: Command): void {
  const draft = program.command("package-draft").description("Validate PlanWeave package draft directories");

  draft
    .command("validate")
    .description("Validate a package-shaped draft root without writing files")
    .requiredOption("--draft-root <path>", "draft package root")
    .option("--json", "print machine-readable output")
    .action(async (options: PackageDraftOptions) => {
      const result = await validatePackageDraft({ draftRoot: requiredDraftRoot(options.draftRoot) });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatDraftValidationHuman(result));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  draft
    .command("quality")
    .description("Run graph quality checks for a package-shaped draft root")
    .requiredOption("--draft-root <path>", "draft package root")
    .option("--json", "print machine-readable output")
    .action(async (options: PackageDraftOptions) => {
      const result = await validatePackageDraft({ draftRoot: requiredDraftRoot(options.draftRoot) });
      const quality = {
        ok: result.ok,
        draftRoot: result.draftRoot,
        mode: result.mode,
        canvases: result.canvases.map((canvas) => ({
          canvasId: canvas.canvasId,
          graphQuality: canvas.graphQuality
        })),
        validation: result.validation
      };
      console.log(options.json ? JSON.stringify(quality, null, 2) : formatDraftValidationHuman(result));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
}
