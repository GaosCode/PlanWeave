import type { Command } from "commander";
import { submitBlockResult } from "@planweave/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerSubmitResultCommand(program: Command): void {
  program
    .command("submit-result")
    .argument("<block-ref>")
    .requiredOption("--report <path>", "implementation report markdown path")
    .description("Record an implementation block run")
    .action(async (ref: string, options: { report: string }) => {
      const result = await submitBlockResult({
        projectRoot: resolveCliProjectRoot(),
        ref,
        reportPath: options.report
      });
      console.log(JSON.stringify(result, null, 2));
    });
}
