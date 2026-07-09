import type { Command } from "commander";
import { validatePackage } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";
import { formatValidationReport } from "../output.js";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerValidateCommand(program: Command): void {
  addCanvasOption(
    program
      .command("validate")
      .description("Validate the current project's Plan Package")
      .option("--json", "print machine-readable output")
  ).action(async (options: { json?: boolean } & CanvasCommandOptions) => {
    const explicitCanvasId = options.canvas?.trim();
    const projectRoot = explicitCanvasId
      ? await resolveCliPackageWorkspace({ canvas: explicitCanvasId })
      : await resolveCliProjectRoot();
    const report = await validatePackage({ projectRoot });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatValidationReport(report));
    if (!report.ok) {
      process.exitCode = 1;
    }
  });
}
