import type { Command } from "commander";
import { validatePackage } from "@planweave-ai/runtime";
import { addCanvasOption, type CanvasCommandOptions } from "../cliWorkspace.js";
import { formatValidationReport } from "../output.js";
import { resolveCliValidationProjectRoot } from "../projectRoot.js";

export function registerValidateCommand(program: Command): void {
  addCanvasOption(
    program
      .command("validate")
      .description("Validate the current project's Plan Package")
      .option("--json", "print machine-readable output")
  ).action(async (options: { json?: boolean } & CanvasCommandOptions) => {
    const report = await validatePackage({
      projectRoot: await resolveCliValidationProjectRoot(),
      canvasId: options.canvas?.trim() || undefined
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatValidationReport(report));
    if (!report.ok) {
      process.exitCode = 1;
    }
  });
}
