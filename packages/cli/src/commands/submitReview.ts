import type { Command } from "commander";
import { submitReviewResult } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerSubmitReviewCommand(program: Command): void {
  addCanvasOption(
    program
      .command("submit-review")
      .argument("<review-block-ref>")
      .requiredOption("--result <path>", "review-result.json path")
      .option("--json", "print machine-readable output")
      .description("Record a structured review result for a review block")
  ).action(async (ref: string, options: { result: string } & CanvasCommandOptions) => {
    const result = await submitReviewResult({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref,
      resultPath: options.result
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
