import type { Command } from "commander";
import { retryReview } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

function parseMaxFeedbackCycles(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--max-feedback-cycles must be a non-negative integer.");
  }
  return parsed;
}

export function registerRetryReviewCommand(program: Command): void {
  addCanvasOption(
    program
      .command("retry-review")
      .argument("<review-block-ref>")
      .requiredOption(
        "--max-feedback-cycles <count>",
        "set the exact review block max feedback cycles before retrying"
      )
      .description("Raise or reset an exhausted review block for another review attempt")
  ).action(async (ref: string, options: { maxFeedbackCycles: string } & CanvasCommandOptions) => {
    const result = await retryReview({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref,
      maxFeedbackCycles: parseMaxFeedbackCycles(options.maxFeedbackCycles)
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
