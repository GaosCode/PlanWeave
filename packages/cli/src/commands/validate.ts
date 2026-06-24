import type { Command } from "commander";
import { validatePackage } from "@planweave-ai/runtime";
import { formatValidationReport } from "../output.js";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("Validate the current project's Plan Package")
    .option("--json", "print machine-readable output")
    .action(async (options: { json?: boolean }) => {
      const report = await validatePackage({ projectRoot: await resolveCliProjectRoot() });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatValidationReport(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    });
}
