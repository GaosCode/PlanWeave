import type { Command } from "commander";
import { submitFeedback } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerSubmitFeedbackCommand(program: Command): void {
  addCanvasOption(
    program
      .command("submit-feedback")
      .requiredOption("--report <path>", "feedback handling report markdown path")
      .option("--json", "print machine-readable output")
      .description("Submit the active feedback handling report")
  ).action(async (options: { report: string } & CanvasCommandOptions) => {
    const result = await submitFeedback({
      projectRoot: await resolveCliPackageWorkspace(options),
      reportPath: options.report
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
