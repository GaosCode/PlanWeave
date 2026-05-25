import type { Command } from "commander";
import { claimTask } from "@planweave/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerClaimTaskCommand(program: Command): void {
  program
    .command("claim-task <taskId>")
    .description("Claim the next executable block inside a specific task")
    .action(async (taskId: string) => {
      const result = await claimTask({ projectRoot: resolveCliProjectRoot(), taskId });
      console.log(JSON.stringify(result, null, 2));
    });
}
