import type { Command } from "commander";
import { listExecutorProfiles, testExecutorProfile } from "@planweave-ai/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";
import {
  formatExecutorProfilesHuman,
  formatExecutorTestHuman,
  formatExecutorTestJson
} from "./formatters/executorFormatters.js";

export function registerExecutorsCommand(program: Command): void {
  const executors = program.command("executors").description("Inspect PlanWeave executor profiles");

  executors
    .command("list")
    .description("List available executor profiles")
    .option("--json", "print JSON output")
    .action(async (options: { json?: boolean }) => {
      const result = await listExecutorProfiles({ projectRoot: await resolveCliProjectRoot() });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const output = formatExecutorProfilesHuman(result);
      if (output) {
        console.log(output);
      }
    });

  executors
    .command("test")
    .argument("<executor>")
    .description("Test whether an executor profile is available")
    .option("--json", "print JSON output")
    .action(async (executor: string, options: { json?: boolean }) => {
      const result = await testExecutorProfile({
        projectRoot: await resolveCliProjectRoot(),
        executorName: executor
      });
      if (options.json) {
        console.log(formatExecutorTestJson(result));
        return;
      }
      console.log(formatExecutorTestHuman(result));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
}
