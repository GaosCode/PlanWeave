import type { Command } from "commander";
import { submitBlockResult } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerSubmitResultCommand(program: Command): void {
  addCanvasOption(
    program
      .command("submit-result")
      .argument("<block-ref>")
      .requiredOption("--report <path>", "implementation report markdown path")
      .option("--json", "print machine-readable output")
      .description("Record an implementation block run")
  ).action(async (ref: string, options: { report: string } & CanvasCommandOptions) => {
    const result = await submitBlockResult({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref,
      reportPath: options.report
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
