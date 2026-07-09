import type { Command } from "commander";
import { claimTask } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerClaimTaskCommand(program: Command): void {
  addCanvasOption(
    program
      .command("claim-task <taskId>")
      .description("Claim the next executable block inside a specific task")
  ).action(async (taskId: string, options: CanvasCommandOptions) => {
    const result = await claimTask({
      projectRoot: await resolveCliPackageWorkspace(options),
      taskId
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
