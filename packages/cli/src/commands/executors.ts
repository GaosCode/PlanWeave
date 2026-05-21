import type { Command } from "commander";
import { listExecutorProfiles, testExecutorProfile } from "@planweave/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerExecutorsCommand(program: Command): void {
  const executors = program.command("executors").description("Inspect PlanWeave executor profiles");

  executors
    .command("list")
    .description("List available executor profiles")
    .option("--json", "print JSON output")
    .action(async (options: { json?: boolean }) => {
      const result = await listExecutorProfiles({ projectRoot: resolveCliProjectRoot() });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const profile of result) {
        console.log(`${profile.name}\t${profile.adapter}\t${profile.source}`);
      }
    });

  executors
    .command("test")
    .argument("<executor>")
    .description("Test whether an executor profile is available")
    .option("--json", "print JSON output")
    .action(async (executor: string, options: { json?: boolean }) => {
      const result = await testExecutorProfile({ projectRoot: resolveCliProjectRoot(), executorName: executor });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`${result.ok ? "ok" : "failed"} ${result.name}: ${result.message}`);
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
}
